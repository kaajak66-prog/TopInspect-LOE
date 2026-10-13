"""检测结果 → 报告 facts（真值）+ AI 文字分析。指标绝不交给 AI 计算。

自监督异常检测只能判定「某条流是否异常」，无法识别具体攻击类型，
因此报告 facts 不含攻击类型，也不使用数据集中的 Attack 标注列。
"""
import json
import os
import re

import httpx
import numpy as np

from server import config


def build_facts(bundle, metrics, top_k=8):
    """从 JobManager raw bundle 与 build_metrics 结果组装报告 facts（全真值）。"""
    result = bundle["result"]
    preds = np.asarray(result["preds"]).astype(int)
    node_list = result["node_list"]
    src_idx = np.asarray(result["src_idx"])
    dst_idx = np.asarray(result["dst_idx"])
    total = int(bundle["total_rows"])
    anomaly = int(preds.sum())
    has_label = bundle["labels"] is not None

    # —— top 异常 IP：每个节点累计异常流数，取 top_k ——
    node_anom = np.zeros(len(node_list), dtype=int)
    for i in np.where(preds == 1)[0]:
        for nid in (int(src_idx[i]), int(dst_idx[i])):
            node_anom[nid] += 1
    order = np.argsort(node_anom)[::-1][:top_k]
    top_anomaly_ips = [
        {"ip": node_list[nid], "anomaly_count": int(node_anom[nid])}
        for nid in order if node_anom[nid] > 0
    ]

    return {
        "total_flows": total,
        "anomaly_count": anomaly,
        "anomaly_rate": round(anomaly / total, 4) if total else 0.0,
        # 注：不向 AI 传递模型内部阈值——它是实现参数，不应出现在分析报告中。
        "latency_ms": metrics["latencyMs"],
        "has_label": has_label,
        "accuracy": metrics["accuracy"],
        "f1": metrics["f1"],
        "precision": metrics["precision"],
        "recall": metrics["recall"],
        "fpr": metrics["fpr"],
        "confusion": metrics["confusion"],
        "pr_curve": metrics.get("prCurve"),
        "top_anomaly_ips": top_anomaly_ips,
    }


_PROMPT_SYS = (
    "你是一名资深网络安全分析师，正在为一次网络入侵检测撰写正式分析报告。"
    "下面的 JSON 给出本次检测的真实统计指标（已由系统计算完成，"
    "你必须直接引用这些数字，严禁重新计算、估算或编造任何数值）。\n"
    "重要限制：本系统采用自监督图神经网络，只能判定流量是否异常，无法识别具体攻击类型。"
    "报告中不得声称识别出某种攻击类型（如 DDoS、扫描、利用等），"
    "只能基于异常规模、异常源 IP 与流量统计特征做客观研判。\n"
    "请用简体中文撰写一份专业、详尽、可落地的分析报告，严格输出如下 JSON 结构：\n"
    '{\n'
    '  "executive_summary": "执行摘要：3-5 句，面向管理层，概述本次检测规模、'
    '整体安全态势、最严重的威胁与核心结论。",\n'
    '  "threat_assessment": "威胁研判：5-8 句。详细分析检出的异常流量特征'
    '（规模、聚集程度、时间分布）、重点异常源 IP 的行为模式、'
    '异常在网络拓扑中的传播态势。",\n'
    '  "model_evaluation": "模型评估：4-6 句。结合准确率、F1、召回率、误报率(FPR)、'
    '混淆矩阵(TP/FP/TN/FN)，客观评价模型本次检测的可靠性、'
    '漏报与误报风险，并指出在何种场景下结论需要人工复核。",\n'
    '  "recommendations": "处置建议：分条目（用 1. 2. 3. … 编号，至少 5 条）。'
    '针对本次具体的异常源 IP 与异常流量特征，给出可立即执行的处置动作，'
    '包括但不限于：网络隔离/封禁、访问控制策略调整、日志与流量取证、'
    '补丁与加固、告警与误报策略优化、后续监控重点。每条都要具体、可操作。",\n'
    '  "conclusion": "总体结论：3-4 句，总结风险等级与下一步行动优先级。"\n'
    '}\n'
    "要求：语言专业严谨，避免空话套话，所有判断都要有指标支撑；"
    "不得声称识别出具体攻击类型；"
    "处置建议必须结合本次数据中真实出现的异常源 IP，不要泛泛而谈。"
)


# 报告分段的键顺序（前端按此渲染）
_SECTION_KEYS = (
    "executive_summary", "threat_assessment", "model_evaluation",
    "recommendations", "conclusion",
)

# 攻击类型术语 → 中性替换：自监督检测只判异常、不识别攻击类型，
# 即使 AI 在文字上越界，输出前也会被替换为中性异常描述。
_ATK_PATTERNS = (
    (re.compile(r"分布式拒绝服务|拒绝服务攻击|洪泛|洪水攻击|CC攻击|慢速攻击|\bddos\b|\bdos\b", re.IGNORECASE), "异常流量冲击"),
    (re.compile(r"端口扫描|扫描探测|横向扫描|主动探测|漏洞扫描|服务扫描|主机扫描|端口探测|服务探测"), "异常探测行为"),
    (re.compile(r"安全扫描|例行扫描|周期扫描|全网扫描|全面扫描|深度扫描"), "安全排查"),
    (re.compile(r"暴力破解|撞库|口令爆破|密码爆破|爆破|弱口令|口令猜测"), "异常访问行为"),
    (re.compile(r"SQL注入|命令注入|代码注入|注入攻击|XSS|跨站脚本|跨站请求伪造|CSRF"), "异常访问行为"),
    (re.compile(r"木马|勒索|挖矿|蠕虫|webshell|后门|僵尸网络|钓鱼|中间人|缓冲区溢出|提权|漏洞利用|漏洞攻击|APT|远控|恶意软件|恶意程序|恶意代码"), "异常行为"),
    (re.compile(r"数据外传|数据窃取|数据偷窃|数据泄露|信息窃取|数据滥用"), "异常数据传输"),
    (re.compile(r"横向移动|横向渗透|横向扩散|内网渗透|横向攻击"), "异常扩散"),
    (re.compile(r"攻击源|攻击来源"), "异常源"),
    (re.compile(r"攻击者|恶意主机|攻击主机|威胁主体"), "可疑源"),
    (re.compile(r"攻击类型|攻击手法|具体攻击|发起攻击|受到攻击|遭到攻击|属于\S{1,8}攻击|攻击行为|攻击活动|攻击特征|攻击模式"), "异常行为"),
    (re.compile(r"该攻击|此攻击|本次攻击|此次攻击|此类攻击|这类攻击"), "该异常"),
    (re.compile(r"扫描|探测|注入|跨站|嗅探"), "异常行为"),
    (re.compile(r"攻击"), "异常"),
)

# 替换叠加去重：AI 文案可能连续写出两个攻击词，经上表替换后出现
# "异常异常行为行为"式重复，这里统一收敛为单个中性表述。
_EDGE_FIX = (
    (re.compile(r"异常探测行为(?:行为)*"), "异常探测行为"),
    (re.compile(r"异常访问行为(?:行为)*"), "异常访问行为"),
    (re.compile(r"异常流量冲击(?:行为)*"), "异常流量冲击"),
    (re.compile(r"异常数据传输(?:行为)*"), "异常数据传输"),
    (re.compile(r"异常行为(?:行为)*"), "异常行为"),
    (re.compile(r"(?:异常)+"), "异常"),
    (re.compile(r"行为{2,}"), "行为"),
)


def _scrub_attack_types(text):
    """把 AI 文案中的具体攻击类型说法替换为中性表述。"""
    if not text:
        return text
    for pat, repl in _ATK_PATTERNS:
        text = pat.sub(repl, text)
    for pat, repl in _EDGE_FIX:
        text = pat.sub(repl, text)
    return text


def _degraded(facts):
    rate = facts.get("anomaly_rate", 0) * 100
    total = facts.get("total_flows", 0)
    anomaly = facts.get("anomaly_count", 0)
    ips = facts.get("top_anomaly_ips", []) or []
    ip_txt = "、".join(f"{i['ip']}（{i['anomaly_count']} 次异常）" for i in ips[:3]) or "无突出异常源"
    acc = facts.get("accuracy")
    acc_txt = f"{acc*100:.1f}%" if acc is not None else "无标签数据"
    msg = "（注：AI 分析服务未配置或暂不可用，以下为基于真实检测数据自动生成的摘要。）"
    return {
        "available": False,
        "executive_summary": (
            f"{msg}本次共分析网络流量 {total} 条，检出异常 {anomaly} 条，"
            f"异常率 {rate:.2f}%。异常流量高度聚集于若干源 IP，"
            f"重点关注：{ip_txt}。"),
        "threat_assessment": (
            "异常流量在分布上呈现明显聚集，并非均匀散布，"
            f"其中源 IP {ip_txt} 的异常行为最为突出，建议优先排查。"
            "异常在网络拓扑中呈聚集分布，提示异常活动可能集中于特定区域或主机，"
            "建议结合拓扑位置对相关节点重点排查。"),
        "model_evaluation": (
            f"本次检测准确率 {acc_txt}。"
            "请结合混淆矩阵中的误报(FP)与漏报(FN)情况判断结论可靠性，"
            "对判定接近边界的样本建议人工复核。"),
        "recommendations": (
            "1. 立即隔离或封禁上述高风险异常源 IP，阻断其与内网的连接。\n"
            "2. 对异常源 IP 关联主机开展针对性排查，检查相关主机是否已被入侵。\n"
            "3. 留存相关流量与日志用于取证，必要时上报安全团队。\n"
            "4. 复核告警与误报策略，降低误报对运营的干扰。\n"
            "5. 对高风险主机加强后续监控，关注是否出现二次攻击。"),
        "conclusion": (
            "本次检测已完成并识别出明确的异常活动，请结合上方真实指标与图表，"
            "按建议的优先级尽快处置高风险目标。"),
    }


def generate_ai_sections(facts):
    """调 DeepSeek 写三段文字。无 key / 超时 / 异常 / 解析失败 → 降级，不抛错。"""
    api_key = os.environ.get("DEEPSEEK_API_KEY")
    if not api_key:
        return {k: _scrub_attack_types(v) for k, v in _degraded(facts).items()}
    payload = {
        "model": config.DEEPSEEK_MODEL,
        "messages": [
            {"role": "system", "content": _PROMPT_SYS},
            {"role": "user", "content": json.dumps(facts, ensure_ascii=False)},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.4,
        "max_tokens": 2000,
    }
    try:
        with httpx.Client(timeout=config.DEEPSEEK_TIMEOUT) as client:
            r = client.post(
                config.DEEPSEEK_BASE_URL.rstrip("/") + "/chat/completions",
                headers={"Authorization": f"Bearer {api_key}"},
                json=payload,
            )
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"]
            data = json.loads(content)
        fallback = _degraded(facts)
        out = {"available": True}
        for k in _SECTION_KEYS:
            out[k] = _scrub_attack_types(str(data.get(k, "")).strip() or fallback[k])
        return out
    except Exception:
        return {k: _scrub_attack_types(v) for k, v in _degraded(facts).items()}

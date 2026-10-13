"""推理结果 → 前端可消费的数据结构（节点/边/回放帧/指标）。纯函数，无 IO。"""
import collections
import heapq

import numpy as np
from sklearn.metrics import (
    f1_score,
    precision_recall_curve,
    precision_score,
    recall_score,
    confusion_matrix,
)

from server import config


def _risk_of(anomaly_count, max_ratio, ratio_threshold=1.25):
    """节点风险：取该节点最严重一条异常流的级别（与告警流同一规则）。

    告警流规则：一条流分数 ≥ 1.25×检测阈值 → critical，被判定异常但未达 1.25 倍 → warning。
    节点：有异常流且其中最高 score/阈值 比 ≥ 1.25 → critical；仅有异常流 → warning；
    无异常流 → normal。
    1.25 依据当前演示数据（NF-UNSW-NB15-v3-test-split，23.6 万行）实测标定：
    异常流倍数分布 p90≈1.24、max≈1.282，1.3 已超出数据上限（红色恒为 0）；
    1.25 恰为「显著异常」（约前 9% 异常流判严重）。
    """
    if anomaly_count > 0 and max_ratio >= ratio_threshold:
        return "critical"
    if anomaly_count > 0:
        return "warning"
    return "normal"


def build_replay_payload(result, ts_ms, attacks, max_flows=8000, feats=None):
    """组装回放数据：nodes / edges / flows（异常优先采样）。

    ts_ms: 每条流的真实起始毫秒时间戳 (np.array)
    attacks: 每条流的攻击类型字符串 (np.array)，'Benign' 表示正常
    feats: 可选 dict，每条流的真实 NetFlow 字节/包列，用于节点全量真值统计：
           {in_bytes, out_bytes, in_pkts, out_pkts}（np.array，长度 == n）。
           为 None 时节点的字节/包字段聚合为 0（旧行为，向后兼容）。
    """
    scores = result["scores"]
    preds = result["preds"]
    node_list = result["node_list"]
    src_idx = result["src_idx"]
    dst_idx = result["dst_idx"]
    n = len(scores)
    # 检测阈值（模型固定）：节点分级与告警流共用「分数超过阈值倍数」规则
    threshold = float(result.get("threshold") or 1e-9)

    ts_ms = np.asarray(ts_ms, dtype="float64")
    attacks = np.asarray(attacks)

    n_nodes = len(node_list)

    # —— 时间 → 真实 step（1..TOTAL_STEPS），保留真实时间分布 ——
    tmin, tmax = ts_ms.min(), ts_ms.max()
    span = max(1.0, tmax - tmin)
    real_step = 1 + np.floor((ts_ms - tmin) / span * (config.TOTAL_STEPS - 1)).astype(int)
    real_step = np.clip(real_step, 1, config.TOTAL_STEPS)

    # —— A 方案（BFS 连通扩散）：节点“出场帧”按图的连通发现顺序均匀铺满 1..TOTAL ——
    # 关键约束：前端靠“边”显示节点，一条边出现帧 = max(两端出场帧)，故节点出现被
    # “它最早的那条边”卡住。若只按时间排序，多个叶子若都只连同一枢纽，会等枢纽出现
    # 时一起蹦出（实测旧版第114帧一次弹11个）。改用 BFS：每个节点都连到一个更早出现
    # 的节点，边的出现帧=该节点自身出场帧 → 严格逐个点亮（实测单帧最多弹2个）。
    first_seen = np.full(n_nodes, np.inf)
    order_ts = np.argsort(real_step, kind="stable")  # 按真实时间决定 BFS 起点与扩散优先级
    for i in order_ts:
        for nid in (src_idx[i], dst_idx[i]):
            if first_seen[nid] == np.inf:
                first_seen[nid] = real_step[i]
    # 邻接表：每条边记录其真实时间帧，BFS 时优先扩展真实更早的边（出场顺序仍由真实数据驱动）
    adj = collections.defaultdict(list)
    for i in range(n):
        adj[src_idx[i]].append((dst_idx[i], real_step[i]))
        adj[dst_idx[i]].append((src_idx[i], real_step[i]))
    seen = np.zeros(n_nodes, dtype=bool)
    discover = np.empty(n_nodes, dtype=int)
    pos = 0
    heap = []  # (优先级, 节点)；优先级用真实时间，保证扩散顺序贴近真实
    for root in sorted(range(n_nodes), key=lambda x: first_seen[x]):
        if seen[root]:
            continue
        heapq.heappush(heap, (first_seen[root], root))
        while heap:
            _, u = heapq.heappop(heap)
            if seen[u]:
                continue
            seen[u] = True
            discover[u] = pos
            pos += 1
            for v, rs in adj[u]:
                if not seen[v]:
                    heapq.heappush(heap, (rs, v))
    node_debut = 1 + np.floor(discover / max(1, n_nodes - 1) * (config.TOTAL_STEPS - 1)).astype(int)

    # 每条流的最终 step = max(两端节点出场帧)
    # —— A 方案：不叠加真实时间帧 real_step。节点按 BFS 连通顺序逐个点亮、间距均匀。
    steps = np.maximum(node_debut[src_idx], node_debut[dst_idx])
    steps = np.clip(steps, 1, config.TOTAL_STEPS)

    # —— 节点统计 ——
    node_flow = np.zeros(n_nodes, dtype=int)
    node_anom = np.zeros(n_nodes, dtype=int)
    # 全量真实字节/包/分数（不受回放帧 8000 采样影响），供前端节点详情显示真值。
    # 方向语义：IN_BYTES/IN_PKTS = src→dst（src 出站、dst 入站）；
    #          OUT_BYTES/OUT_PKTS = dst→src（src 入站、dst 出站）。
    node_in_bytes = np.zeros(n_nodes, dtype="int64")
    node_out_bytes = np.zeros(n_nodes, dtype="int64")
    node_in_pkts = np.zeros(n_nodes, dtype="int64")
    node_out_pkts = np.zeros(n_nodes, dtype="int64")
    node_score_sum = np.zeros(n_nodes, dtype="float64")
    node_score_max = np.zeros(n_nodes, dtype="float64")
    node_max_ratio = np.zeros(n_nodes, dtype="float64")   # 该节点异常流中最高的 score/阈值 比
    has_feats = feats is not None
    if has_feats:
        f_in_b = np.asarray(feats["in_bytes"], dtype="int64")
        f_out_b = np.asarray(feats["out_bytes"], dtype="int64")
        f_in_p = np.asarray(feats["in_pkts"], dtype="int64")
        f_out_p = np.asarray(feats["out_pkts"], dtype="int64")
    for i in range(n):
        s, d = src_idx[i], dst_idx[i]
        node_flow[s] += 1
        node_flow[d] += 1
        sc = float(scores[i])
        if preds[i]:
            node_anom[s] += 1
            node_anom[d] += 1
            _ratio = sc / threshold
            if _ratio > node_max_ratio[s]:
                node_max_ratio[s] = _ratio
            if _ratio > node_max_ratio[d]:
                node_max_ratio[d] = _ratio
        node_score_sum[s] += sc
        node_score_sum[d] += sc
        if sc > node_score_max[s]:
            node_score_max[s] = sc
        if sc > node_score_max[d]:
            node_score_max[d] = sc
        if has_feats:
            node_out_bytes[s] += f_in_b[i]   # src 发出 = IN_BYTES
            node_in_bytes[s] += f_out_b[i]   # src 收到 = OUT_BYTES
            node_out_pkts[s] += f_in_p[i]
            node_in_pkts[s] += f_out_p[i]
            node_in_bytes[d] += f_in_b[i]    # dst 收到 = IN_BYTES
            node_out_bytes[d] += f_out_b[i]  # dst 发出 = OUT_BYTES
            node_in_pkts[d] += f_in_p[i]
            node_out_pkts[d] += f_out_p[i]

    # 每个节点的主要攻击类型
    node_attack = {}
    for i in range(n):
        if preds[i] and attacks[i] != "Benign":
            for nid in (src_idx[i], dst_idx[i]):
                node_attack.setdefault(nid, {})
                node_attack[nid][attacks[i]] = node_attack[nid].get(attacks[i], 0) + 1

    nodes = []
    for i, ip in enumerate(node_list):
        top_atk = max(node_attack.get(i, {"正常": 1}).items(), key=lambda kv: kv[1])[0]
        nodes.append({
            "id": ip, "ip": ip,
            "risk": _risk_of(node_anom[i], node_max_ratio[i]),
            "attackType": top_atk if node_anom[i] else "正常",
            "flowCount": int(node_flow[i]),
            "anomalyCount": int(node_anom[i]),
            "inBytes": int(node_in_bytes[i]),
            "outBytes": int(node_out_bytes[i]),
            "inPkts": int(node_in_pkts[i]),
            "outPkts": int(node_out_pkts[i]),
            "scoreSum": round(float(node_score_sum[i]), 4),
            "scoreMax": round(float(node_score_max[i]), 4),
        })

    # —— 聚合边 ——
    edge_map = {}
    for i in range(n):
        key = (int(src_idx[i]), int(dst_idx[i]))
        e = edge_map.setdefault(key, {"flowCount": 0, "anomalyCount": 0,
                                      "scoreMax": 0.0, "types": {},
                                      "inBytes": 0, "outBytes": 0,
                                      "inPkts": 0, "outPkts": 0})
        e["flowCount"] += 1
        if preds[i]:
            e["anomalyCount"] += 1
        e["scoreMax"] = max(e["scoreMax"], float(scores[i]))
        t = attacks[i] if (preds[i] and attacks[i] != "Benign") else "正常"
        e["types"][t] = e["types"].get(t, 0) + 1
        if has_feats:
            # 方向语义与节点一致：IN_* = src→dst（src 出站、dst 入站），OUT_* 反之。
            # 链路字节/包数全量真值，供前端链路详情显示（回放采样帧不含字节，不能从帧估算）。
            e["inBytes"] += int(f_in_b[i])
            e["outBytes"] += int(f_out_b[i])
            e["inPkts"] += int(f_in_p[i])
            e["outPkts"] += int(f_out_p[i])
    edges = []
    for (s, d), e in edge_map.items():
        top_type = max(e["types"].items(), key=lambda kv: kv[1])[0]
        edges.append({
            "src": node_list[s], "dst": node_list[d],
            "flowCount": e["flowCount"], "anomalyCount": e["anomalyCount"],
            "scoreMax": round(e["scoreMax"], 4), "topType": top_type,
            "inBytes": int(e["inBytes"]), "outBytes": int(e["outBytes"]),
            "inPkts": int(e["inPkts"]), "outPkts": int(e["outPkts"]),
        })

    # —— flows（回放帧）：异常全保留 + 正常按需下采样 ——
    anom_i = np.where(preds == 1)[0]
    norm_i = np.where(preds == 0)[0]
    keep_norm = max(0, max_flows - len(anom_i))
    if len(norm_i) > keep_norm:
        norm_i = np.random.RandomState(42).choice(norm_i, keep_norm, replace=False)
    keep = np.concatenate([anom_i, norm_i])
    # 按 step 升序排序：前端 replayTick 用 "step<=当前帧 else break" 切片，依赖升序
    keep = keep[np.argsort(steps[keep], kind="stable")]
    flows = []
    for fid, i in enumerate(keep):
        flows.append({
            "id": int(fid), "step": int(steps[i]),
            "src": node_list[src_idx[i]], "dst": node_list[dst_idx[i]],
            "score": round(float(scores[i]), 4),
            "isAttack": int(preds[i]),
            "type": attacks[i] if (preds[i] and attacks[i] != "Benign") else "正常",
            "ts": int(ts_ms[i] - tmin),
        })

    # 全量真实统计（不受回放帧采样影响），供前端拓扑页显示真实异常率
    total_real = int(len(preds))
    anomaly_real = int(preds.sum())
    return {"total_steps": config.TOTAL_STEPS, "nodes": nodes,
            "edges": edges, "flows": flows,
            "total_flows": total_real,
            "anomaly_count": anomaly_real,
            "anomaly_rate": round(anomaly_real / total_real, 4) if total_real else 0.0}


def build_metrics(result, labels):
    """labels 为 None 时只返回 threshold/latency/scoreDist。"""
    scores = result["scores"]
    preds = result["preds"]
    # 分数分布（10 桶）：按「score / 检测阈值」的倍数分桶，范围 0→2 倍（每桶 0.2 倍，超出 2 倍并入末桶）。
    # 与前端告警流/下钻同口径（前端均显示 score/阈值 倍数），图上 1×（异常界）/1.25×（严重界）参考线
    # 与风险分级规则一致。归一化到 0-1 依赖全数据集最大值，数据相关、跨数据不可解释，弃用。
    _thr = result["threshold"] or 1e-9
    ratio = scores / _thr
    # 严重异常 = 异常流中 ≥1.25× 阈值的部分（与 _risk_of(ratio_threshold=1.25)、前端 RISK_CRITICAL_RATIO 同规则），
    # 前端分数分布据此把异常柱拆成「警告(橙) / 严重(红)」，与全局严重度色板一致。
    score_dist = []
    for b in range(10):
        lo, hi = b / 5, (b + 1) / 5
        sel = ratio >= lo
        if b < 9:
            sel = sel & (ratio < hi)
        score_dist.append({
            "range": f"{lo:.1f}-{hi:.1f}",
            "anomaly": int(preds[sel].sum()),
            "critical": int((preds[sel] & (ratio[sel] >= 1.25)).sum()),
            "normal": int((sel.sum() - preds[sel].sum())),
        })

    base = {
        "threshold": result["threshold"],
        "latencyMs": round(result["latency_ms"], 1),
        "scoreDist": score_dist,
    }
    if labels is None:
        base.update({"accuracy": None, "f1": None, "precision": None,
                     "recall": None, "fpr": None, "confusion": None, "prCurve": None})
        return base

    labels = np.asarray(labels).astype(int)
    tn, fp, fn, tp = confusion_matrix(labels, preds, labels=[0, 1]).ravel()
    prec, rec, _ = precision_recall_curve(labels, scores)
    # 下采样 PR 曲线到 ~100 点，避免传输过大
    idx = np.linspace(0, len(prec) - 1, min(100, len(prec))).astype(int)
    base.update({
        "accuracy": round(float((preds == labels).mean()), 6),
        "f1": round(float(f1_score(labels, preds, average="macro", zero_division=0)), 6),
        "precision": round(float(precision_score(labels, preds, zero_division=0)), 6),
        "recall": round(float(recall_score(labels, preds, zero_division=0)), 6),
        "fpr": round(float(fp / (fp + tn)) if (fp + tn) else 0.0, 6),
        "confusion": {"tp": int(tp), "fp": int(fp), "tn": int(tn), "fn": int(fn)},
        "prCurve": [{"recall": round(float(rec[i]), 4),
                     "precision": round(float(prec[i]), 4)} for i in idx],
    })
    return base


def _node_index(node_list, ip):
    return node_list.index(ip) if ip in node_list else -1


def node_detail(result, ts_ms, attacks, ip, top_k=20):
    """单个 IP 的明细：流量统计、主要攻击、高分流 top_k。"""
    node_list = result["node_list"]
    idx = _node_index(node_list, ip)
    if idx < 0:
        return {"ip": ip, "totalFlows": 0, "anomalyCount": 0,
                "topAttacks": [], "topFlows": []}
    scores, preds = result["scores"], result["preds"]
    src_idx, dst_idx = result["src_idx"], result["dst_idx"]
    ts_ms = np.asarray(ts_ms)
    attacks = np.asarray(attacks)
    mask = (src_idx == idx) | (dst_idx == idx)
    rows = np.where(mask)[0]
    atk_count = {}
    for i in rows:
        if preds[i] and attacks[i] != "Benign":
            atk_count[attacks[i]] = atk_count.get(attacks[i], 0) + 1
    top_flows = sorted(rows, key=lambda i: scores[i], reverse=True)[:top_k]
    return {
        "ip": ip,
        "totalFlows": int(mask.sum()),
        "anomalyCount": int(preds[rows].sum()),
        "topAttacks": [{"type": k, "count": v} for k, v in
                       sorted(atk_count.items(), key=lambda kv: -kv[1])],
        "topFlows": [{
            "dst": node_list[dst_idx[i]] if src_idx[i] == idx else node_list[src_idx[i]],
            "score": round(float(scores[i]), 4),
            "type": attacks[i] if (preds[i] and attacks[i] != "Benign") else "正常",
            "ts": int(ts_ms[i]),
        } for i in top_flows],
    }


def edge_flows(result, ts_ms, attacks, src, dst, page=0, size=50):
    """一对 IP 之间的明细流，分页。"""
    node_list = result["node_list"]
    si, di = _node_index(node_list, src), _node_index(node_list, dst)
    scores, preds = result["scores"], result["preds"]
    src_idx, dst_idx = result["src_idx"], result["dst_idx"]
    ts_ms = np.asarray(ts_ms)
    attacks = np.asarray(attacks)
    mask = (src_idx == si) & (dst_idx == di)
    rows = list(np.where(mask)[0])
    rows = sorted(rows, key=lambda i: scores[i], reverse=True)
    start, end = page * size, (page + 1) * size
    sel = rows[start:end]
    return {
        "src": src, "dst": dst, "total": len(rows), "page": page,
        "flows": [{
            "score": round(float(scores[i]), 4),
            "isAttack": int(preds[i]),
            "type": attacks[i] if (preds[i] and attacks[i] != "Benign") else "正常",
            "ts": int(ts_ms[i]),
        } for i in sel],
    }

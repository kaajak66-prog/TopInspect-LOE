/* ═══════════════════════════════════════════════════════
   TOPINSPECT — 渲染/回放/拓扑/告警/API 引擎 (Vue 版)
   说明：本文件是老 graph-v4-3d.html 主 <script>(882-1642) 的逐行搬迁，
   仅做 3 处适配：①顶部 import d3/gsap + 补声明 ②底部换路由注入 ③底部导出 + window 暴露。
   渲染逻辑保持与老版逐像素一致，禁止改函数体。
   ═══════════════════════════════════════════════════════ */
import * as d3 from 'd3'
import gsap from 'gsap'
import { cssColor } from './composables/useTheme'
import { bindModule } from './components/panelExpand.js'

// 老版作为 CDN 全局拿到 d3/gsap；这里改 npm import 后挂回 window，
// 兼容函数体内 `typeof d3==='undefined'` 之类的全局引用。
window.d3 = d3
window.gsap = gsap

// 老版在 sloppy-mode 下隐式全局；ES module 严格模式需显式声明。
let currentSnapshot = null

// ── 风险分级统一口径（与 server/aggregate.py `_risk_of(ratio_threshold=1.25)` 严格同规则）──
// 流/节点/边共用同一把尺子：score ≥ 1.25×检测阈值 → critical(红)；被判定异常但未达该倍数 → warning(橙)；
// 无异常 → normal(绿)。改这里的倍数必须同步后端，否则前端分级与后端节点分级会脱钩。
// 1.25 按当前演示数据（NF-UNSW-NB15-v3-test-split，23.6 万行）实测标定：异常流倍数
// p90≈1.24、max≈1.282，1.3 已超出数据上限（红色恒为 0）；1.25 = 前约 9% 异常流判严重。
var RISK_CRITICAL_RATIO = 1.25;

// 分数 → 颜色。真实分数是重构误差（量级 ~0.008-0.015，见 scoreDist 处注释），
// 不能用 mock 期的绝对 0.3/0.7 阈值（那会让真实数据永远显示绿色）。
function scoreColor(score) {
  var thr = (window._apiMetrics && window._apiMetrics.threshold) || 0.008;
  var r = score / (thr || 1e-9);
  return r >= RISK_CRITICAL_RATIO ? 'var(--danger)' : r >= 1 ? 'var(--warn)' : 'var(--normal)';
}

/* ────────── 以下为老版主逻辑逐行搬迁（882-1642 行） ────────── */
/* ═══════════════════════════════════════════════════════
   TOPINSPECT v4 — 应用逻辑 (中文版) + 3D背景
   ═══════════════════════════════════════════════════════ */
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const animCtx = { tweens: [], timelines: [] };
function rT(t) { if (t) animCtx.tweens.push(t); return t }
function rTL(tl) { if (tl) animCtx.timelines.push(tl); return tl }

function showToast(msg, type) {
  var toast = document.getElementById('toastNotif');
  if (!toast) { toast = document.createElement('div'); toast.id = 'toastNotif'; toast.className = 'toast'; document.body.appendChild(toast) }
  toast.innerHTML = msg; toast.className = 'toast ' + (type || 'success') + ' show';
  clearTimeout(toast._tid); toast._tid = setTimeout(function() { toast.classList.remove('show') }, 2500);
}

function updateClock() { var el = document.getElementById('tClock'); if (el) el.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }) }
// 时钟改由 TopBar.vue 响应式接管；此处不再顶层 setInterval（模块加载时 DOM 未挂载会抛错炸全局）。

function initParticles() {
  var c = document.getElementById('bgDots');
  for (var i = 0; i < 50; i++) {
    var d = document.createElement('div');
    d.style.cssText = 'position:absolute;width:'+(1.5+Math.random()*3)+'px;height:'+(1.5+Math.random()*3)+'px;background:'+(Math.random()>0.12?'var(--accent)':'var(--danger)')+';border-radius:50%;left:'+Math.random()*100+'%;top:'+Math.random()*100+'%;opacity:0;';
    c.appendChild(d);
    if (!reduceMotion) rT(gsap.fromTo(d, { x:0,y:0,opacity:0 }, { x:(Math.random()-0.5)*400, y:(Math.random()-0.5)*400, opacity:0.8, duration:3+Math.random()*9, delay:Math.random()*4, repeat:-1, yoyo:true, ease:'sine.inOut', onRepeat:function(){ this.vars.x=(Math.random()-0.5)*400; this.vars.y=(Math.random()-0.5)*400 } }));
  }
}
function initScanLine() { if (!reduceMotion) rT(gsap.fromTo('#scanLine', { top:'0%' }, { top:'100%', duration:4, ease:'none', repeat:-1 })) }
function initAmbient() { if (!reduceMotion) rT(gsap.to('#gOverlay', { opacity:0.7, duration:5, repeat:-1, yoyo:true, ease:'sine.inOut' })) }

/* ═══ MODEL RUN STATE ═══ */
var currentModel = 'improved';
// 当前模型（TopInspect 主检测）的真实运行结果，dashboard/报告页读取统计。
var modelRunState = { hasRun: false, flows: 0, anomalies: 0, anomalyRate: 0, detectCount: 0, latency: 0, _savedFlows: null };

/* ═══ DATA LAYER ═══ */
var TOTAL_STEPS = 300;
var allFlows = [];
var allAlertsCache = [];
var edgeFlowMap = {}; // key: "src->dst" → aggregated flow stats per edge

// 使用 D3 拓扑图已有的节点 ID，确保节点匹配
var ALL_NODE_IDS = [];
(function() {
  // 历史演示用节点 ID 池（mock 数据链路已移除，保留仅为兼容旧快照的 isAttacker 判断）
  var named = ['gateway','subnetA','dns','subnetB','attacker1','attacker2','suspect1','suspect2','ep1','ep2','ep3'];
  for (var i = 0; i < named.length; i++) ALL_NODE_IDS.push(named[i]);
  for (var i = 0; i < 40; i++) ALL_NODE_IDS.push('extra' + i);
  ALL_NODE_IDS.attackers = ['attacker1', 'attacker2'];
  ALL_NODE_IDS.suspects = ['suspect1', 'suspect2'];
  ALL_NODE_IDS.gateways = ['gateway', 'subnetA', 'subnetB', 'dns'];
})();

var ATTACK_TYPES = ['DDoS攻击', '侦察扫描', '横向移动', '端口扫描', 'DNS隧道', '暴力破解', 'SQL注入', 'XSS攻击'];

// ═══ NETFLOW V3 FEATURE DICTIONARY (from NetFlow_v3_Features.xlsx) ═══
var NETFLOW_FEATURES = [
  {f:'IPV4_SRC_ADDR',en:'IPv4 source address',cn:'IPv4源地址'},
  {f:'IPV4_DST_ADDR',en:'IPv4 destination address',cn:'IPv4目的地址'},
  {f:'L4_SRC_PORT',en:'IPv4 source port number',cn:'传输层源端口'},
  {f:'L4_DST_PORT',en:'IPv4 destination port number',cn:'传输层目的端口'},
  {f:'PROTOCOL',en:'IP protocol identifier byte',cn:'协议号'},
  {f:'L7_PROTO',en:'Layer 7 protocol (numeric)',cn:'应用层协议'},
  {f:'IN_BYTES',en:'Incoming number of bytes',cn:'入站字节数'},
  {f:'OUT_BYTES',en:'Outgoing number of bytes',cn:'出站字节数'},
  {f:'IN_PKTS',en:'Incoming number of packets',cn:'入站数据包数'},
  {f:'OUT_PKTS',en:'Outgoing number of packets',cn:'出站数据包数'},
  {f:'FLOW_DURATION_MILLISECONDS',en:'Flow duration in milliseconds',cn:'流量持续时间(ms)'},
  {f:'TCP_FLAGS',en:'Cumulative of all TCP flags',cn:'TCP标志累积'},
  {f:'CLIENT_TCP_FLAGS',en:'Cumulative of all client TCP flags',cn:'客户端TCP标志'},
  {f:'SERVER_TCP_FLAGS',en:'Cumulative of all server TCP flags',cn:'服务器TCP标志'},
  {f:'DURATION_IN',en:'Client to Server stream duration (msec)',cn:'流入持续时间(ms)'},
  {f:'DURATION_OUT',en:'Server to Client stream duration (msec)',cn:'流出持续时间(ms)'},
  {f:'MIN_TTL',en:'Min flow TTL',cn:'最小TTL'},
  {f:'MAX_TTL',en:'Max flow TTL',cn:'最大TTL'},
  {f:'LONGEST_FLOW_PKT',en:'Longest packet (bytes) of the flow',cn:'最长数据包(bytes)'},
  {f:'SHORTEST_FLOW_PKT',en:'Shortest packet (bytes) of the flow',cn:'最短数据包(bytes)'},
  {f:'MIN_IP_PKT_LEN',en:'Len of the smallest flow IP packet',cn:'最小IP包长度'},
  {f:'MAX_IP_PKT_LEN',en:'Len of the largest flow IP packet',cn:'最大IP包长度'},
  {f:'SRC_TO_DST_SECOND_BYTES',en:'Src to dst Bytes/sec',cn:'源→目的 字节/秒'},
  {f:'DST_TO_SRC_SECOND_BYTES',en:'Dst to src Bytes/sec',cn:'目的→源 字节/秒'},
  {f:'RETRANSMITTED_IN_BYTES',en:'Retransmitted TCP bytes (src->dst)',cn:'重传入字节数'},
  {f:'RETRANSMITTED_IN_PKTS',en:'Retransmitted TCP packets (src->dst)',cn:'重传入包数'},
  {f:'RETRANSMITTED_OUT_BYTES',en:'Retransmitted TCP bytes (dst->src)',cn:'重传出字节数'},
  {f:'RETRANSMITTED_OUT_PKTS',en:'Retransmitted TCP packets (dst->src)',cn:'重传出包数'},
  {f:'SRC_TO_DST_AVG_THROUGHPUT',en:'Src to dst avg throughput (bps)',cn:'源→目的 平均吞吐(bps)'},
  {f:'DST_TO_SRC_AVG_THROUGHPUT',en:'Dst to src avg throughput (bps)',cn:'目的→源 平均吞吐(bps)'},
  {f:'NUM_PKTS_UP_TO_128_BYTES',en:'Packets with IP size <= 128',cn:'≤128字节包数'},
  {f:'NUM_PKTS_128_TO_256_BYTES',en:'Packets with IP size 128~256',cn:'128-256字节包数'},
  {f:'NUM_PKTS_256_TO_512_BYTES',en:'Packets with IP size 256~512',cn:'256-512字节包数'},
  {f:'NUM_PKTS_512_TO_1024_BYTES',en:'Packets with IP size 512~1024',cn:'512-1024字节包数'},
  {f:'NUM_PKTS_1024_TO_1514_BYTES',en:'Packets with IP size 1024~1514',cn:'1024-1514字节包数'},
  {f:'TCP_WIN_MAX_IN',en:'Max TCP Window (src->dst)',cn:'TCP接收窗口最大值'},
  {f:'TCP_WIN_MAX_OUT',en:'Max TCP Window (dst->src)',cn:'TCP发送窗口最大值'},
  {f:'ICMP_TYPE',en:'ICMP Type * 256 + ICMP code',cn:'ICMP类型码'},
  {f:'ICMP_IPV4_TYPE',en:'ICMP Type',cn:'ICMP类型'},
  {f:'DNS_QUERY_ID',en:'DNS query transaction Id',cn:'DNS查询事务ID'},
  {f:'DNS_QUERY_TYPE',en:'DNS query type (e.g. 1=A, 2=NS..)',cn:'DNS查询类型'},
  {f:'DNS_TTL_ANSWER',en:'TTL of the first A record (if any)',cn:'DNS应答TTL'},
  {f:'FTP_COMMAND_RET_CODE',en:'FTP client command return code',cn:'FTP命令返回码'},
  {f:'FLOW_START_MILLISECONDS',en:'Flow start timestamp in ms',cn:'流开始时间戳(ms)'},
  {f:'FLOW_END_MILLISECONDS',en:'Flow end timestamp in ms',cn:'流结束时间戳(ms)'},
  {f:'SRC_TO_DST_IAT_MIN',en:'Min Inter-Packet Arrival Time (src->dst)',cn:'源→目的 IAT最小值(ms)'},
  {f:'SRC_TO_DST_IAT_MAX',en:'Max Inter-Packet Arrival Time (src->dst)',cn:'源→目的 IAT最大值(ms)'},
  {f:'SRC_TO_DST_IAT_AVG',en:'Avg Inter-Packet Arrival Time (src->dst)',cn:'源→目的 IAT平均值(ms)'},
  {f:'SRC_TO_DST_IAT_STDDEV',en:'StdDev Inter-Packet Arrival Time (src->dst)',cn:'源→目的 IAT标准差'},
  {f:'DST_TO_SRC_IAT_MIN',en:'Min Inter-Packet Arrival Time (dst->src)',cn:'目的→源 IAT最小值(ms)'},
  {f:'DST_TO_SRC_IAT_MAX',en:'Max Inter-Packet Arrival Time (dst->src)',cn:'目的→源 IAT最大值(ms)'},
  {f:'DST_TO_SRC_IAT_AVG',en:'Avg Inter-Packet Arrival Time (dst->src)',cn:'目的→源 IAT平均值(ms)'},
  {f:'DST_TO_SRC_IAT_STDDEV',en:'StdDev Inter-Packet Arrival Time (dst->src)',cn:'目的→源 IAT标准差'}
];

// Key feature indices for node/edge detail display
var FEATURE_KEYS = NETFLOW_FEATURES.map(function(x){return x.f});

function getAvailableNodes(step) {
  var pct = step / TOTAL_STEPS;
  var nodes = [];
  // 阶段1: 0-15% — 只有核心网关和第一个攻击者（~6个节点）
  nodes.push('gateway', 'subnetA', 'dns');
  if (pct >= 0.05) { nodes.push('subnetB', 'attacker1', 'suspect1'); }
  // 阶段2: 15-30% — 端点和其他攻击者加入（~12个节点）
  if (pct >= 0.15) { nodes.push('attacker2', 'suspect2', 'ep1', 'ep2', 'ep3'); }
  // 阶段3: 30-50% — extra0-9（~22个节点）
  if (pct >= 0.30) { for (var i = 0; i < 10; i++) nodes.push('extra' + i); }
  // 阶段4: 50-70% — extra10-19（~32个节点）
  if (pct >= 0.50) { for (var i = 10; i < 20; i++) nodes.push('extra' + i); }
  // 阶段5: 70-85% — extra20-29（~42个节点）
  if (pct >= 0.70) { for (var i = 20; i < 30; i++) nodes.push('extra' + i); }
  // 阶段6: 85-100% — extra30-39（~52个节点）
  if (pct >= 0.85) { for (var i = 30; i < 40; i++) nodes.push('extra' + i); }
  return nodes;
}

// generateTimeSeries() mock 数据生成已移除（假数据清理：所有数据必须来自后端检测结果）

/* ═══ DATA SOURCE 层（唯一与后端通信处）═══ */
var API_BASE = (location.protocol === 'file:') ? 'http://localhost:8000' : '';
var dataSource = {
  mode: '',              // '' 无数据（须上传检测） | 'api' 已上传并检测
  jobId: null,
  // 生成/获取 allFlows。mock 用原逻辑；api 拉后端 replay。
  // model 缺省用 currentModel（恒 'improved'，兼容后端 model 参数）。
  loadFlows: async function(model) {
    if (this.mode !== 'api' || !this.jobId) { showToast('<i class="fa-solid fa-circle-info"></i> 请先上传 NetFlow CSV 文件开始检测', 'info'); return []; }
    var mq = '?model=' + (model || currentModel);
    // 纵深防御：job 结果在后端是「先存 bundle 再标 done」，正常情况下 done 时已就绪。
    // 但极端时序（如 SSE done 与结果落库之间的窗口）replay 可能短暂 404，
    // 此处对 404 做有限重试（最多 5 次、每次 300ms），避免误报「拉取失败」。
    var r, attempts = 0;
    while (true) {
      r = await fetch(API_BASE + '/api/jobs/' + this.jobId + '/replay' + mq);
      if (r.ok) break;
      if (r.status === 404 && attempts < 5) {
        attempts++;
        await new Promise(function(res){ setTimeout(res, 300); });
        continue;
      }
      throw new Error('replay 拉取失败');
    }
    var data = await r.json();
    window._apiNodes = data.nodes; window._apiEdges = data.edges;
    TOTAL_STEPS = data.total_steps;
    allFlows = data.flows;
    // 全量真实统计（不受回放帧采样影响），供拓扑页显示真实异常率。
    // 后端回放帧只对「正常流」下采样、异常流全保留（见 aggregate.py keep_norm=max(0,max_flows-异常数)）。
    // 两种情形都要覆盖：
    //  (a) 异常数 < max_flows：帧里保留了部分正常流，用 normalSampleRate 还原；
    //  (b) 异常数 ≥ max_flows：正常流被全部丢弃(帧内正常=0)，改用「真实正常总数 × 回放进度」估算。
    // 无论哪种，已到达异常数都取自帧(异常全保留→精确)，正常数按上述还原/估算，
    // 得到随回放平滑演进、结束时收敛到真实率的运行占比。
    if (data.total_flows != null) {
      var frameAnom = 0;
      for (var fi = 0; fi < allFlows.length; fi++) { if (allFlows[fi].isAttack) frameAnom++; }
      var normalReal = data.total_flows - data.anomaly_count;   // 真实正常流总数
      var frameNormal = allFlows.length - frameAnom;            // 帧内保留的正常流数
      window._apiReal = {
        totalFlows: data.total_flows,
        anomalyCount: data.anomaly_count,
        anomalyRate: data.anomaly_rate,
        normalReal: normalReal,
        // 帧内保留正常流时 >0，可用于还原；被丢光时为 0，触发进度估算兜底
        normalSampleRate: (normalReal > 0 && frameNormal > 0) ? (frameNormal / normalReal) : 0,
      };
    } else {
      window._apiReal = null;
    }
    return allFlows;
  },
  getMetrics: async function(model) {
    if (this.mode !== 'api') return null;
    var r = await fetch(API_BASE + '/api/jobs/' + this.jobId + '/metrics?model=' + (model || currentModel));
    return r.ok ? await r.json() : null;
  },
  getNodeDetail: async function(ip) {
    if (this.mode !== 'api') return null;
    var r = await fetch(API_BASE + '/api/jobs/' + this.jobId + '/nodes/' + encodeURIComponent(ip) + '?model=' + currentModel);
    return r.ok ? await r.json() : null;
  },
  getEdgeFlows: async function(src, dst, page) {
    if (this.mode !== 'api') return null;
    var r = await fetch(API_BASE + '/api/jobs/' + this.jobId + '/edges/' +
      encodeURIComponent(src) + '/' + encodeURIComponent(dst) + '?page=' + (page||0) + '&model=' + currentModel);
    return r.ok ? await r.json() : null;
  }
};

function computeSnapshot(cumulativeFlows) {
  var flows = cumulativeFlows;
  if (!flows.length) return null;
  var nodeSet = {}, edges = [], lastStep = flows[flows.length - 1].step;
  // Reset edge flow map and rebuild from scratch each snapshot (cumulative)
  edgeFlowMap = {};
  var nodeStats = {}; // per-node traffic stats
  flows.forEach(function(f) {
    if (!nodeSet[f.src]) nodeSet[f.src] = { id: f.src, firstSeen: f.step, isAttacker: ALL_NODE_IDS.attackers.indexOf(f.src) >= 0, isSuspect: ALL_NODE_IDS.suspects.indexOf(f.src) >= 0 };
    if (!nodeSet[f.dst]) nodeSet[f.dst] = { id: f.dst, firstSeen: f.step, isAttacker: ALL_NODE_IDS.attackers.indexOf(f.dst) >= 0, isSuspect: ALL_NODE_IDS.suspects.indexOf(f.dst) >= 0 };
    edges.push({ id: f.id, src: f.src, dst: f.dst, score: f.score, isAttack: f.isAttack, type: f.type });
    // Per-edge stats
    var ek = f.src + '->' + f.dst;
    if (!edgeFlowMap[ek]) edgeFlowMap[ek] = { src: f.src, dst: f.dst, flowCount: 0, anomalyCount: 0, scoreSum: 0, scoreMax: 0, bytesEst: 0, pktEst: 0, types: {} };
    var es = edgeFlowMap[ek];
    es.flowCount++;
    if (f.isAttack) es.anomalyCount++;
    es.scoreSum += f.score;
    if (f.score > es.scoreMax) es.scoreMax = f.score;
    es.bytesEst += 0; es.pktEst += 0;   // 不再生成模拟字节/包；api 展示走后端真值
    // Per-node stats
    if (!nodeStats[f.src]) nodeStats[f.src] = { inBytes: 0, outBytes: 0, inPkts: 0, outPkts: 0, flowCount: 0, anomalyCount: 0, scoreSum: 0, scoreMax: 0 };
    if (!nodeStats[f.dst]) nodeStats[f.dst] = { inBytes: 0, outBytes: 0, inPkts: 0, outPkts: 0, flowCount: 0, anomalyCount: 0, scoreSum: 0, scoreMax: 0 };
    nodeStats[f.src].outBytes += es.bytesEst; nodeStats[f.src].outPkts += es.pktEst; nodeStats[f.src].flowCount++; if (f.isAttack) nodeStats[f.src].anomalyCount++; nodeStats[f.src].scoreSum += f.score; if (f.score > nodeStats[f.src].scoreMax) nodeStats[f.src].scoreMax = f.score;
    nodeStats[f.dst].inBytes += es.bytesEst; nodeStats[f.dst].inPkts += es.pktEst; nodeStats[f.dst].flowCount++; if (f.isAttack) nodeStats[f.dst].anomalyCount++; nodeStats[f.dst].scoreSum += f.score; if (f.score > nodeStats[f.dst].scoreMax) nodeStats[f.dst].scoreMax = f.score;
  });
  var nodes = Object.values(nodeSet);
  // API 模式：用后端全量真值的 risk 字段（aggregate._risk_of 在全量流上算好，
  // 不受回放帧 8000 采样失真影响，分级与指标完全对齐，也不再逐帧跳变）。
  var apiNodeMap = null;
  if (dataSource.mode === 'api' && window._apiNodes) {
    apiNodeMap = {};
    window._apiNodes.forEach(function(an){ apiNodeMap[an.id] = an; });
  }
  // Attach stats to each node
  nodes.forEach(function(n) {
    n.stats = nodeStats[n.id] || { inBytes:0, outBytes:0, inPkts:0, outPkts:0, flowCount:0, anomalyCount:0, scoreSum:0, scoreMax:0 };
    var an = apiNodeMap && apiNodeMap[n.id];
    if (an) {
      n.risk = an.risk;   // 后端全量真值分级（权威、稳定）
    } else {
      // 无后端节点时的兜底分级，与告警流同规则：节点取自身最严重那条异常流的级别。
      // 有异常流时 scoreMax 即异常流最高分（正常流分数都低于阈值），≥1.25×阈值 → critical。
      var acF = n.stats.anomalyCount;
      var thrF = (window._apiMetrics && window._apiMetrics.threshold) || 0.008;
      n.risk = acF > 0 ? (n.stats.scoreMax >= thrF * RISK_CRITICAL_RATIO ? 'critical' : 'warning') : 'normal';
    }
  });
  var totalFlows = flows.length;
  var totalAnomalies = 0;
  flows.forEach(function(f) { if (f.isAttack) totalAnomalies++; });
  var allAlerts = [];
  // 告警判定：mock 模式按随机分数阈值；api 模式真实分数是重构误差(很小)，
  // 模型已判定的异常(isAttack)即为告警，不能再用 0.7 这种 mock 阈值过滤。
  if (dataSource.mode === 'api') {
    flows.forEach(function(f) { if (f.isAttack) allAlerts.push(f); });
  } else {
    flows.forEach(function(f) { if (f.isAttack && f.score > 0.7) allAlerts.push(f); });
  }
  var prevCount = allAlertsCache.length;
  var newAlerts = allAlerts.slice(prevCount);
  allAlertsCache = allAlerts.slice();
  var stepAnomalies = {};
  flows.forEach(function(f) { stepAnomalies[f.step] = (stepAnomalies[f.step] || 0) + (f.isAttack ? 1 : 0); });
  var timelinePoints = [];
  for (var s = 1; s <= lastStep; s++) { timelinePoints.push({ step: s, anomalies: stepAnomalies[s] || 0 }); }
  var nBins = 10, scoreBins = [];
  for (var b = 0; b < nBins; b++) { scoreBins.push({ range: (b/nBins).toFixed(1)+'-'+((b+1)/nBins).toFixed(1), normal: 0, anomaly: 0 }); }
  flows.forEach(function(f) { var bi = Math.min(Math.floor(f.score * nBins), nBins - 1); if (f.isAttack) scoreBins[bi].anomaly++; else scoreBins[bi].normal++; });
  var anomalyRatio = totalFlows > 0 ? totalAnomalies / totalFlows : 0;
  // api 模式：回放帧只对正常流下采样、异常流全保留。已到达异常数取自帧(精确)，
  // 正常数按 normalSampleRate 还原；若正常流被丢光(采样率=0)则用「真实正常总数 × 进度」估算。
  // → 运行占比随回放平滑演进，结束时收敛到后端全量真实率。
  var dispTotalFlows = totalFlows, dispTotalAnomalies = totalAnomalies;
  if (dataSource.mode === 'api' && window._apiReal) {
    dispTotalAnomalies = totalAnomalies;                          // 异常流未采样，帧内即真值
    var frameNormalArrived = totalFlows - totalAnomalies;
    var realNormalArrived;
    if (window._apiReal.normalSampleRate > 0) {
      realNormalArrived = frameNormalArrived / window._apiReal.normalSampleRate;
    } else {
      // 正常流被全部丢弃：按回放进度估算已到达的真实正常流
      realNormalArrived = window._apiReal.normalReal * (lastStep / TOTAL_STEPS);
    }
    dispTotalFlows = Math.round(realNormalArrived + totalAnomalies);
    anomalyRatio = dispTotalFlows > 0 ? Math.max(0, Math.min(1, dispTotalAnomalies / dispTotalFlows)) : 0;
  }
  var threatLevel = anomalyRatio < 0.01 ? 'LOW' : anomalyRatio < 0.05 ? 'ELEVATED' : 'CRITICAL';
  return { nodes: nodes, edges: edges, edgeFlowMap: edgeFlowMap, nodeStats: nodeStats, totalFlows: dispTotalFlows, totalAnomalies: dispTotalAnomalies, anomalyRatio: anomalyRatio, newAlerts: newAlerts, allAlerts: allAlerts, timelinePoints: timelinePoints, scoreBins: scoreBins, threatLevel: threatLevel, progress: lastStep / TOTAL_STEPS, currentStep: lastStep };
}

// ═══ 增量快照引擎 ═══
// 回放每帧原本调 computeSnapshot(全切片) → O(累计流量)，越往后越卡。
// 增量版维护跨帧累积状态，每帧只处理「新出现的流」→ O(新增流量+节点数)。后退/换数据时重置重算。
var _incr = null;
function _incrReset() {
  _incr = { flowsRef: allFlows, idx: 0, curStep: 0,
            nodeSet: {}, nodeStats: {}, edgeFlowMap: {}, totalAnomalies: 0,
            stepAnomalies: {}, scoreBins: [], allAlerts: [], apiNodeMap: null };
  for (var b = 0; b < 10; b++) _incr.scoreBins.push({ range: (b/10).toFixed(1)+'-'+((b+1)/10).toFixed(1), normal: 0, anomaly: 0 });
  if (dataSource.mode === 'api' && window._apiNodes) {
    _incr.apiNodeMap = {}; window._apiNodes.forEach(function(an){ _incr.apiNodeMap[an.id] = an; });
  }
}
function _incrAddFlow(f) {
  var st = _incr;
  if (!st.nodeSet[f.src]) st.nodeSet[f.src] = { id: f.src, firstSeen: f.step, isAttacker: ALL_NODE_IDS.attackers.indexOf(f.src) >= 0, isSuspect: ALL_NODE_IDS.suspects.indexOf(f.src) >= 0 };
  if (!st.nodeSet[f.dst]) st.nodeSet[f.dst] = { id: f.dst, firstSeen: f.step, isAttacker: ALL_NODE_IDS.attackers.indexOf(f.dst) >= 0, isSuspect: ALL_NODE_IDS.suspects.indexOf(f.dst) >= 0 };
  var ek = f.src + '->' + f.dst;
  if (!st.edgeFlowMap[ek]) st.edgeFlowMap[ek] = { src: f.src, dst: f.dst, flowCount: 0, anomalyCount: 0, scoreSum: 0, scoreMax: 0, bytesEst: 0, pktEst: 0, types: {} };
  var es = st.edgeFlowMap[ek];
  var bEst = 0, pEst = 0;   // 后端 replay 无字节/包字段，不生成模拟值
  es.flowCount++; if (f.isAttack) es.anomalyCount++; es.scoreSum += f.score; if (f.score > es.scoreMax) es.scoreMax = f.score;
  es.bytesEst += bEst; es.pktEst += pEst;
  if (!st.nodeStats[f.src]) st.nodeStats[f.src] = { inBytes:0, outBytes:0, inPkts:0, outPkts:0, flowCount:0, anomalyCount:0, scoreSum:0, scoreMax:0 };
  if (!st.nodeStats[f.dst]) st.nodeStats[f.dst] = { inBytes:0, outBytes:0, inPkts:0, outPkts:0, flowCount:0, anomalyCount:0, scoreSum:0, scoreMax:0 };
  var ns = st.nodeStats[f.src]; ns.outBytes += bEst; ns.outPkts += pEst; ns.flowCount++; if (f.isAttack) ns.anomalyCount++; ns.scoreSum += f.score; if (f.score > ns.scoreMax) ns.scoreMax = f.score;
  var nd = st.nodeStats[f.dst]; nd.inBytes += bEst; nd.inPkts += pEst; nd.flowCount++; if (f.isAttack) nd.anomalyCount++; nd.scoreSum += f.score; if (f.score > nd.scoreMax) nd.scoreMax = f.score;
  if (f.isAttack) st.totalAnomalies++;
  st.stepAnomalies[f.step] = (st.stepAnomalies[f.step] || 0) + (f.isAttack ? 1 : 0);
  var bi = Math.min(Math.floor(f.score * 10), 9); if (f.isAttack) st.scoreBins[bi].anomaly++; else st.scoreBins[bi].normal++;
  if (dataSource.mode === 'api' && f.isAttack) st.allAlerts.push(f);
}
// >>incr-snap-below
function computeSnapshotIncremental(step) {
  // 后退、换数据集、或首帧 → 重置累积态从头累加到 step
  if (!_incr || _incr.flowsRef !== allFlows || step < _incr.curStep) _incrReset();
  while (_incr.idx < allFlows.length && allFlows[_incr.idx].step <= step) {
    _incrAddFlow(allFlows[_incr.idx]); _incr.idx++;
  }
  _incr.curStep = step;
  if (_incr.idx === 0) {
    // 回放前期可能还没有任何流（API 全量数据的异常流集中在中后段；
    // 且异常多时后端会把正常流全部从回放帧丢弃 → 帧内前期完全没有流）。
    // 此前这里硬编码 totalFlows:0，导致「总流量/异常数」直到中后段红点冒出才突然跳数。
    // 修正：API 模式下按回放进度估算「已到达的真实正常流」，让总流量从 step 1 起平滑增长，
    // 不再等第一条异常流(红点)出现才显示。异常数此时仍为 0（异常流确实尚未到达，真实）。
    var emptyTimeline = [];
    for (var es0 = 1; es0 <= step; es0++) emptyTimeline.push({ step: es0, anomalies: 0 });
    var eF = 0;
    if (dataSource.mode === 'api' && window._apiReal) {
      eF = Math.round(window._apiReal.normalReal * (step / TOTAL_STEPS));
    }
    return { nodes: [], edges: { length: 0 }, edgeFlowMap: {}, nodeStats: {},
             totalFlows: eF, totalAnomalies: 0,
             anomalyRatio: 0, newAlerts: [], allAlerts: [], timelinePoints: emptyTimeline,
             scoreBins: _incr.scoreBins, threatLevel: 'LOW', progress: step / TOTAL_STEPS, currentStep: step };
  }
  var st = _incr;
  var lastStep = allFlows[_incr.idx - 1].step;
  // 节点数组（每帧从累积 nodeSet 物化，O(节点数)，规模小）
  var nodes = Object.values(st.nodeSet);
  nodes.forEach(function(n) {
    n.stats = st.nodeStats[n.id] || { inBytes:0, outBytes:0, inPkts:0, outPkts:0, flowCount:0, anomalyCount:0, scoreSum:0, scoreMax:0 };
    var an = st.apiNodeMap && st.apiNodeMap[n.id];
    if (an) { n.risk = an.risk; }
    else {
      var acF2 = n.stats.anomalyCount;
      var thrF2 = (window._apiMetrics && window._apiMetrics.threshold) || 0.008;
      n.risk = acF2 > 0 ? (n.stats.scoreMax >= thrF2 * RISK_CRITICAL_RATIO ? 'critical' : 'warning') : 'normal';
    }
  });
  edgeFlowMap = st.edgeFlowMap;   // 同步全局（下游 updateTopology 读它）
  var totalFlows = _incr.idx, totalAnomalies = st.totalAnomalies;
  // 新增告警：本帧 allAlerts 相对上帧缓存的增量
  var prevCount = allAlertsCache.length;
  var newAlerts = st.allAlerts.slice(prevCount);
  allAlertsCache = st.allAlerts.slice();
  var timelinePoints = [];
  for (var s = 1; s <= lastStep; s++) timelinePoints.push({ step: s, anomalies: st.stepAnomalies[s] || 0 });
  var anomalyRatio = totalFlows > 0 ? totalAnomalies / totalFlows : 0;
  var dispTotalFlows = totalFlows, dispTotalAnomalies = totalAnomalies;
  if (dataSource.mode === 'api' && window._apiReal) {
    dispTotalAnomalies = totalAnomalies;                          // 异常流未采样，帧内即真值
    var frameNormalArrived = totalFlows - totalAnomalies;
    var realNormalArrived;
    if (window._apiReal.normalSampleRate > 0) {
      realNormalArrived = frameNormalArrived / window._apiReal.normalSampleRate;
    } else {
      // 正常流被全部丢弃：按回放进度估算已到达的真实正常流
      realNormalArrived = window._apiReal.normalReal * (lastStep / TOTAL_STEPS);
    }
    dispTotalFlows = Math.round(realNormalArrived + totalAnomalies);
    anomalyRatio = dispTotalFlows > 0 ? Math.max(0, Math.min(1, dispTotalAnomalies / dispTotalFlows)) : 0;
  }
  var threatLevel = anomalyRatio < 0.01 ? 'LOW' : anomalyRatio < 0.05 ? 'ELEVATED' : 'CRITICAL';
  return { nodes: nodes, edges: { length: totalFlows }, edgeFlowMap: st.edgeFlowMap, nodeStats: st.nodeStats,
           totalFlows: dispTotalFlows, totalAnomalies: dispTotalAnomalies,
           anomalyRatio: anomalyRatio, newAlerts: newAlerts, allAlerts: st.allAlerts, timelinePoints: timelinePoints,
           scoreBins: st.scoreBins, threatLevel: threatLevel, progress: lastStep / TOTAL_STEPS, currentStep: lastStep };
}


/* ═══ REPLAY ENGINE ═══ */
var replayState = { playing: false, position: 0, speed: 16, timer: null };
var replayDone = false;   // 回放是否已完整结束：决定时间轴是否定格为完整曲线

function toggleReplay() {
  // 首次播放必须已有上传检测结果（api 数据），不再生成 mock 数据
  if (replayState.position === 0 && allFlows.length === 0) {
    if (dataSource.mode !== 'api' || !dataSource.jobId) {
      showToast('<i class="fa-solid fa-circle-info"></i> 请先上传 NetFlow CSV 文件开始检测', 'info');
      return;
    }
  }
  replayState.playing = !replayState.playing;
  var icon = replayState.playing ? 'fa-pause' : 'fa-play';
  var label = replayState.playing ? ' 暂停' : ' 播放';
  _setHTML('btnPlayPause', '<i class="fa-solid ' + icon + '"></i>');
  _setHTML('btnReplay', '<i class="fa-solid ' + icon + '"></i>' + label);
  if (replayState.playing) { replayDone = false; if (replayState.position === 0) replayTick(0); runReplay(); }
  else { clearTimeout(replayState.timer); }
}
function _setHTML(id, html){ var el=document.getElementById(id); if(el) el.innerHTML=html; }

function runReplay() {
  if (!replayState.playing) return;
  replayState.position++;
  if (replayState.position > TOTAL_STEPS) {
    replayState.position = TOTAL_STEPS; replayState.playing = false;
    _setHTML('btnPlayPause', '<i class="fa-solid fa-play"></i>');
    _setHTML('btnReplay', '<i class="fa-solid fa-play"></i> 播放');
    var ds=document.getElementById('detectStatus'); if(ds) ds.textContent='检测完成';
    var dsl=document.getElementById('detectStatusLeft'); if(dsl) dsl.textContent='检测完成';
    replayDone = true;            // 标记回放完成：时间轴定格为完整曲线
    replayTick(TOTAL_STEPS);      // 重绘最后一帧，定格在结束时刻的完整状态
    saveModelRunResult();
    return;
  }
  replayDone = false;
  replayTick(replayState.position);
  replayState.timer = setTimeout(runReplay, 1000 / replayState.speed);
}

function saveModelRunResult() {
  // Compute final snapshot to get aggregate stats
  var slice = [];
  for (var i = 0; i < allFlows.length; i++) { if (allFlows[i].step <= TOTAL_STEPS) slice.push(allFlows[i]); }
  var snap = computeSnapshot(slice);
  if (!snap) return;
  var st = modelRunState;
  if (st) {
    st.hasRun = true;
    st.detectCount = snap.totalAnomalies;
    st.flows = snap.totalFlows;
    st.anomalies = snap.totalAnomalies;
    st.anomalyRate = snap.anomalyRatio * 100;
    st._savedFlows = allFlows.slice();
  }
}

function replayTick(step) {
  if (step === 0) {
    allAlertsCache = []; currentSnapshot = null; _incr = null;
    // step 0：渲染「零快照」而非 null，让实时统计从 0 起显示并随回放平滑增长，
    // 而不是停在「—」直到中后段有流/红点时才突然跳数。拓扑仍从空开始逐帧点亮。
    updateAllComponents(_zeroSnapshot());
    updateReplayUI(0);
    return;
  }
  var snapshot = computeSnapshotIncremental(step);
  currentSnapshot = snapshot;   // 存最新快照，供仪表盘/图表读取
  updateAllComponents(snapshot);
  // API 模式：全量数据的流可能集中在中后段(如 step 147~286)，前期 snapshot 为 null，
  // 但拓扑节点应按 replayState.position 逐帧点亮，不能等到有流才一次性冒出。
  // 故无论 snapshot 是否为 null，都单独驱动一次拓扑节点出场。
  if (dataSource.mode === 'api' && window._apiNodes && !snapshot) updateTopologyFromSnapshot(null);
  updateReplayUI(step);
}

// 全零快照：各统计项为 0、时间轴为空，供 step 0 初始渲染，使面板从 0 起显示。
function _zeroSnapshot() {
  var bins = [];
  for (var b = 0; b < 10; b++) bins.push({ range: (b/10).toFixed(1)+'-'+((b+1)/10).toFixed(1), normal: 0, anomaly: 0 });
  return { nodes: [], edges: { length: 0 }, edgeFlowMap: {}, nodeStats: {},
           totalFlows: 0, totalAnomalies: 0,
           anomalyRatio: 0, newAlerts: [], allAlerts: [], timelinePoints: [],
           scoreBins: bins, threatLevel: 'LOW', progress: 0, currentStep: 0 };
}

function updateAllComponents(snap) {
  updateTopologyFromSnapshot(snap);
  updateStatsFromSnapshot(snap);
  updateAlertStreamFromSnapshot(snap);
  updateChartsFromSnapshot(snap);
  updateStatusBarsFromSnapshot(snap);
  updateThreatOverviewFromSnapshot(snap);
}

// 左面板「威胁概览」：按节点 risk 统计 + 受影响占比 + 活跃连接/攻击流（真实快照数据）
function updateThreatOverviewFromSnapshot(snap) {
  function _set(id, v){ var el=document.getElementById(id); if(el) el.textContent=v; }
  if (!snap || !snap.nodes) {
    ['tovCritical','tovWarning','tovSafe','tovEdges','tovAttackFlows'].forEach(function(id){ _set(id,'0'); });
    _set('tovAffectedPct','0%');
    var b0=document.getElementById('tovAffectedBar'); if(b0) b0.style.width='0%';
    return;
  }
  var crit=0, warn=0, safe=0;
  // API 模式：按后端全量节点统计三档（与拓扑图、顶栏一致），只数已点亮的节点
  // （curStep>=debut），使三档之和 = 顶栏节点数 = 图上可见节点，随回放同步递增。
  var statNodes;
  if (dataSource.mode === 'api' && window._apiNodes) {
    var cs2 = replayState.position || 0, db2 = window._apiNodeDebut;
    statNodes = db2 ? window._apiNodes.filter(function(n){ return cs2 >= (db2[n.id]||1); }) : window._apiNodes;
  } else {
    statNodes = snap.nodes;
  }
  statNodes.forEach(function(n){
    if (n.risk==='critical') crit++; else if (n.risk==='warning') warn++; else safe++;
  });
  var total = statNodes.length || 1;
  var affected = crit + warn;
  var pct = Math.round(affected / total * 100);
  _set('tovCritical', crit);
  _set('tovWarning', warn);
  _set('tovSafe', safe);
  // 活跃连接：API 模式显示后端全量去重连接数（window._apiEdges，含正常流连接，
  // 与顶栏「边」、拓扑图最终显示一致，恒定不变）。非 API 模式回退到帧内去重边数。
  // 不再用 snap.edges.length——那是"已到达流条数"，回放帧只保留异常流时会与攻击流相等、失真。
  var connCount = (dataSource.mode === 'api' && window._apiEdges)
    ? window._apiEdges.length
    : Object.keys(snap.edgeFlowMap || {}).length;
  _set('tovEdges', connCount);
  // 攻击流：统计 nodeStats 的 anomalyCount 总和的一半（src+dst 重复计数），或用 totalAnomalies
  _set('tovAttackFlows', (snap.totalAnomalies != null ? snap.totalAnomalies.toLocaleString() : '0'));
  _set('tovAffectedPct', pct + '%');
  var bar=document.getElementById('tovAffectedBar'); if(bar) bar.style.width = pct + '%';
}

function updateReplayUI(step) {
  var pct = step / TOTAL_STEPS * 100;
  function _set(id, prop, val){ var el=document.getElementById(id); if(el){ if(prop==='w') el.style.width=val; else el.textContent=val; } }
  _set('replayFill','w',pct + '%');
  _set('replayFill2','w',pct + '%');
  var curMin = Math.floor(step * 3600 / TOTAL_STEPS / 60);
  var curSec = Math.floor(step * 3600 / TOTAL_STEPS) % 60;
  var ts = String(curMin).padStart(2,'0')+':'+String(curSec).padStart(2,'0');
  _set('replayCurrent','t',ts);
  _set('replayTotal','t','60:00');
  _set('replayTimeLabel','t',ts + ' / 60:00');
  _set('bPos','t',Math.round(pct) + '%');
  _set('replayPct','t',Math.round(pct) + '%');
}

function onSpeedChange() { var ss=document.getElementById('speedSelect'); if(ss){ replayState.speed = parseFloat(ss.value); _setText('replaySpeed', replayState.speed + 'x'); } }
// 检测控制卡片的速度按钮：实时生效（runReplay 每帧读取最新 speed）
function setReplaySpeed(spd, btn){
  replayState.speed = spd;
  _setText('replaySpeed', spd + 'x');
  var box=document.getElementById('speedBtns');
  if(box){ box.querySelectorAll('.speed-btn').forEach(function(b){ b.classList.remove('active'); }); }
  if(btn) btn.classList.add('active');
}
function _setText(id,t){ var el=document.getElementById(id); if(el) el.textContent=t; }
function replayStepForward() { replayState.position = Math.min(TOTAL_STEPS, replayState.position + 1); replayTick(replayState.position); }
function replayStepBack() { replayState.position = Math.max(0, replayState.position - 1); replayTick(replayState.position); }
function replaySkipForward() { replayState.position = Math.min(TOTAL_STEPS, replayState.position + 10); replayTick(replayState.position); }
function replaySkipBack() { replayState.position = Math.max(0, replayState.position - 10); replayTick(replayState.position); }

function resetReplayData() {
  replayState.playing = false; replayState.position = 0; replayDone = false;
  clearTimeout(replayState.timer);
  _setHTML('btnPlayPause', '<i class="fa-solid fa-play"></i>');
  _setHTML('btnReplay', '<i class="fa-solid fa-play"></i> 播放');
  // Clear all model run data
  modelRunState = { hasRun: false, flows: 0, anomalies: 0, anomalyRate: 0, detectCount: 0, latency: 0, _savedFlows: null };
  allFlows = [];
  allAlertsCache = [];
  alertData = [];
  _alertSeen = {};
  _alertSig = '';
  edgeFlowMap = {};
  // 回到 api/mock 起点 + 清空真实数据缓存，恢复空态
  dataSource.mode = ''; dataSource.jobId = null;
  window._apiJobId = null;
  window._apiMetrics = null; window._apiNodes = null; window._apiEdges = null; window._apiScoreDist = null; window._apiReal = null;
  replayTick(0);
  currentSnapshot = null;
  // 拓扑恢复空态提示
  var te=document.getElementById('topoEmpty'); if(te) te.classList.remove('hidden');
  var ds=document.getElementById('detectStatus'); if(ds) ds.textContent='就绪 · 等待检测';
  var dsl=document.getElementById('detectStatusLeft'); if(dsl) dsl.textContent='就绪 · 等待检测';
  showToast('<i class="fa-solid fa-rotate"></i> 全部数据已重置\n点击「开始检测」重新运行', 'success');
}

/* ═══ ALERTS ═══ */
var alertData = [];
var alertFilter = 'all';   // all | critical | warning
var _alertSeen = {};       // 已播放过入场动画的告警 id，防止每帧重播
var _alertSig = '';        // 可见告警列表指纹，仅变化时才重建 DOM（防回放中每帧重建导致 hover 抖动）

function updateAlertStreamFromSnapshot(snap) {
  var el = document.getElementById('alertStream'); if (!el) return;
  if (snap && snap.newAlerts && snap.newAlerts.length) {
    snap.newAlerts.forEach(function(a) {
      var d = new Date(a.ts);
      // 风险分级：api 模式真实分数是重构误差，按"超过阈值的倍数"分级；mock 模式用 0.7/0.9。
      var risk;
      if (dataSource.mode === 'api') {
        var thr = (window._apiMetrics && window._apiMetrics.threshold) || 0.008;
        var ratio = a.score / (thr || 1e-9);
        // 实测攻击流 score/threshold 倍数集中在 1.0~1.9，原 ratio>=3 门槛过高→全判 warning（全黄）。
        // 改用 1.25 倍为界：高于 1.25 倍（更显著的异常）判 critical（红），其余 warning（黄）。
        risk = ratio >= RISK_CRITICAL_RATIO ? 'critical' : 'warning';
      } else {
        risk = a.score > 0.9 ? 'critical' : 'warning';
      }
      alertData.unshift({ id: 'a' + a.id, time: String(d.getUTCHours()).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0') + ':' + String(d.getUTCSeconds()).padStart(2,'0'), src: a.src, dst: a.dst, score: a.score, scoreRatio: dataSource.mode === 'api' ? ratio : null, risk: risk, cleared: false });
    });
  }
  _renderAlertItems();
}

// 告警流分数显示：api 模式显示「score/阈值」倍数（与分数分布/下钻同口径），mock 模式显示原始 0-1 分
function alertScoreTxt(a) {
  if (dataSource.mode === 'api' && typeof a.scoreRatio === 'number') return a.scoreRatio.toFixed(2) + '×';
  return a.score.toFixed(3);
}

// 按当前筛选条件渲染告警条目 + 更新计数徽章
function _renderAlertItems() {
  var el = document.getElementById('alertStream'); if (!el) return;
  var active = alertData.filter(function(a){ return !a.cleared; });
  // 计数徽章
  var badge = document.getElementById('alertCount');
  if (badge) {
    var crit = active.filter(function(a){return a.risk==='critical';}).length;
    badge.textContent = active.length + (crit ? ' · ' + crit + '严重' : '');
    // 徽章=告警总数（含警告）：有严重则红，仅警告则橙，与严重度语义一致
    badge.style.color = crit ? 'var(--danger)' : 'var(--warn)';
    badge.style.background = crit ? 'rgba(255,45,85,0.12)' : 'rgba(255,149,0,0.12)';
    badge.style.borderColor = crit ? 'rgba(255,45,85,0.25)' : 'rgba(255,149,0,0.25)';
  }
  if (!active.length) {
    el.innerHTML = '<div style="font-size:9px;color:var(--text-dim);padding:8px;">暂无告警 · 等待检测数据...</div>';
    return;
  }
  var filtered = active.filter(function(a){ return alertFilter === 'all' || a.risk === alertFilter; });
  if (!filtered.length) {
    el.innerHTML = '<div style="font-size:9px;color:var(--text-dim);padding:8px;">无「' + (alertFilter==='critical'?'严重':'警告') + '」级告警</div>';
    _alertSig = '_empty_';
    return;
  }
  // 回放停止后：展示全部告警（虚拟滚动，容器自带 overflow-y:auto），可滚动查看历史。
  // 回放进行中：仅展示最新 8 条（每帧只重建少量 DOM，避免卡顿与 hover 抖动）。
  if (!replayState.playing) {
    _renderAlertStreamVirtual(filtered);
    return;
  }
  var recent = filtered.slice(0, 8);
  // 指纹：筛选条件 + 可见条目 id 序列。未变化则跳过 DOM 重建，避免回放中每帧重建导致 hover 抖动。
  var sig = alertFilter + '|' + recent.map(function(a){ return a.id; }).join(',');
  if (sig === _alertSig) return;
  _alertSig = sig;
  el.onscroll = null;   // 从停止态(虚拟滚动)切回播放态，清掉残留的滚动监听
  el.innerHTML = recent.map(function(a, i) {
    var cls = a.risk === 'warning' ? ' warn' : '';
    var isNew = !_alertSeen[a.id];   // 仅首次出现的条目播放入场动画，避免每帧重播抖动
    if (isNew) { _alertSeen[a.id] = 1; cls += ' alert-new'; }
    var rc = a.risk === 'critical' ? 'var(--danger)' : a.risk === 'warning' ? 'var(--warn)' : 'var(--normal)';
    var riskLabel = a.risk === 'critical' ? '严重' : a.risk === 'warning' ? '警告' : '正常';
    return '<div class="alert-item' + cls + '"' + (isNew ? ' style="animation-delay:' + (i*0.03) + 's"' : '') + ' onclick="locateAlert(\'' + a.src + '\')" title="点击定位源节点">' +
      '<span class="a-risk" style="color:' + rc + '">' + riskLabel + '</span>' +
      '<span class="a-path">' + a.src + '  →  ' + a.dst + '</span>' +
      '<span class="a-score" style="color:' + rc + '">' + alertScoreTxt(a) + '</span>' +
    '</div>';
  }).join('');
}

// 侧栏实时告警流的虚拟滚动（回放停止后用）：只渲染视口内可见条目，
// 哪怕上万条告警也只建几十个 DOM，可滚动查看全部历史告警。
var _streamRowH = 33;          // 单条 alert-item 高度(px)
var _streamBuffer = 6;
var _streamData = [];
var _streamScrollRaf = 0;
function _renderAlertStreamVirtual(filtered) {
  var el = document.getElementById('alertStream'); if (!el) return;
  _streamData = filtered;
  // 指纹：停止态 + 条数 + 头尾 id，结构未变则不重建外壳（避免切筛选/清除时滚动跳动）。
  var sig = 'stopped|' + alertFilter + '|' + filtered.length + '|' + (filtered[0] && filtered[0].id) + '|' + (filtered[filtered.length-1] && filtered[filtered.length-1].id);
  if (sig === _alertSig) return;
  _alertSig = sig;
  el.innerHTML = '<div id="streamSpacer" style="height:'+(filtered.length*_streamRowH)+'px;position:relative">' +
      '<div id="streamRows" style="position:absolute;top:0;left:0;right:0"></div>' +
    '</div>';
  el.onscroll = _onStreamScroll;
  _renderStreamWindow(0);
}
function _renderStreamWindow(scrollTop) {
  var rows = document.getElementById('streamRows'); if (!rows) return;
  var data = _streamData, total = data.length;
  var vh = (document.getElementById('alertStream') || {}).clientHeight || 300;
  var start = Math.max(0, Math.floor(scrollTop / _streamRowH) - _streamBuffer);
  var end = Math.min(total, start + Math.ceil(vh / _streamRowH) + _streamBuffer * 2);
  var html = '';
  for (var i = start; i < end; i++) {
    var a = data[i];
    var cls = a.risk === 'warning' ? ' warn' : '';
    var rc = a.risk === 'critical' ? 'var(--danger)' : a.risk === 'warning' ? 'var(--warn)' : 'var(--normal)';
    var riskLabel = a.risk === 'critical' ? '严重' : a.risk === 'warning' ? '警告' : '正常';
    html += '<div class="alert-item' + cls + '" style="height:'+_streamRowH+'px;box-sizing:border-box" onclick="locateAlert(\'' + a.src + '\')" title="点击定位源节点">' +
      '<span class="a-risk" style="color:' + rc + '">' + riskLabel + '</span>' +
      '<span class="a-path">' + a.src + '  →  ' + a.dst + '</span>' +
      '<span class="a-score" style="color:' + rc + '">' + alertScoreTxt(a) + '</span>' +
    '</div>';
  }
  rows.style.transform = 'translateY(' + (start * _streamRowH) + 'px)';
  rows.innerHTML = html;
}
function _onStreamScroll() {
  if (_streamScrollRaf) return;
  _streamScrollRaf = requestAnimationFrame(function(){
    _streamScrollRaf = 0;
    var sc = document.getElementById('alertStream');
    if (sc) _renderStreamWindow(sc.scrollTop);
  });
}

// 切换告警筛选
function setAlertFilter(f, btn) {
  alertFilter = f;
  var box = document.querySelector('#topo-alert-strip .strip-filters');
  if (box) box.querySelectorAll('.sf-btn').forEach(function(b){ b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  _renderAlertItems();
}

// 点击告警 → 在拓扑图中定位并高亮对应源节点
function locateAlert(ip) {
  if (!ip || !allNodes) return;
  var node = allNodes.find(function(n){ return n.label === ip || n.id === ip; });
  if (!node) { showToast('<i class="fa-solid fa-circle-info"></i> 该节点不在当前拓扑视图中', 'info'); return; }
  // 居中聚焦
  var c = document.getElementById('topo-canvas-wrap');
  if (c && topoSvg && topoZoomBehavior) {
    topoSvg.transition().duration(500).call(topoZoomBehavior.transform,
      d3.zoomIdentity.translate(c.clientWidth/2 - node.x*2.2, c.clientHeight/2 - node.y*2.2).scale(2.2));
  }
  // 复用节点选中高亮逻辑
  selectedNodeId = node.id; selectedEdgeId = null;
  if (typeof highlightConnected === 'function') highlightConnected(node);
  if (typeof showDetail === 'function') showDetail(node);
}

function renderAlertStream() { updateAlertStreamFromSnapshot(null); }

function renderSettings() {
  var body = document.getElementById('settingsBody'); if (!body) return;
  body.innerHTML = '<div style="display:flex;gap:16px">' +
    '<div class="panel" style="flex:1"><div class="panel-header"><i class="fa-solid fa-gear"></i> 检测配置</div>' +
      '<div style="display:flex;flex-direction:column;gap:10px;font-size:10px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center"><span>边嵌入维度 <span style="color:var(--text-dim);font-size:8px">(模型固定)</span></span><span style="color:var(--accent);font-family:var(--font-mono)">96</span></div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center"><span>AE 嵌入维度 <span style="color:var(--text-dim);font-size:8px">(模型固定)</span></span><span style="color:var(--accent);font-family:var(--font-mono)">48</span></div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center"><span>回放步数</span><input class="input" type="number" value="300" style="width:100px" id="setTotalSteps" onchange="var v=parseInt(this.value);if(v>0&&v<=2000){TOTAL_STEPS=v;showToast(\'<i class=\\\'fa-solid fa-circle-check\\\'></i> 已更新为 \'+v+\' 步\',\'success\')}"></div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center"><span>动画效果</span><label style="cursor:pointer"><input type="checkbox" checked onchange="document.getElementById(\'app-shell\').style.setProperty(\'--reduce-motion\',this.checked?\'0\':\'1\')"> 启用</label></div>' +
      '</div></div>' +
    '<div class="panel" style="flex:1"><div class="panel-header"><i class="fa-solid fa-database"></i> 数据源</div>' +
      '<div style="font-size:10px;color:var(--text-dim);line-height:2">' +
        '<div style="color:var(--accent);font-weight:700">NF-UNSW-NB15-v3</div>' +
        '<div>格式: NetFlow v3 CSV</div><div>节点数: 51</div><div>特征数: 49</div>' +
        '<div>时间范围: 2026-01 ~ 2026-06</div>' +
        '<button class="btn small" onclick="navigateTo(\'upload\')" style="margin-top:8px"><i class="fa-solid fa-cloud-arrow-up"></i> 导入新数据</button>' +
      '</div></div></div>' +
    '<div class="panel" style="margin-top:12px"><div class="panel-header"><i class="fa-solid fa-circle-info"></i> 系统信息</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;font-size:10px">' +
        '<div><span style="color:var(--text-dim)">版本:</span> 拓察 TopInspect v4.0</div>' +
        '<div><span style="color:var(--text-dim)">前端:</span> D3.js v7 + GSAP 3.12</div>' +
        '<div><span style="color:var(--text-dim)">模型:</span> Graph AutoEncoder</div>' +
        '<div><span style="color:var(--text-dim)">数据集:</span> NF-UNSW-NB15-v3</div>' +
        '<div><span style="color:var(--text-dim)">特征数:</span> 49 维 NetFlow v3</div>' +
        '<div><span style="color:var(--text-dim)">运行模式:</span> SOC 安全运营中心</div>' +
      '</div></div>';
}

// 虚拟滚动状态：当前过滤后的告警数据 + 行高 + 缓冲行数。
// 只渲染视口内可见行 ± 缓冲，十万级告警也只建几十个 DOM 节点，根治告警页卡顿。
var _alertRowH = 30;          // 单行高度(px)，与 .data-table td padding 对齐
var _alertBuffer = 8;         // 视口上下各多渲几行，滚动时不露白
var _alertFilteredData = [];  // 当前过滤排序后的全量数据（只存数据，不建 DOM）
var _alertVH = 520;           // 滚动视口高度(px)

function renderAlerts(filter) {
  var body = document.getElementById('alertsBody'); if (!body) return;
  var data = alertData.slice(); if (filter) data = data.filter(filter);
  _alertFilteredData = data;
  var uncleared = data.filter(function(a) { return !a.cleared });
  // 工具条 + 表头固定；表体为虚拟滚动容器：外层固定高+overflow滚动，
  // 内层 spacer 撑出 总行数×行高 的真实高度，rows 层绝对定位按滚动偏移平移。
  body.innerHTML = '<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center">' +
    '<input class="input" placeholder="搜索IP..." style="width:180px" id="alertSearch" oninput="renderAlertsFiltered()">' +
    '<select class="input" style="width:120px" id="alertRiskFilter" onchange="renderAlertsFiltered()"><option value="all">全部风险</option><option value="critical">严重</option><option value="warning">警告</option></select>' +
    '<button class="btn small danger" onclick="dismissAllAlerts()"><i class="fa-solid fa-trash-can"></i> 全部清除</button>' +
    '<button class="btn small" onclick="exportAlertCSV()"><i class="fa-solid fa-download"></i> 导出CSV</button>' +
    '<span style="font-size:9px;color:var(--text-dim);margin-left:auto">当前 <span style="color:var(--accent)">'+uncleared.length+'</span> 条活跃告警 · 共 '+data.length+' 条</span></div>' +
    '<table class="data-table" style="margin-bottom:0"><thead><tr>' +
      '<th style="width:22%">源IP</th><th style="width:22%">目标IP</th>' +
      '<th style="width:17%" onclick="sortAlerts(\'score\')">分数 <i class="fa-solid fa-sort"></i></th>' +
      '<th style="width:19%">风险等级</th><th style="width:20%">操作</th>' +
    '</tr></thead></table>' +
    '<div id="alertScroll" style="height:'+_alertVH+'px;overflow-y:auto;position:relative" onscroll="_onAlertScroll()">' +
      '<div id="alertSpacer" style="height:'+(data.length*_alertRowH)+'px;position:relative">' +
        '<table class="data-table" style="position:absolute;top:0;left:0;width:100%"><tbody id="alertRows"></tbody></table>' +
      '</div>' +
    '</div>';
  _fitAlertViewport();      // 按 body 实际剩余高度撑满滚动视口，消除下方留白
  _renderAlertWindow(0);
}

// 让告警滚动视口铺满页面剩余高度：用 #alertsBody 可用高度减去工具条+表头的占位。
function _fitAlertViewport() {
  var body = document.getElementById('alertsBody');
  var scroll = document.getElementById('alertScroll');
  if (!body || !scroll) return;
  var avail = body.clientHeight - scroll.offsetTop - 4;   // offsetTop 已含工具条与表头高度
  if (avail > 200) { _alertVH = avail; scroll.style.height = avail + 'px'; }
}

// 根据滚动位置渲染可见窗口内的行（绝对定位平移，表格列宽与表头百分比一致）
function _renderAlertWindow(scrollTop) {
  var rows = document.getElementById('alertRows'); if (!rows) return;
  var data = _alertFilteredData;
  var total = data.length;
  var start = Math.max(0, Math.floor(scrollTop / _alertRowH) - _alertBuffer);
  var visCount = Math.ceil(_alertVH / _alertRowH) + _alertBuffer * 2;
  var end = Math.min(total, start + visCount);
  var html = '';
  for (var i = start; i < end; i++) {
    var a = data[i];
    var rs = a.cleared ? 'opacity:0.35;text-decoration:line-through;' : '';
    var act = a.cleared ? '<span style="font-size:9px;color:var(--text-dim)">已清除</span>' : '<button class="btn small" style="padding:2px 6px;font-size:8px" onclick="dismissAlert(\''+a.id+'\')"><i class="fa-solid fa-check"></i> 清除</button>';
    var c = a.risk === 'critical' ? 'var(--danger)' : a.risk === 'warning' ? 'var(--warn)' : 'var(--normal)';
    var rl = a.risk === 'critical' ? '严重' : a.risk === 'warning' ? '警告' : '正常';
    html += '<tr style="'+rs+'height:'+_alertRowH+'px">' +
      '<td style="width:22%;color:'+(a.risk==='critical'?'var(--danger)':a.risk==='warning'?'var(--warn)':'var(--text)')+'">'+a.src+'</td>' +
      '<td style="width:22%">'+a.dst+'</td>' +
      '<td style="width:17%;color:'+c+'">'+alertScoreTxt(a)+'</td>' +
      '<td style="width:19%"><span style="color:'+c+'">'+rl+'</span></td>' +
      '<td style="width:20%">'+act+'</td></tr>';
  }
  // 用 translateY 把可见行平移到正确位置；表格挂在 spacer 内绝对定位层
  rows.parentNode.style.transform = 'translateY(' + (start * _alertRowH) + 'px)';
  rows.innerHTML = html;
}

var _alertScrollRaf = 0;
function _onAlertScroll() {
  if (_alertScrollRaf) return;   // rAF 节流：每帧最多渲一次，狂滚不掉帧
  _alertScrollRaf = requestAnimationFrame(function(){
    _alertScrollRaf = 0;
    var sc = document.getElementById('alertScroll');
    if (sc) _renderAlertWindow(sc.scrollTop);
  });
}

function renderAlertsFiltered() {
  var q = document.getElementById('alertSearch').value.toLowerCase();
  var risk = document.getElementById('alertRiskFilter').value;
  renderAlerts(function(a) { return (risk === 'all' || a.risk === risk) && (!q || a.src.toLowerCase().indexOf(q) >= 0 || a.dst.toLowerCase().indexOf(q) >= 0) });
}
function dismissAlert(id) { var a = alertData.find(function(x) { return x.id === id }); if (a) { a.cleared = true; renderAlertsFiltered(); showToast('告警已清除', 'success') } }
function dismissAllAlerts() { alertData.forEach(function(a) { a.cleared = true }); renderAlertsFiltered(); showToast('全部告警已清除', 'success') }
function sortAlerts(field) { alertData.sort(function(a, b) { if (field === 'score') return b.score - a.score; return 0 }); renderAlertsFiltered() }
function exportAlertCSV() {
  var csv = '时间,源IP,目标IP,异常分数,风险等级,已清除\n';
  alertData.forEach(function(a) { csv += [a.time, a.src, a.dst, alertScoreTxt(a), a.risk, a.cleared?'是':'否'].join(',') + '\n' });
  var blob = new Blob([csv], {type:'text/csv'}), url = URL.createObjectURL(blob);
  var aEl = document.createElement('a'); aEl.href = url; aEl.download = 'topinspect-告警报告.csv'; aEl.click();
  URL.revokeObjectURL(url); showToast('告警CSV已导出', 'success');
}

/* ═══ TOPOLOGY UPDATE ═══ */
function resetTopologyDisplay() {
  if (!topoNode) return;
  topoNode.attr('data-hidden','1').style('display','none').style('opacity',0);
  topoLink.attr('data-hidden','1').style('display','none').style('opacity',0);
}

function updateTopologyFromSnapshot(snap) {
  if (!topoNode) return;
  // 非 API 模式：无快照即清空。API 模式即使 snap 为 null（全量数据前期无流的帧）
  // 也要继续走下方 debut 逐帧点亮逻辑，否则节点会被隐藏、积压到有流的那帧一次性冒出。
  var apiMode = dataSource.mode === 'api' && window._apiNodes;
  if (!snap && !apiMode) { resetTopologyDisplay(); return; }
  var visibleIds = {};
  // API 模式：显示全部后端节点（44 个全量节点），不受回放帧 8000 采样限制。
  // 否则正常节点的流量被采样挤掉 → 不进 snap.nodes → 被误判隐藏，只剩告警节点。
  // 用前端分配的 debut 帧逐个点亮：当前帧 >= 节点 debut 才可见，恢复入场动画。
  if (apiMode) {
    // 出场判据用播放器位置 replayState.position（每帧平滑 +1，1→TOTAL），
    // 不能用 snap.currentStep：全量攻击流只集中在 step 147~286，currentStep 前期卡 0
    // 然后跳变，会导致一大批节点在某帧一起冒出。position 才能严格逐帧点亮。
    var curStep = replayState.position || 0;
    var debut = window._apiNodeDebut;
    window._apiNodes.forEach(function(n) {
      if (!debut || curStep >= (debut[n.id] || 1)) visibleIds[n.id] = true;
    });
  } else {
    snap.nodes.forEach(function(n) { visibleIds[n.id] = true; });
  }
  topoNode.each(function(d) {
    var g = d3.select(this);
    if (snap && snap.nodeStats && snap.nodeStats[d.id]) {
      g.attr('data-stats', JSON.stringify(snap.nodeStats[d.id]));
    }
    if (visibleIds[d.id]) {
      if (g.attr('data-hidden') === '1') {
        g.attr('data-hidden','0'); g.style('display','block');
        if (!reduceMotion && typeof gsap !== 'undefined') rT(gsap.fromTo(g.node(),{opacity:0,scale:0.3},{opacity:1,scale:1,duration:0.5,ease:'back.out(1.7)'}));
        else g.style('opacity',1);
      }
    } else { g.style('opacity',0).attr('data-hidden','1'); g.style('display','none'); }
  });
  topoLink.each(function(l) {
    var sid = typeof l.source==='object'?l.source.id:l.source;
    var tid = typeof l.target==='object'?l.target.id:l.target;
    var linkEl = d3.select(this);
    var ek = sid + '->' + tid;
    var ekr = tid + '->' + sid;
    var estats = (snap && snap.edgeFlowMap && (snap.edgeFlowMap[ek] || snap.edgeFlowMap[ekr])) ? (snap.edgeFlowMap[ek] || snap.edgeFlowMap[ekr]) : null;
    if (estats) linkEl.attr('data-flowstats', JSON.stringify(estats));
    if (visibleIds[sid] && visibleIds[tid]) {
      if (linkEl.attr('data-hidden')==='1') {
        linkEl.attr('data-hidden','0'); linkEl.style('display','block');
        if (!reduceMotion && typeof gsap!=='undefined') rT(gsap.fromTo(linkEl.node(),{opacity:0},{opacity:l.type==='attack'?0.85:l.type==='suspect'?0.6:0.5,duration:0.4,ease:'power2.out'}));
      }
    } else { linkEl.style('opacity',0).attr('data-hidden','1'); linkEl.style('display','none'); }
  });
}

/* ═══ STATS & STATUS UPDATE ═══ */
function updateStatsFromSnapshot(snap) {
  if (!snap) {
    ['ssFlows','ssAnomalies','lcFlows','lcAnomalies','ssLatency','lcLatency'].forEach(function(id){
      var el=document.getElementById(id); if(el) el.textContent='—';
    });
    return;
  }
  var flowsText = snap.totalFlows>=10000?(snap.totalFlows/10000).toFixed(1)+'万':snap.totalFlows.toLocaleString();
  document.getElementById('ssFlows').textContent=flowsText;
  document.getElementById('ssAnomalies').textContent=snap.totalAnomalies.toLocaleString();
  document.getElementById('lcFlows').textContent=flowsText;
  document.getElementById('lcAnomalies').textContent=snap.totalAnomalies.toLocaleString();
  // 延迟：api 模式优先用后端真实 latency；mock 模式用演示值
  var m = (dataSource.mode==='api') ? window._apiMetrics : null;
  var latText = m ? (Math.round(m.latencyMs||0)+'ms') : '--';
  document.getElementById('ssLatency').textContent=latText;
  var lcL=document.getElementById('lcLatency');
  if(lcL) lcL.textContent=latText;
}

function updateStatusBarsFromSnapshot(snap) {
  if (!snap) {
    document.getElementById('tNodes').textContent='0'; document.getElementById('tEdges').textContent='0';
    document.getElementById('bNext').textContent='--';
    var t0=document.getElementById('tThreat'); if(t0){ t0.textContent='待检测'; t0.style.color='var(--text-dim)'; }
    return;
  }
  // API 模式：节点/边数显示后端全量真值（与拓扑图显示的全量节点一致），非采样帧数。
  // 节点逐帧点亮 → 计数也随回放递增（只数已点亮的，curStep>=debut）。
  if (dataSource.mode === 'api' && window._apiNodes) {
    var cs = replayState.position || 0, db = window._apiNodeDebut;
    var shown = db ? window._apiNodes.filter(function(n){ return cs >= (db[n.id]||1); }).length : window._apiNodes.length;
    document.getElementById('tNodes').textContent=shown;
    document.getElementById('tEdges').textContent=(window._apiEdges?window._apiEdges.length:snap.edges.length);
  } else {
    document.getElementById('tNodes').textContent=snap.nodes.length;
    document.getElementById('tEdges').textContent=snap.edges.length;
  }
  document.getElementById('bNext').textContent='--';   // 无真实轮询周期，不显示假秒数
  var threatEl = document.getElementById('tThreat');
  if (threatEl) {
    var zh = snap.threatLevel==='CRITICAL'?'严重':snap.threatLevel==='ELEVATED'?'较高':'正常';
    threatEl.textContent = zh;
    threatEl.style.color = snap.threatLevel==='CRITICAL'?'#ff2d55':snap.threatLevel==='ELEVATED'?'#ff9500':'#3b82f6';
  }
  // 底部信息行威胁等级 chip
  var irT = document.getElementById('irThreat');
  if (irT) {
    var lvl = snap.threatLevel==='CRITICAL'?'critical':snap.threatLevel==='ELEVATED'?'elevated':'low';
    var lbl = lvl==='critical'?'严重':lvl==='elevated'?'较高':'正常';
    var ico = lvl==='critical'?'fa-triangle-exclamation':lvl==='elevated'?'fa-circle-exclamation':'fa-shield-halved';
    irT.className = 'threat-chip ' + lvl;
    irT.innerHTML = '<i class="fa-solid ' + ico + '"></i> ' + lbl;
  }
}

/* ═══ CHARTS ═══ */
var _ratioAnim = { current: -1, target: 0 };  // animation state
function _render2DRatio(snap, circle, numEl, labelEl) {
  if (!circle) circle = document.getElementById('ratioSvgCircle');
  if (!numEl) numEl = document.getElementById('ratioNumber');
  if (!labelEl) labelEl = document.getElementById('ratioLabel');
  if (!circle || !numEl || !labelEl) return;

  var anomalyPct = snap ? (snap.anomalyRatio || 0) : 0;
  anomalyPct = Math.max(0, Math.min(1, anomalyPct));

  if (!snap || (anomalyPct === 0 && (!snap.totalFlows || snap.totalFlows === 0))) {
    numEl.textContent = '--';
    labelEl.textContent = '等待数据...';
    circle.setAttribute('stroke-dashoffset', '251.32');
    circle.setAttribute('stroke', 'url(#neonGlowRatio)');
    return;
  }

  numEl.textContent = (anomalyPct * 100).toFixed(1) + '%';
  labelEl.textContent = (snap.totalFlows - snap.totalAnomalies).toLocaleString() + ' 正常 / ' + snap.totalAnomalies.toLocaleString() + ' 异常';

  // Use red gradient if anomalies exist
  if (anomalyPct > 0) {
    circle.setAttribute('stroke', 'url(#neonGlowRed)');
  } else {
    circle.setAttribute('stroke', 'url(#neonGlowRatio)');
  }

  var offset = 251.32 * (1 - anomalyPct);
  if (typeof gsap !== 'undefined') {
    gsap.to(circle, { attr: { 'stroke-dashoffset': offset }, duration: 0.8, ease: 'power2.out', overwrite: 'auto' });
  } else {
    circle.setAttribute('stroke-dashoffset', offset);
  }
}
/* ═══ 2D CANVAS CHARTS ═══ */
var _chartDims = {};
function _ensureChartDims(canvasId, W, H) {
  if (_chartDims[canvasId]) return _chartDims[canvasId];
  var canvas = document.getElementById(canvasId); if (!canvas) return null;
  var dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  var ctx = canvas.getContext('2d'); ctx.setTransform(1,0,0,1,0,0); ctx.scale(dpr, dpr);
  _chartDims[canvasId] = { W:W, H:H, ctx:ctx, canvas:canvas }; return _chartDims[canvasId];
}

function _render2DTimeline(snap, canvas) {
  if (!canvas) canvas = document.getElementById('chartTimeline'); if (!canvas) return;
  var dpr = window.devicePixelRatio || 1;
  var STEP = 7, PL = 4, PR = 4, PT = 6, PB = 14, H = 120;
  var W = canvas.parentElement.clientWidth;
  if (!snap || !snap.timelinePoints || !snap.timelinePoints.length) {
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    return;
  }
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  var ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  var ph = H - PT - PB;
  var pw = W - PL - PR;
  var pts = snap.timelinePoints;
  var visible, stepX;
  if (replayDone) {
    // 回放结束：定格显示完整时间线，把所有点等距铺满画布宽度
    visible = pts;
    stepX = pts.length > 1 ? pw / (pts.length - 1) : pw;
  } else {
    // 回放中：滑动窗口，固定 7px 间距，最新点在右侧
    var maxVisible = Math.floor(pw / STEP);
    var startIdx = Math.max(0, pts.length - maxVisible);
    visible = pts.slice(startIdx);
    stepX = STEP;
  }
  if (!visible.length) return;  // 容器宽度过小(如 HMR 重挂载/布局未就绪)时 → visible 为空，避免越界抛错
  var mx = 2;
  visible.forEach(function(p) { if (p.anomalies > mx) mx = p.anomalies; });
  // Grid lines
  ctx.strokeStyle = 'rgba(26,48,80,0.3)'; ctx.lineWidth = 0.5;
  for (var yi = 0; yi <= 3; yi++) { var y = PT + ph * (1 - yi / 3); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  // 完整模式：点从左铺到右，间距 stepX；滑动模式：左对齐 + STEP/2 居中
  function _px(i) { return replayDone ? (PL + i * stepX) : (PL + i * stepX + STEP / 2); }
  // Gradient fill — map visible points to fixed pixel positions
  var grad = ctx.createLinearGradient(0, PT, 0, PT + ph);
  grad.addColorStop(0, 'rgba(255,149,0,0.6)'); grad.addColorStop(1, 'rgba(255,149,0,0.02)');
  ctx.beginPath();
  visible.forEach(function(p, i) { var x = _px(i), y = PT + ph * (1 - p.anomalies / mx); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
  var lastX = _px(visible.length - 1), lastY = PT + ph * (1 - visible[visible.length - 1].anomalies / mx);
  ctx.lineTo(lastX, PT + ph); ctx.lineTo(_px(0), PT + ph); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  // Line
  ctx.strokeStyle = '#ff9500'; ctx.lineWidth = 1.3;
  ctx.beginPath();
  visible.forEach(function(p, i) { var x = _px(i), y = PT + ph * (1 - p.anomalies / mx); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
  if(visible.length===1){ var p=visible[0]; var px=_px(0), py=PT+ph*(1-p.anomalies/mx); ctx.arc(px,py,1.5,0,Math.PI*2); ctx.fill(); } else { ctx.stroke(); }
  // Glow
  ctx.shadowColor = '#ff9500'; ctx.shadowBlur = 6;
  ctx.strokeStyle = 'rgba(255,149,0,0.5)'; ctx.lineWidth = 3;
  ctx.beginPath();
  visible.forEach(function(p, i) { var x = _px(i), y = PT + ph * (1 - p.anomalies / mx); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
  if(visible.length===1){ var p=visible[0]; var px=_px(0), py=PT+ph*(1-p.anomalies/mx); ctx.arc(px,py,1.5,0,Math.PI*2); ctx.fill(); } else { ctx.stroke(); }
  ctx.shadowBlur = 0;
  // Y 轴刻度标签：峰值 / 中值 / 0（异常数）
  ctx.fillStyle = 'rgba(140,170,200,0.65)';
  ctx.font = '8px "JetBrains Mono", monospace';
  ctx.textAlign = 'left';
  ctx.fillText(String(mx), 2, PT + 7);
  ctx.fillText(String(Math.round(mx/2)), 2, PT + ph/2 + 3);
  ctx.fillText('0', 2, PT + ph);
  // 末点高亮圆点（当前/最新时间步）
  if (visible.length > 1) {
    var lp = visible[visible.length-1];
    ctx.beginPath();
    ctx.fillStyle = '#ff9500';
    ctx.shadowColor = '#ff9500'; ctx.shadowBlur = 8;
    ctx.arc(_px(visible.length-1), PT + ph*(1 - lp.anomalies/mx), 2.6, 0, Math.PI*2);
    ctx.fill(); ctx.shadowBlur = 0;
  }
}

function _render2DDist(snap, canvas) {
  if (!canvas) canvas = document.getElementById('chartScoreDist'); if (!canvas) return;
  // 自适应父容器宽度（原来写死 230 会变形）；高度 120（与放大后的 .mini-chart 一致）。
  var dpr = window.devicePixelRatio || 1;
  var W = Math.max(120, (canvas.parentElement ? canvas.parentElement.clientWidth : 230) - 20), H = 120;
  canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.width = '100%'; canvas.style.height = H + 'px';
  var ctx = canvas.getContext('2d'); ctx.setTransform(1,0,0,1,0,0); ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  // API 模式：用后端「score/阈值」倍数分布(0→2 十档)。前端 snap.scoreBins 是拿
  // 原始重构误差分数(0.008~0.015)分桶的，会全挤进桶[0]→图只剩最左一根细条(像没图)。
  var bins = (dataSource.mode === 'api' && window._apiScoreDist) ? window._apiScoreDist : (snap && snap.scoreBins);
  if (!bins || !bins.length) return;   // 无真实数据则不画（不画占位假图）
  var nBins = bins.length;
  var pl = 26, pr = 4, pt = 6, pb = 14, pw = W - pl - pr, ph = H - pt - pb, bw = pw / nBins;
  // 数据极度不均衡：正常流量(如221万)集中在低分档，异常流(几万)在高分档。
  // 线性尺度下最高档撑爆 Y 轴、其它档压成 <1 像素看不见。改用 log 尺度让每档都可见。
  var logH = function(c){ return c > 0 ? Math.log10(c + 1) : 0; };
  var mx = 1;
  bins.forEach(function(b) { var s = logH(b.normal) ; var a = logH(b.anomaly); if (s > mx) mx = s; if (a > mx) mx = a; });
  var maxCount = 2;
  bins.forEach(function(b){ var t=b.normal+b.anomaly; if(t>maxCount) maxCount=t; });
  // 每根柱整根一个颜色，按「桶内最严重级别」定色（与拓扑节点/告警列表同规则：取最严重一条）：
  //   桶内出现 ≥1.25× 严重流 → 红；有异常流但都 <1.25× → 橙；只有正常流 → 蓝。
  // 柱高 = 该分数区间内流总数（log 尺度）。图例「正常/警告/严重」对应 X 轴 0→1×→1.25×→2× 三段。
  for (var k = 0; k < nBins; k++) {
    var x = pl + k * bw;
    var total = (bins[k].normal || 0) + (bins[k].anomaly || 0);
    if (total <= 0) continue;
    var bh = (logH(total)/mx)*ph;
    var col = (bins[k].critical || 0) > 0 ? '255,45,85' : (bins[k].anomaly || 0) > 0 ? '255,149,0' : '59,130,246';
    var grad = ctx.createLinearGradient(x, pt+ph-bh, x, pt+ph);
    grad.addColorStop(0, 'rgba('+col+',0.9)'); grad.addColorStop(1, 'rgba('+col+',0.3)');
    ctx.fillStyle = grad; ctx.fillRect(x, pt+ph-bh, bw-1, bh);
  }
  // Y 轴刻度（log 尺度，标注实际最大计数）
  ctx.fillStyle = 'rgba(140,170,200,0.65)';
  ctx.font = '8px "JetBrains Mono", monospace';
  ctx.textAlign = 'left';
  ctx.fillText(maxCount >= 1000 ? (maxCount/1000).toFixed(0)+'k' : String(maxCount), 2, pt + 7);
  ctx.fillText('log', 2, pt + ph/2 + 3);
  ctx.fillText('0', 2, pt + ph);
  // 阈值参考线（api 模式，X 轴=score/阈值倍数，范围 0→2）：1×=异常界、1.25×=严重界，与分级规则同尺
  var isApiDist = dataSource.mode === 'api' && window._apiScoreDist;
  if (isApiDist) {
    ctx.setLineDash([3,3]);
    ctx.strokeStyle = 'rgba(255,149,0,0.7)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pl + pw*0.5, pt); ctx.lineTo(pl + pw*0.5, pt+ph); ctx.stroke();
    ctx.fillStyle = 'rgba(255,149,0,0.85)'; ctx.font = '7px "JetBrains Mono", monospace'; ctx.textAlign = 'left';
    ctx.fillText('1×', pl + pw*0.5 + 2, pt + 7);
    ctx.strokeStyle = 'rgba(255,45,85,0.8)';
    ctx.beginPath(); ctx.moveTo(pl + pw*0.625, pt); ctx.lineTo(pl + pw*0.625, pt+ph); ctx.stroke();
    ctx.fillStyle = 'rgba(255,45,85,0.9)';
    ctx.fillText('1.25×', pl + pw*0.625 + 2, pt + 14);
    ctx.setLineDash([]);
  }
  // X 轴标签：api=倍数 0/1×/2×；mock=0/0.5/1
  ctx.textAlign = 'center';
  if (isApiDist) {
    ctx.fillText('0', pl, H - 3);
    ctx.fillText('1×', pl + pw/2, H - 3);
    ctx.fillText('2×', pl + pw, H - 3);
  } else {
    ctx.fillText('0', pl, H - 3);
    ctx.fillText('0.5', pl + pw/2, H - 3);
    ctx.fillText('1', pl + pw, H - 3);
  }
}

function updateChartsFromSnapshot(snap) {
  setTimeout(function() {
    _render2DRatio(snap);
    _render2DTimeline(snap);
    _render2DDist(snap);
  }, 100);
}

/* 侧栏点击放大/还原后，按新容器宽度重绘右侧图表（canvas 自适应父容器宽） */
function refreshCharts(){ updateChartsFromSnapshot(currentSnapshot) }

/* 供「模块放大」把当前快照重绘进克隆出的 canvas/SVG（原件保持原位不动）。
   targets: { timeline: canvas, dist: canvas, ratio: { circle, number, label } } */
function renderSnapshotInto(targets) {
  setTimeout(function() {
    var snap = currentSnapshot
    if (!snap || !targets) return
    if (targets.timeline) _render2DTimeline(snap, targets.timeline)
    if (targets.dist) _render2DDist(snap, targets.dist)
    if (targets.ratio) _render2DRatio(snap, targets.ratio.circle, targets.ratio.number, targets.ratio.label)
  }, 120)
}

/* ═══ DASHBOARD ═══ */
function hasDetectionData(){ return dataSource && dataSource.mode==='api' && dataSource.jobId && window._apiMetrics; }
function pageEmptyHtml(title){
  return '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:60vh;gap:14px;font-family:var(--font-mono);text-align:center">' +
    '<div style="width:80px;height:80px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:28px;color:var(--accent);border:1px solid var(--glass-border-active);background:radial-gradient(circle,rgba(0,212,255,0.10),transparent 70%);box-shadow:0 0 36px rgba(0,212,255,0.16)"><i class="fa-solid fa-satellite-dish"></i></div>' +
    '<div style="font-size:15px;letter-spacing:2px;color:var(--text-bright)">'+(title||'暂无数据')+'</div>' +
    '<div style="font-size:10px;color:var(--text-dim);letter-spacing:1px">请先在拓扑页运行检测，结果将在此呈现</div>' +
    '<button class="btn" onclick="navigateTo(\'topology\')"><i class="fa-solid fa-play"></i> 去运行检测</button></div>';
}
function renderDashboard() {
  var body = document.getElementById('dashboardBody'); if (!body) return;
  if (!hasDetectionData()) { body.innerHTML = pageEmptyHtml('指挥中心 · 暂无数据'); return; }
  var st = modelRunState;
  var totalFlows = st.flows||0, anomalies = st.anomalies||0;
  var rate = totalFlows? (anomalies/totalFlows*100).toFixed(2):'0.00';
  body.innerHTML = '<div class="stat-grid" style="grid-template-columns:repeat(3,1fr)">' +
    '<div class="stat-card"><div class="sc-icon"><i class="fa-solid fa-network-wired"></i></div><div class="sc-value" style="color:var(--accent)">'+totalFlows.toLocaleString()+'</div><div class="sc-label">总流量</div></div>' +
    '<div class="stat-card"><div class="sc-icon"><i class="fa-solid fa-bug"></i></div><div class="sc-value" style="color:var(--warn)">'+anomalies.toLocaleString()+'</div><div class="sc-label">异常检测</div></div>' +
    '<div class="stat-card"><div class="sc-icon"><i class="fa-solid fa-percent"></i></div><div class="sc-value" style="color:var(--warn)">'+rate+'%</div><div class="sc-label">异常率</div></div></div>' +
    '<div style="display:flex;gap:10px;margin-bottom:16px">' +
    '<div class="panel" style="flex:1"><div class="panel-header"><i class="fa-solid fa-chart-area"></i> 异常时间线</div><canvas id="chartDashTimeline" style="width:100%;height:340px"></canvas></div>' +
    '<div class="panel" style="flex:1"><div class="panel-header"><i class="fa-solid fa-chart-bar"></i> 分数分布</div><canvas id="chartDashScoreDist" style="width:100%;height:340px"></canvas></div></div>' +
    '<div style="display:flex;gap:10px">' +
    '<div class="panel" style="width:280px;display:flex;flex-direction:column;align-items:center"><div class="panel-header"><i class="fa-solid fa-chart-pie"></i> 占比</div><canvas id="chartDashRatio" style="width:220px;height:220px"></canvas><div style="font-size:13px;color:var(--text-dim);text-align:center;margin-top:8px">'+(totalFlows-anomalies).toLocaleString()+' 正常<br>'+anomalies.toLocaleString()+' 异常</div></div>' +
    '<div class="panel" style="flex:1"><div class="panel-header"><i class="fa-solid fa-ranking-star"></i> 异常源IP排行</div><div style="font-size:9px;font-family:var(--font-mono)" id="topAnomalyIPs"></div></div></div>';
  setTimeout(function() {
    // 仪表盘三图：优先用当前回放快照；若回放停在 0 步则用全量流量兜底（保证有真实数据）
    var snap = currentSnapshot;
    if (!snap && allFlows && allFlows.length) {
      var all = []; for (var k = 0; k < allFlows.length; k++) all.push(allFlows[k]);
      snap = computeSnapshot(all);
    }
    renderDashCharts(snap);
    // 异常源IP排行：从真实拓扑节点按异常数排序
    var nodes = (window._apiNodes||[]).slice().sort(function(a,b){return (b.anomalyCount||0)-(a.anomalyCount||0)});
    var el = document.getElementById('topAnomalyIPs');
    if (el) el.innerHTML = nodes.slice(0,8).map(function(n,i) {
      var color = n.risk==='critical'?'var(--danger)':n.risk==='warning'?'var(--warn)':'var(--text-dim)';
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(26,48,80,0.3)"><span style="color:var(--text-dim);min-width:20px">'+(i+1)+'.</span><span>'+n.ip+'</span><span style="color:'+color+';min-width:90px;text-align:right;font-weight:700">'+(n.anomalyCount||0)+' 异常</span></div>';
    }).join('') || '<div style="color:var(--text-dim);padding:10px">无异常节点</div>';
  }, 200);
}

// 仪表盘三图绘制：异常时间线 / 分数分布 / 占比环。数据全部来自 snapshot（真实检测结果）。
function _dashCanvas(id, h) {
  var cv = document.getElementById(id); if (!cv) return null;
  var dpr = window.devicePixelRatio || 1;
  var w = cv.parentElement.clientWidth - 28; if (w <= 0) w = 300;
  cv.width = w * dpr; cv.height = h * dpr; cv.style.width = w + 'px'; cv.style.height = h + 'px';
  var ctx = cv.getContext('2d'); ctx.setTransform(1,0,0,1,0,0); ctx.scale(dpr, dpr); ctx.clearRect(0,0,w,h);
  return { ctx: ctx, w: w, h: h };
}
function renderDashCharts(snap) {
  if (!snap) return;
  // —— 异常时间线（面积折线）——
  var d1 = _dashCanvas('chartDashTimeline', 340);
  if (d1) {
    var ctx = d1.ctx, W = d1.w, H = d1.h, pl = 36, pr = 12, pt = 12, pb = 24;
    var pts = snap.timelinePoints || [], pw = W - pl - pr, ph = H - pt - pb;
    var mx = 2; pts.forEach(function(p){ if (p.anomalies > mx) mx = p.anomalies; });
    ctx.strokeStyle = 'rgba(26,48,80,0.4)'; ctx.lineWidth = 0.5; ctx.fillStyle = cssColor('--text-dim', '#5a6e85'); ctx.font = '9px "JetBrains Mono"';
    for (var yi = 0; yi <= 4; yi++) { var y = pt + ph*yi/4; ctx.beginPath(); ctx.moveTo(pl,y); ctx.lineTo(pl+pw,y); ctx.stroke(); ctx.textAlign='right'; ctx.fillText(Math.round(mx*(1-yi/4)), pl-6, y+3); }
    ctx.fillStyle = cssColor('--text-dim', '#8aa0b8'); ctx.font = '10px "Inter"'; ctx.textAlign = 'center';
    ctx.fillText('回放步 (step) →', pl+pw/2, H-6);
    if (pts.length) {
      var grad = ctx.createLinearGradient(0, pt, 0, pt+ph);
      grad.addColorStop(0,'rgba(255,149,0,0.5)'); grad.addColorStop(1,'rgba(255,149,0,0.02)');
      ctx.beginPath();
      pts.forEach(function(p,i){ var x = pl + pw*i/(pts.length-1||1), y = pt+ph*(1-p.anomalies/mx); i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
      ctx.lineTo(pl+pw, pt+ph); ctx.lineTo(pl, pt+ph); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
      ctx.beginPath(); ctx.strokeStyle = '#ff9500'; ctx.lineWidth = 2; ctx.shadowColor='rgba(255,149,0,0.6)'; ctx.shadowBlur=6;
      pts.forEach(function(p,i){ var x = pl + pw*i/(pts.length-1||1), y = pt+ph*(1-p.anomalies/mx); i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); });
      ctx.stroke(); ctx.shadowBlur = 0;
    }
  }
  // —— 分数分布（每根柱单色，按桶内最严重级别：正常蓝 / 警告橙 / 严重红）——
  var d2 = _dashCanvas('chartDashScoreDist', 340);
  if (d2) {
    var c2 = d2.ctx, W2 = d2.w, H2 = d2.h, pl2 = 36, pr2 = 12, pt2 = 12, pb2 = 28;
    // 与拓扑页小图一致：API 模式用后端「score/阈值 倍数」分布，log 尺度（数据极不均衡）。
    var bins = (dataSource.mode === 'api' && window._apiScoreDist) ? window._apiScoreDist : (snap.scoreBins || []);
    var n = bins.length, pw2 = W2-pl2-pr2, ph2 = H2-pt2-pb2, bw = pw2/(n||1);
    var logH2 = function(c){ return c > 0 ? Math.log10(c + 1) : 0; };
    var mx2 = 1, maxCount2 = 2;
    bins.forEach(function(b){ var s=logH2(b.normal), a=logH2(b.anomaly); if(s>mx2)mx2=s; if(a>mx2)mx2=a; var t=b.normal+b.anomaly; if(t>maxCount2)maxCount2=t; });
    c2.strokeStyle = 'rgba(26,48,80,0.4)'; c2.lineWidth = 0.5; c2.fillStyle = cssColor('--text-dim', '#5a6e85'); c2.font = '9px "JetBrains Mono"';
    for (var yi2 = 0; yi2 <= 4; yi2++) { var y2 = pt2+ph2*yi2/4; c2.beginPath(); c2.moveTo(pl2,y2); c2.lineTo(pl2+pw2,y2); c2.stroke(); c2.textAlign='right'; var lblv=Math.round(Math.pow(10, mx2*(1-yi2/4))-1); c2.fillText(lblv>=1000?(lblv/1000).toFixed(0)+'k':lblv, pl2-6, y2+3); }
    // 每根柱整根一个颜色，按「桶内最严重级别」定色（与拓扑/告警同规则：取最严重一条）
    for (var k = 0; k < n; k++) {
      var x = pl2 + k*bw;
      var total = (bins[k].normal||0) + (bins[k].anomaly||0);
      if (total <= 0) continue;
      var bh = (logH2(total)/mx2)*ph2;
      c2.fillStyle = (bins[k].critical||0) > 0 ? 'rgba(255,45,85,0.85)' : (bins[k].anomaly||0) > 0 ? 'rgba(255,149,0,0.8)' : 'rgba(59,130,246,0.7)';
      c2.fillRect(x, pt2+ph2-bh, bw-2, bh);
    }
    // 阈值参考线（api：X 轴=score/阈值倍数 0→2，1× 异常界 / 1.25× 严重界）
    if (dataSource.mode === 'api' && window._apiScoreDist) {
      c2.setLineDash([3,3]);
      c2.strokeStyle = 'rgba(255,149,0,0.7)'; c2.lineWidth = 1;
      c2.beginPath(); c2.moveTo(pl2+pw2*0.5, pt2); c2.lineTo(pl2+pw2*0.5, pt2+ph2); c2.stroke();
      c2.fillStyle = 'rgba(255,149,0,0.9)'; c2.font = '8px "JetBrains Mono"'; c2.textAlign = 'left';
      c2.fillText('1× 警告', pl2+pw2*0.5+3, pt2+9);
      c2.strokeStyle = 'rgba(255,45,85,0.8)';
      c2.beginPath(); c2.moveTo(pl2+pw2*0.625, pt2); c2.lineTo(pl2+pw2*0.625, pt2+ph2); c2.stroke();
      c2.fillStyle = 'rgba(255,45,85,0.95)';
      c2.fillText('1.25× 严重', pl2+pw2*0.625+3, pt2+20);
      c2.setLineDash([]);
    }
    c2.fillStyle = cssColor('--text-dim', '#8aa0b8'); c2.font = '10px "Inter"'; c2.textAlign = 'center';
    c2.fillText((dataSource.mode === 'api' && window._apiScoreDist) ? '异常分数 = score/阈值（倍）0 → 2 · 对数计数' : '异常分数 0 → 1（归一化，对数计数）', pl2+pw2/2, H2-8);
    // 图例
    c2.textAlign = 'left'; c2.font = '9px "Inter"';
    c2.fillStyle = 'rgba(59,130,246,0.7)'; c2.fillRect(pl2, 2, 9, 9); c2.fillStyle=cssColor('--text-dim', '#8aa0b8'); c2.fillText('正常', pl2+13, 10);
    c2.fillStyle = 'rgba(255,149,0,0.8)'; c2.fillRect(pl2+50, 2, 9, 9); c2.fillStyle=cssColor('--text-dim', '#8aa0b8'); c2.fillText('警告', pl2+63, 10);
    c2.fillStyle = 'rgba(255,45,85,0.85)'; c2.fillRect(pl2+96, 2, 9, 9); c2.fillStyle=cssColor('--text-dim', '#8aa0b8'); c2.fillText('严重', pl2+109, 10);
  }
  // —— 占比环 ——
  var d3 = _dashCanvas('chartDashRatio', 220);
  if (d3) {
    var c3 = d3.ctx, W3 = d3.w, H3 = d3.h, cx = W3/2, cy = H3/2, r = Math.min(W3,H3)/2 - 12;
    var ratio = Math.max(0, Math.min(1, snap.anomalyRatio || 0));
    c3.lineWidth = 12; c3.lineCap = 'round';
    c3.beginPath(); c3.arc(cx, cy, r, 0, Math.PI*2); c3.strokeStyle = 'rgba(0,212,255,0.12)'; c3.stroke();
    if (ratio > 0) {
      c3.beginPath(); c3.arc(cx, cy, r, -Math.PI/2, -Math.PI/2 + Math.PI*2*ratio);
      c3.strokeStyle = '#ff9500'; c3.shadowColor = 'rgba(255,149,0,0.6)'; c3.shadowBlur = 10; c3.stroke(); c3.shadowBlur = 0;
    }
    c3.fillStyle = cssColor('--text-bright', '#e8f4ff'); c3.font = 'bold 22px "JetBrains Mono"'; c3.textAlign = 'center';
    c3.fillText((ratio*100).toFixed(1)+'%', cx, cy+4);
    c3.fillStyle = cssColor('--text-dim', '#5a6e85'); c3.font = '9px "Inter"'; c3.fillText('异常占比', cx, cy+20);
  }
}

function renderReportTab() {
  var body = document.getElementById('reportsBody'); if (!body) return;
  if (!hasDetectionData()) { body.innerHTML = pageEmptyHtml('分析报告 · 暂无数据'); return; }
  var st = modelRunState;
  var totalFlows = st.flows||0, anomalies = st.anomalies||0;
  var rate = totalFlows? (anomalies/totalFlows*100).toFixed(2):'0.00';
  var summary = '基于数据集 <span style="color:var(--accent)">NF-UNSW-NB15-v3</span> 完成真实检测。总流量: <span style="color:var(--accent)">'+totalFlows.toLocaleString()+'</span>，检测异常: <span style="color:var(--warn)">'+anomalies.toLocaleString()+'</span>（异常率'+rate+'%）。';
  body.innerHTML = '<div class="panel" style="border-color:rgba(0,212,255,0.2);margin-bottom:16px"><div class="panel-header"><i class="fa-solid fa-file-lines"></i> 分析摘要</div><div style="font-size:11px;line-height:1.8;color:var(--text);font-family:var(--font-body)">'+summary+'</div></div>' +
    '<div class="stat-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:16px">' +
    '<div class="stat-card"><div class="sc-value" style="color:var(--accent);font-size:18px">NF-UNSW-NB15</div><div class="sc-label">数据集</div></div>' +
    '<div class="stat-card"><div class="sc-value" style="color:var(--accent);font-size:18px">'+totalFlows.toLocaleString()+'</div><div class="sc-label">检测流量</div></div>' +
    '<div class="stat-card"><div class="sc-value" style="color:var(--warn);font-size:18px">'+anomalies.toLocaleString()+'</div><div class="sc-label">检测异常</div></div>' +
    '<div class="stat-card"><div class="sc-value" style="color:var(--warn);font-size:18px">'+rate+'%</div><div class="sc-label">异常率</div></div></div>';
}

/* ═══ UPLOAD ═══ */
/* ═══ 上传历史（localStorage 本地持久化，纯前端，不涉及后端）═══ */
var UPLOAD_HISTORY_KEY = 'topinspect_upload_history';
function _loadUploadHistory() {
  try { return JSON.parse(localStorage.getItem(UPLOAD_HISTORY_KEY)) || []; }
  catch (e) { return []; }
}
function _saveUploadHistory(list) {
  try { localStorage.setItem(UPLOAD_HISTORY_KEY, JSON.stringify(list.slice(0, 50))); } catch (e) {}
}
// 新增一条记录，返回其 id（供后续更新状态）。最新的排在最前。
function addUploadHistory(name, sizeMB) {
  var list = _loadUploadHistory();
  var rec = { id: 'u' + Date.now() + Math.floor(Math.random()*1000),
              name: name, size: sizeMB, status: 'detecting', anomalies: null,
              date: new Date().toLocaleString('zh-CN', { hour12: false }) };
  list.unshift(rec);
  _saveUploadHistory(list);
  renderUploadHistory();
  return rec.id;
}
// 更新某条记录的状态：'done'（带异常数）或 'error'。
function updateUploadHistory(id, status, anomalies) {
  if (!id) return;
  var list = _loadUploadHistory();
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) { list[i].status = status; if (anomalies != null) list[i].anomalies = anomalies; break; }
  }
  _saveUploadHistory(list);
  renderUploadHistory();
}
function clearUploadHistory() {
  _saveUploadHistory([]);
  renderUploadHistory();
  showToast('<i class="fa-solid fa-trash-can"></i> 已清空上传历史', 'info');
}
// 把历史渲染进上传页表格 body（#uploadHistoryBody）。不在上传页时静默跳过。
function renderUploadHistory() {
  var tb = document.getElementById('uploadHistoryBody');
  if (!tb) return;
  var list = _loadUploadHistory();
  if (!list.length) {
    tb.innerHTML = '<tr><td style="color:var(--text-dim)" colspan="4">暂无上传记录。</td></tr>';
    return;
  }
  tb.innerHTML = list.map(function(r) {
    var stColor = r.status === 'done' ? 'var(--safe)' : r.status === 'error' ? 'var(--danger)' : 'var(--warn)';
    var stText = r.status === 'done' ? ('完成' + (r.anomalies != null ? '（异常 ' + Number(r.anomalies).toLocaleString() + '）' : ''))
               : r.status === 'error' ? '失败' : '检测中';
    return '<tr>' +
      '<td style="color:var(--text)">' + r.name + '</td>' +
      '<td style="color:var(--text-dim)">' + r.size + ' MB</td>' +
      '<td style="color:' + stColor + '">' + stText + '</td>' +
      '<td style="color:var(--text-dim)">' + r.date + '</td></tr>';
  }).join('');
}

function initUploadHandlers() {
  var body = document.getElementById('uploadBody'); if (!body) return;
  // 去掉 _inited 守卫：路由再次进入上传页时也要重新渲染，否则可能空白。重复渲染无副作用。
  body.innerHTML = '<div class="upload-zone" id="uploadZone" style="margin-bottom:20px"><div class="uz-icon"><i class="fa-solid fa-cloud-arrow-up"></i></div><div class="uz-text">拖放 NetFlow CSV 文件到此处</div><div class="uz-hint">或点击浏览。支持 .csv 文件，最大 2GB。</div><input type="file" id="fileInput" accept=".csv" style="display:none" onchange="handleFileSelect(event)"></div>' +
    '<div class="panel" style="margin-bottom:20px"><div class="panel-header"><i class="fa-solid fa-list-check"></i> 上传队列</div><div id="fileQueue" style="font-size:10px;color:var(--text-dim)">未选择文件。</div>' +
    '<button class="btn" onclick="startUploadDetection()" style="width:100%;margin-top:12px"><i class="fa-solid fa-play"></i> 开始检测</button></div>' +
    '<div class="panel"><div class="panel-header" style="display:flex;align-items:center;justify-content:space-between"><span><i class="fa-solid fa-clock-rotate-left"></i> 上传历史</span><button class="btn small" onclick="clearUploadHistory()" style="font-size:9px;padding:3px 8px"><i class="fa-solid fa-trash-can"></i> 清空历史</button></div><table class="data-table"><thead><tr><th>文件</th><th>大小</th><th>状态</th><th>日期</th></tr></thead><tbody id="uploadHistoryBody"><tr><td style="color:var(--text-dim)" colspan="4">暂无上传记录。</td></tr></tbody></table></div>';
  var zone = document.getElementById('uploadZone'), input = document.getElementById('fileInput');
  if (zone && input) { zone.addEventListener('click', function() { input.click() }); zone.addEventListener('dragover', function(e) { e.preventDefault() }); zone.addEventListener('dragleave', function() {}); zone.addEventListener('drop', function(e) { e.preventDefault(); handleFiles(e.dataTransfer.files) }) }
  renderUploadHistory();   // 挂载/切回上传页时从 localStorage 恢复历史
}
function handleFileSelect(event) { if (event.target.files.length) { handleFiles(event.target.files); handleUploadFile(event); } }
function handleFiles(files) { var el = document.getElementById('fileQueue'); if (el) el.innerHTML = Array.from(files).map(function(f) { return '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)"><span style="color:var(--text)">'+f.name+'</span><span style="color:var(--text-dim)">'+(f.size/1024/1024).toFixed(1)+' MB</span></div>' }).join('') }
function handleUploadFile(event) {
  if (!event.target.files.length) return;
  var f = event.target.files[0];
  // uploadFileName 仅存在于左面板；上传页没有该元素，需容错避免 null 崩溃中断 onchange。
  var nameEl = document.getElementById('uploadFileName');
  if (nameEl) { nameEl.textContent = f.name + ' (' + (f.size/1024/1024).toFixed(1) + ' MB)'; nameEl.style.color = 'var(--accent)'; }
}
function showDetectHud(){var h=document.getElementById('detectHud');if(h)h.classList.add('show');var e=document.getElementById('dhErr');if(e)e.textContent='';}
function hideDetectHud(){var h=document.getElementById('detectHud');if(h)h.classList.remove('show');}
function updateDetectHud(stage, pct, rows, total){
  var _g=function(id){return document.getElementById(id);};
  var fill=_g('dhFill'); if(fill) fill.style.width = pct + '%';
  var pctEl=_g('dhPct'); if(pctEl) pctEl.textContent = Math.round(pct) + '%';
  var labelMap = {'解析数据流':'解析数据流','神经网络推理':'神经网络推理','构建威胁图谱':'构建威胁图谱','done':'检测完成','error':'检测失败','queued':'排队中'};
  var stEl=_g('dhStage'); if(stEl) stEl.textContent = labelMap[stage] || stage;
  if (rows) { var rEl=_g('dhRows'); if(rEl) rEl.textContent = '已分析 ' + Number(rows).toLocaleString() + ' / ' + Number(total).toLocaleString() + ' 条'; }
  var order = ['解析数据流','神经网络推理','构建威胁图谱','done'];
  document.querySelectorAll('.dh-stage').forEach(function(el){
    var st = el.getAttribute('data-st');
    el.classList.remove('active','done');
    if (order.indexOf(st) < order.indexOf(stage)) el.classList.add('done');
    else if (st === stage) el.classList.add('active');
  });
}

async function startUploadDetection() {
  // 防重入：检测进行中再次点击会并发建第二个 job 并覆盖共享的 dataSource.jobId，
  // 导致前一次的「done」回调拿错 jobId 拉到未就绪的 job → 404「拉取失败」。
  if (window._detectionRunning) {
    showToast('<i class="fa-solid fa-spinner fa-spin"></i> 检测进行中，请稍候…', 'info');
    return;
  }
  // 文件来自上传页(#fileInput)。左面板上传卡已移除，fi1 恒为 null（保留容错以兼容旧缓存页面）。
  var fi1 = document.getElementById('uploadFileInput');
  var fi2 = document.getElementById('fileInput');
  var fileInput = (fi1 && fi1.files && fi1.files.length) ? fi1
                : (fi2 && fi2.files && fi2.files.length) ? fi2 : null;
  // 立即取出 File 对象：跳转拓扑页会卸载上传页组件、销毁 input，之后再读 .files 会丢文件。
  var theFile = fileInput ? fileInput.files[0] : null;
  var hasFile = !!theFile;
  // 示例数据已移除：必须上传 CSV 才能检测。
  if (!hasFile) {
    showToast('<i class="fa-solid fa-circle-info"></i> 请先选择并上传 NetFlow CSV 文件', 'info');
    if (typeof navigateTo === 'function') navigateTo('upload');
    return;
  }
  // 检测进度 HUD、图谱容器都在拓扑页。若当前不在拓扑页（如从上传页发起），
  // 先跳转并轮询等待 DOM 渲染出 #detectHud，否则 showDetectHud 读不到会崩。
  if (typeof currentPage !== 'undefined' && currentPage !== 'topology') {
    if (typeof navigateTo === 'function') navigateTo('topology');
    for (var _w = 0; _w < 30 && !document.getElementById('detectHud'); _w++) {
      await new Promise(function(r){ setTimeout(r, 50); });
    }
  }
  showDetectHud();
  updateDetectHud('解析数据流', 5, 0, 0);
  window._detectionRunning = true;
  // 上传即记录一条历史（状态“检测中”），检测完成/失败后再更新其状态。
  var _histId = addUploadHistory(theFile.name, (theFile.size/1024/1024).toFixed(1));
  try {
    // 1) 建 job（仅上传文件）
    var resp, total;
    var fd = new FormData(); fd.append('file', theFile);
    resp = await fetch(API_BASE + '/api/jobs', { method:'POST', body:fd });
    if (!resp.ok) {
      var err = await resp.json().catch(function(){return {};});
      throw new Error(err.error ? (err.error + '：缺 ' + (err.missing||[]).slice(0,5).join(', ')) : ('请求失败 ' + resp.status));
    }
    var job = await resp.json();
    total = job.total_rows;
    dataSource.mode = 'api'; dataSource.jobId = job.job_id;
    window._apiJobId = job.job_id;   // 供分析报告页调用 /report 接口
    currentModel = 'improved';       // 新 job 默认看优化后模型

    // 2) SSE 监听真实进度
    await new Promise(function(resolve, reject){
      var es = new EventSource(API_BASE + '/api/jobs/' + job.job_id + '/progress');
      es.onmessage = function(ev){
        var st = JSON.parse(ev.data);
        updateDetectHud(st.stage, st.pct, st.rows_done, total);
        if (st.stage === 'done') { es.close(); resolve(); }
        if (st.stage === 'error') { es.close(); reject(new Error(st.error || '推理失败')); }
      };
      es.onerror = function(){ es.close(); reject(new Error('与后端连接中断')); };
    });

    // 3) 拉真实结果，喂现有回放引擎
    await dataSource.loadFlows();
    var metrics = await dataSource.getMetrics();
    if (metrics) applyRealMetrics(metrics);   // 先就位：告警分级要用 threshold

    // 关键：建图前先切回拓扑页，让 topo-canvas-wrap 拿到真实宽高，
    // 否则容器 display:none 时 clientWidth=0，节点全挤在 (0,0)，要等切回来才一次性弹出。
    if (currentPage !== 'topology') navigateTo('topology');

    updateDetectHud('done', 100, total, total);
    // 检测完成：更新历史状态为“完成”，异常数 = 后端 confusion 的检出阳性数（tp+fp），
    // 无标签时退回用回放流里判为攻击的条数。
    var _anom;
    if (metrics && metrics.confusion) _anom = metrics.confusion.tp + metrics.confusion.fp;
    else _anom = allFlows.filter(function(f){ return f.isAttack; }).length;
    updateUploadHistory(_histId, 'done', _anom);
    setTimeout(function(){
      hideDetectHud();
      // 此刻拓扑区已可见、有真实宽高，再真正建图
      if (window._apiNodes) rebuildTopologyFromApi(window._apiNodes, window._apiEdges);
      // 检测完成：从头开始自动播放，节点随真实数据逐个点亮
      clearTimeout(replayState.timer);
      replayState.playing = false;
      replayState.position = 0;
      replayTick(0);                 // 先清空，所有节点隐藏
      showToast('<i class="fa-solid fa-circle-check" style="color:var(--safe)"></i> 检测完成！正在回放真实攻击...', 'success');
      setTimeout(function(){ if (!replayState.playing) toggleReplay(); }, 400); // 自动播放
    }, 700);
  } catch (e) {
    updateUploadHistory(_histId, 'error');   // 检测失败：历史标红
    var extra = (e.message.indexOf('连接')>=0) ? '（请确认后端已启动：uvicorn server.api:app）' : '';
    document.getElementById('dhErr').textContent = '✕ ' + e.message + extra;
    updateDetectHud('error', 100, 0, 0);
    setTimeout(hideDetectHud, 4200);
  } finally {
    window._detectionRunning = false;   // 复位防重入，允许下一次检测
  }
}

// 把真实指标写入 modelRunState（dashboard/报告页读取真实统计）
function applyRealMetrics(m){
  window._apiMetrics = m;            // 供 updateStatsFromSnapshot 读取真实延迟
  var s = modelRunState;
  s.hasRun = true;
  s.latency = Math.round(m.latencyMs || 0);
  s._savedFlows = allFlows.slice();
  window._apiScoreDist = m.scoreDist;
  // 主动重绘分数分布（_apiScoreDist 刚就位），避免要等回放帧才出现。
  setTimeout(function(){ try { _render2DDist(currentSnapshot); } catch(e){} }, 120);
}

/* ═══ D3 TOPOLOGY ═══ */
var topoInited = false, topoSim, topoSvg, topoZoomBehavior, topoNode, topoLink, topoG, topoClusterOn = true, allNodes, allLinks, selectedNodeId, selectedEdgeId;
// 提到模块作用域：老版这两个函数嵌在 initTopology 内，但 closeDetail/highlightEdge 等顶层函数要调它们 → ReferenceError。
// 改为在 initTopology 内对模块变量赋值，所有调用方都能看到。
var highlightConnected, resetHighlight;
// 拓扑数据只来自后端检测结果（rebuildTopologyFromApi 重建）。无数据时为空，不生成演示拓扑。
allNodes = [];
allLinks = [];

function rebuildTopologyFromApi(apiNodes, apiEdges) {
  if (!apiNodes || !apiNodes.length) return;
  var te=document.getElementById('topoEmpty'); if(te) te.classList.add('hidden');
  var wrap = document.getElementById('topo-canvas-wrap');
  // 容器缺失或宽高为 0（display:none / 布局未完成 / 已切走拓扑页）时跳过重建：
  // 直接 return、不置空现图，避免后续 initTopology 读到无效尺寸把拓扑清空卡没；
  // 回到拓扑页时 initTopologyView 会用真实宽高重建。
  if (!wrap || !wrap.clientWidth || !wrap.clientHeight) return;
  var W = wrap.clientWidth, H = wrap.clientHeight;
  var N = apiNodes.length;
  // 1) 转换为现有 D3 节点结构（沿用 risk 字段驱动配色）。
  //    切回拓扑页重建时 allNodes 已有上一次稳定布局：沿用旧坐标，避免节点全部跳回
  //    初始螺旋、力布局重新“爆炸”（视觉上整个图抽搐）；只有首次检测才用黄金角螺旋铺位。
  var prevPos = {}, firstLayout = allNodes.length === 0;
  allNodes.forEach(function(p){ if (p && p.id != null) prevPos[p.id] = { x:p.x, y:p.y }; });
  var GA = Math.PI * (3 - Math.sqrt(5)); // 黄金角，分布最均匀
  var maxR = Math.min(W, H) * 0.42;
  allNodes = apiNodes.map(function(n, i){
    var pp = prevPos[n.id];
    var r = n.risk==='critical'?28:n.risk==='warning'?20:14;
    var x, y;
    if (pp) { x = pp.x; y = pp.y; }
    else {
      var t = (i + 0.5) / N;
      var rad = maxR * Math.sqrt(t);        // 半径按 sqrt 均匀填充圆盘
      var ang = i * GA;
      x = W/2 + Math.cos(ang)*rad; y = H/2 + Math.sin(ang)*rad;
    }
    return { id:n.id, label:n.ip, short:'N'+(i+1), r:r, risk:n.risk, sub:null, x:x, y:y };
  });
  var idset = {}; allNodes.forEach(function(n){idset[n.id]=true;});
  // 出场帧：按节点在 allFlows 里「首次出现的真实 step」分配 debut，使节点点亮与
  // 告警/时间轴/占比的数据增长同步（而非人为均匀铺满整个周期，导致节点串行点亮、数据干等）。
  window._apiNodeDebut = {};
  if (allFlows && allFlows.length) {
    for (var fi = 0; fi < allFlows.length; fi++) {
      var ff = allFlows[fi];
      if (window._apiNodeDebut[ff.src] === undefined) window._apiNodeDebut[ff.src] = ff.step;
      if (window._apiNodeDebut[ff.dst] === undefined) window._apiNodeDebut[ff.dst] = ff.step;
    }
  }
  // 没有任何流量记录的节点（理论上少见）：兜底按流量降序均匀铺开，保证仍会出场。
  var debutOrder = apiNodes.map(function(n){ return { id:n.id, fc:n.flowCount||0 }; })
                           .sort(function(a,b){ return b.fc - a.fc; });
  debutOrder.forEach(function(o, rank){
    if (window._apiNodeDebut[o.id] === undefined) {
      window._apiNodeDebut[o.id] = 1 + Math.floor(rank / Math.max(1, N - 1) * (TOTAL_STEPS - 1));
    }
  });
  // 边图上样式与详情面板同规则：该链路最严重异常流 ≥1.25×阈值 → attack(红粗)，
  // 仅异常未达 → suspect(橙)；无异常 → normal(蓝)。不再用旧的异常率 0.3 阈值。
  var thrL = (window._apiMetrics && window._apiMetrics.threshold) || 0.008;
  allLinks = (apiEdges||[]).filter(function(e){return idset[e.src]&&idset[e.dst];}).map(function(e){
    return { source:e.src, target:e.dst,
             type: e.anomalyCount>0 ? (e.scoreMax / (thrL||1e-9) >= RISK_CRITICAL_RATIO ? 'attack' : 'suspect') : 'normal' };
  });
  // 2) 清空旧 D3 内容并用新数据重建（initTopology 顶部已有清空守卫）
  topoInited = false;
  initTopology();
  // 3) 针对真实数据（密集枢纽型）重新调力。聚类开(=默认)时用强向心力把节点聚成团；
  //    用户关聚类时改用大斥力拉长连线，避免聚成一团。斥力随节点数放大，外加轻微定心力防止飞散。
  if (topoSim) {
    topoSim
      .force('charge', d3.forceManyBody().strength(topoClusterOn ? 800 : -(420 + N * 14)).distanceMax(W * 0.8))
      .force('link', d3.forceLink(allLinks).id(function(d){return d.id;}).distance(150).strength(0.06))
      .force('center', null)
      .force('x', d3.forceX(W/2).strength(0.035))
      .force('y', d3.forceY(H/2).strength(0.035))
      .force('collision', d3.forceCollide().radius(function(d){return d.r + 22;}).strength(0.9))
      .alpha(firstLayout ? 1 : 0.06).alphaDecay(0.012).restart();
  }
}

function initTopology() {
  // 重入守卫：清空旧的 svg 内容，使其可被 rebuildTopologyFromApi 重复调用
  d3.select('#topoSvg').selectAll('*').remove();
  topoInited = true; topoSvg = d3.select('#topoSvg');
  var container = document.getElementById('topo-canvas-wrap');
  // 容器缺失（页面已切走/尚未挂载）：不建图，回到拓扑页时 initTopologyView 会重建。
  if (!container) return;
  // 宽高为 0（display:none / 浏览器缩放重排瞬间）时沿用上次有效尺寸兜底，
  // 避免力布局 forceCenter(0,0) 把所有节点坍缩到原点导致拓扑卡没。
  var W = container.clientWidth || window._topoLastW || 800;
  var H = container.clientHeight || window._topoLastH || 600;
  window._topoLastW = W; window._topoLastH = H;
  var defs = topoSvg.append('defs');
  [{ id:'gAcc',c:'#3b82f6' },{ id:'gAccS',c:'#3b82f6',s:5 },{ id:'gDan',c:'#ff2d55' },{ id:'gDanS',c:'#ff2d55',s:7 },{ id:'gWarn',c:'#ff9500' }].forEach(function(g) { var f=defs.append('filter').attr('id',g.id);f.append('feGaussianBlur').attr('stdDeviation',g.s||3.5).attr('result','b');f.append('feMerge').selectAll('feMergeNode').data(['b','SourceGraphic']).enter().append('feMergeNode').attr('in',function(d){return d}) });
  [{ id:'gradN',c:'#3b82f6' },{ id:'gradD',c:'#ff2d55' },{ id:'gradW',c:'#ff9500' }].forEach(function(g) { var grad=defs.append('radialGradient').attr('id',g.id);grad.append('stop').attr('offset','0%').attr('stop-color',g.c).attr('stop-opacity',0.25);grad.append('stop').attr('offset','100%').attr('stop-color',g.c).attr('stop-opacity',0) });
  topoG = topoSvg.append('g');
  var colorMap={ normal:'#3b82f6', critical:'#ff2d55', warning:'#ff9500' }, filterMap={ normal:'url(#gAcc)', critical:'url(#gDan)', warning:'url(#gWarn)' }, gradMap={ normal:'url(#gradN)', critical:'url(#gradD)', warning:'url(#gradW)' };
  topoLink = topoG.append('g').selectAll('line').data(allLinks).enter().append('line').attr('stroke',function(d){return d.type==='attack'?'#ff2d55':d.type==='suspect'?'#ff9500':'#3b82f6'}).attr('stroke-width',function(d){return d.type==='attack'?3:d.type==='suspect'?2:1.5}).attr('opacity',function(d){return d.type==='attack'?1:d.type==='suspect'?0.95:0.7}).attr('cursor','pointer');
  topoNode = topoG.selectAll('g').data(allNodes).enter().append('g').attr('class','node-g').call(d3.drag().on('start',function(e,d){d._dragged=false;d._wasActive=e.active}).on('drag',function(e,d){if(!d._dragged){d._dragged=true;if(!d._wasActive)topoSim.alphaTarget(0.3).restart()}d.fx=e.x;d.fy=e.y}).on('end',function(e,d){if(!d._wasActive)topoSim.alphaTarget(0)}));
  topoNode.append('circle').attr('r',function(d){return d.r+12}).attr('fill',function(d){return gradMap[d.risk]}).attr('opacity',0.5);
  topoNode.append('circle').attr('r',function(d){return d.r}).attr('fill',function(d){return d.risk==='critical'?'#200d15':d.risk==='warning'?'#1a1508':'#0d2040'}).attr('stroke',function(d){return colorMap[d.risk]}).attr('stroke-width',function(d){return d.risk==='critical'?3:d.risk==='warning'?2.5:2}).attr('filter',function(d){return filterMap[d.risk]});
  topoNode.append('text').attr('text-anchor','middle').attr('dy','0.35em').attr('fill',function(d){return colorMap[d.risk]}).attr('font-size',function(d){return d.r>25?'11px':'9px'}).attr('font-weight',function(d){return d.risk==='critical'?'700':'500'}).attr('font-family','"JetBrains Mono",monospace').text(function(d){return d.short});
  topoSim = d3.forceSimulation(allNodes).force('link',d3.forceLink(allLinks).id(function(d){return d.id}).distance(100).strength(0.15)).force('charge',d3.forceManyBody().strength(topoClusterOn?800:-200)).force('center',d3.forceCenter(W/2,H/2)).force('collision',d3.forceCollide().radius(function(d){return d.r+12})).alphaDecay(0.008).on('tick',function(){topoLink.attr('x1',function(d){return d.source.x}).attr('y1',function(d){return d.source.y}).attr('x2',function(d){return d.target.x}).attr('y2',function(d){return d.target.y});topoNode.attr('transform',function(d){return'translate('+d.x+','+d.y+')'});updateMinimap()});
  topoZoomBehavior = d3.zoom().scaleExtent([0.3,5]).on('zoom',function(e){topoG.attr('transform',e.transform)});
  topoSvg.call(topoZoomBehavior).on('dblclick.zoom',null);
  topoSvg.on('click',function(e){if(e.target===topoSvg.node()||e.target===topoG.node()){selectedNodeId=null;selectedEdgeId=null;resetHighlight();closeDetail()}});
  topoNode.on('mouseenter',function(e,d){var circle=d3.select(this).select('circle:nth-child(2)');if(d.id!==selectedNodeId)rT(gsap.to(circle.node(),{attr:{r:d.r+6},strokeWidth:4,duration:0.2,ease:'power2.out'}));var tt=document.getElementById('tooltip');tt.textContent=d.short+' ('+d.label+')'+(d.sub?' ['+d.sub+']':'');tt.style.left=(d.x+22)+'px';tt.style.top=(d.y-35)+'px';rT(gsap.to(tt,{opacity:1,duration:0.12}))}).on('mouseleave',function(e,d){var circle=d3.select(this).select('circle:nth-child(2)');if(d.id!==selectedNodeId)rT(gsap.to(circle.node(),{attr:{r:d.r},strokeWidth:d.risk==='critical'?3:d.risk==='warning'?2.5:2,duration:0.2,ease:'power2.out'}));rT(gsap.to('#tooltip',{opacity:0,duration:0.08}))}).on('click',function(e,d){if(e.defaultPrevented||!d||!d.id)return;e.stopPropagation();if(selectedNodeId===d.id){selectedNodeId=null;resetHighlight();closeDetail()}else{selectedNodeId=d.id;selectedEdgeId=null;highlightConnected(d);showDetail(d)}});
  // 点击节点：与它直接相连的节点/连线正常显示，未连接的节点变半透明。
  highlightConnected = function(d){
    // 直接相邻节点集合（一跳）
    var neighbors = {}; neighbors[d.id] = true;
    allLinks.forEach(function(l){
      var sid = typeof l.source==='object'?l.source.id:l.source;
      var tid = typeof l.target==='object'?l.target.id:l.target;
      if (sid===d.id) neighbors[tid] = true;
      if (tid===d.id) neighbors[sid] = true;
    });
    topoNode.each(function(nd){
      var g = d3.select(this); if (g.attr('data-hidden')==='1') return;
      g.style('display','block');
      // 相邻/选中节点：不透明；其余节点：半透明（明显变淡但仍可见）
      g.transition().duration(250).style('opacity', neighbors[nd.id] ? 1 : 0.12);
    });
    topoLink.each(function(l){
      var linkEl = d3.select(this); if (linkEl.attr('data-hidden')==='1') return;
      var sid = typeof l.source==='object'?l.source.id:l.source;
      var tid = typeof l.target==='object'?l.target.id:l.target;
      var isDirect = (sid===d.id || tid===d.id);
      if (isDirect) {
        var lc = l.type==='attack'?'#ff2d55':l.type==='suspect'?'#ff9500':'#3b82f6';
        linkEl.style('display','block').transition().duration(250).attr('stroke',lc).attr('opacity',1).attr('stroke-width',l.type==='attack'?4:l.type==='suspect'?3:2.5);
      } else {
        // 未连接选中节点的线：隐藏
        linkEl.transition().duration(250).attr('opacity',0).on('end',function(){ d3.select(this).style('display','none'); });
      }
    });
  };
  resetHighlight = function(){
    topoNode.each(function(nd){
      var g = d3.select(this); if (g.attr('data-hidden')==='1') return;
      g.style('display','block').transition().duration(250).style('opacity',1);
      g.select('text').transition().duration(250).attr('font-size',nd.r>25?'11px':'9px').attr('font-weight',nd.risk==='critical'?'700':'500');
    });
    topoLink.each(function(l){var linkEl=d3.select(this);if(linkEl.attr('data-hidden')==='1')return;linkEl.transition().duration(250).style('display','block').attr('stroke',l.type==='attack'?'#ff2d55':l.type==='suspect'?'#ff9500':'#3b82f6').attr('opacity',l.type==='attack'?1:l.type==='suspect'?0.95:0.7).attr('stroke-width',l.type==='attack'?3:l.type==='suspect'?2:1.5)})
  };
function highlightEdge(l) {
  var sid = typeof l.source==='object'?l.source.id:l.source;
  var tid = typeof l.target==='object'?l.target.id:l.target;
  // Dim all non-selected edges and nodes
  topoLink.each(function(ll){
    var linkEl = d3.select(this);
    if (linkEl.attr('data-hidden')==='1') return;
    var ls = typeof ll.source==='object'?ll.source.id:ll.source;
    var lt = typeof ll.target==='object'?ll.target.id:ll.target;
    if (ls===sid && lt===tid) {
      linkEl.attr('stroke',ll.type==='attack'?'#ff2d55':ll.type==='suspect'?'#ff9500':'#3b82f6').attr('stroke-width',5).attr('opacity',1);
    } else {
      // 只保留被选中的这条边：其他边完全隐藏
      linkEl.attr('stroke','#0d3360').attr('stroke-width',0.8).attr('opacity',0).style('display','none');
    }
  });
  topoNode.each(function(nd){
    var g = d3.select(this);
    if (g.attr('data-hidden')==='1') return;
    if (nd.id === sid || nd.id === tid) {
      // 选中边的两端节点：完整显示并放大文字提示
      g.style('display','block').style('opacity',1);
      g.select('text').transition().duration(300).attr('font-size','12px').attr('font-weight','700');
    } else {
      // 非端点的其他节点：完全隐藏，只留下这条边及其两端节点
      g.style('display','none').style('opacity',0);
      g.select('text').transition().duration(300).attr('font-size','9px').attr('font-weight','500');
    }
  });
}
  topoNode.filter(function(d){return d.risk==='critical'}).each(function(d){var circle=d3.select(this).select('circle:nth-child(2)');rT(gsap.to(circle.node(),{attr:{r:d.r+8},duration:d.id.indexOf('1')>=0?1:1.6,repeat:-1,yoyo:true,ease:'sine.inOut'}))});
  // All edges are solid — no dashoffset animation needed
  // Edge click handler — show traffic data
  topoLink.on('mouseenter',function(e,l){
    if (d3.select(this).attr('data-hidden')==='1') return;
    if (selectedEdgeId !== l.source.id+'-'+l.target.id) {
      d3.select(this).attr('stroke-width',function(d){return d.type==='attack'?5:d.type==='suspect'?4:3}).attr('stroke',function(d){return d.type==='attack'?'#ff2d55':d.type==='suspect'?'#ff9500':'#3b82f6'});
    }
    var tt=document.getElementById('tooltip');
    var sid=typeof l.source==='object'?l.source.id:l.source;
    var tid=typeof l.target==='object'?l.target.id:l.target;
    tt.textContent = sid + ' → ' + tid + ' (点击查看流量详情)';
    tt.style.left=(e.pageX+14)+'px'; tt.style.top=(e.pageY-28)+'px';
    rT(gsap.to(tt,{opacity:1,duration:0.12}));
  }).on('mouseleave',function(e,l){
    if (d3.select(this).attr('data-hidden')==='1') return;
    if (selectedEdgeId !== l.source.id+'-'+l.target.id) {
      resetHighlight();
    }
    rT(gsap.to('#tooltip',{opacity:0,duration:0.08}));
  }).on('click',function(e,l){
    if (e.defaultPrevented) return;
    e.stopPropagation();
    var sid=typeof l.source==='object'?l.source.id:l.source;
    var tid=typeof l.target==='object'?l.target.id:l.target;
    var eid = sid + '-' + tid;
    if (selectedEdgeId === eid) { selectedEdgeId = null; resetHighlight(); closeDetail(); }
    else { selectedEdgeId = eid; selectedNodeId = null; highlightEdge(l); showEdgeDetail(l); }
  });
  updateMinimap();
  // Minimap click → pan topology to that position
  document.getElementById('minimap').addEventListener('click', function(e) {
    if (!allNodes || !allNodes.length) return;
    var rect = this.getBoundingClientRect();
    var mx = e.clientX - rect.left;
    var my = e.clientY - rect.top;
    var xs = allNodes.map(function(n){return n.x});
    var ys = allNodes.map(function(n){return n.y});
    var minX = Math.min.apply(null, xs);
    var maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys);
    var maxY = Math.max.apply(null, ys);
    var rangeX = maxX - minX || 1;
    var rangeY = maxY - minY || 1;
    var tx = minX + ((mx - 10) / 100) * rangeX;
    var ty = minY + ((my - 5) / 70) * rangeY;
    var wrap = document.getElementById('topo-canvas-wrap');
    var cx = wrap.clientWidth / 2;
    var cy = wrap.clientHeight / 2;
    topoSvg.transition().duration(400).call(
      topoZoomBehavior.transform,
      d3.zoomIdentity.translate(cx - tx * 1.8, cy - ty * 1.8).scale(1.8)
    );
  });
  // Initially hide all nodes — they appear progressively during replay
  topoNode.attr('data-hidden','1').style('display','none').style('opacity',0);
  topoLink.attr('data-hidden','1').style('display','none').style('opacity',0);
}

function getConnectedNodesByHop(d) {
  if (!d || !d.id || !allLinks || !allNodes) return {direct:[],indirect:[]};
  var connectedIds=new Set(); connectedIds.add(d.id); var distance={}; distance[d.id]=0; var queue=[d.id];
  while(queue.length>0){var current=queue.shift();allLinks.forEach(function(l){var sid=typeof l.source==='object'?l.source.id:l.source,tid=typeof l.target==='object'?l.target.id:l.target;if(sid===current&&!connectedIds.has(tid)){connectedIds.add(tid);distance[tid]=distance[current]+1;queue.push(tid)}if(tid===current&&!connectedIds.has(sid)){connectedIds.add(sid);distance[sid]=distance[current]+1;queue.push(sid)}})}
  connectedIds.delete(d.id); var direct=[], indirect=[];
  connectedIds.forEach(function(id){var node=allNodes.find(function(n){return n.id===id});if(!node)return;var rc=node.risk==='critical'?'#ff2d55':node.risk==='warning'?'#ff9500':'#3b82f6';var tag='<span style="color:'+rc+'">'+(node.short?node.short+' ('+node.label+')':node.label)+(node.sub?' ['+node.sub+']':'')+'</span>';if(distance[id]===1)direct.push(tag);else indirect.push(tag)});
  return { direct:direct, indirect:indirect };
}

function showDetail(d) {
  if (!d || !d.id) return;
  var panel=document.getElementById('detailPanel'),content=document.getElementById('detailContent');
  if (!panel || !content) return;
  var rc=d.risk==='critical'?'var(--danger)':d.risk==='warning'?'var(--warn)':'var(--normal)';
  var rcRaw=d.risk==='critical'?'#ff2d55':d.risk==='warning'?'#ff9500':'#3b82f6';
  var riskLabel=d.risk==='critical'?'严重':d.risk==='warning'?'警告':'正常';
  var riskIcon=d.risk==='critical'?'<i class="fa-solid fa-skull" style="color:var(--danger);filter:drop-shadow(0 0 4px var(--danger))"></i>':d.risk==='warning'?'<i class="fa-solid fa-triangle-exclamation" style="color:var(--warn);filter:drop-shadow(0 0 4px var(--warn))"></i>':'<i class="fa-solid fa-shield-check" style="color:var(--normal);filter:drop-shadow(0 0 4px var(--normal))"></i>';

  // Get node traffic stats.
  if (!topoNode) return;
  var g = topoNode.filter(function(nd){return nd.id===d.id});
  var stats = null;
  // API 模式：一律用后端按真实 NetFlow 列聚合的全量真值（见 aggregate.build_replay_payload）。
  // 不读 data-stats —— 回放快照里的字节/包是 computeSnapshot 的 Math.random() 模拟值（仅用于
  // mock 演示），且采样只覆盖 8000 条流，两者都不可靠。后端真值对所有节点口径统一、不受采样影响。
  if (dataSource.mode === 'api' && window._apiNodes) {
    var an = window._apiNodes.find(function(n){ return n.id===d.id; });
    if (an) {
      stats = { inBytes: an.inBytes||0, outBytes: an.outBytes||0,
                inPkts: an.inPkts||0, outPkts: an.outPkts||0,
                flowCount: an.flowCount||0, anomalyCount: an.anomalyCount||0,
                scoreSum: an.scoreSum||0, scoreMax: an.scoreMax||0 };
    }
  }
  // 非 API（mock 演示）模式：回落到回放快照写入的 data-stats。
  if (!stats) {
    var statsStr = g.attr('data-stats');
    try { if (statsStr) stats = JSON.parse(statsStr); } catch(e){}
  }
  if (!stats) stats = { inBytes:0, outBytes:0, inPkts:0, outPkts:0, flowCount:0, anomalyCount:0, scoreSum:0, scoreMax:0 };

  var byHop=getConnectedNodesByHop(d),totalCount=byHop.direct.length+byHop.indirect.length;
  var totalBytes = stats.inBytes + stats.outBytes;
  var totalPkts = stats.inPkts + stats.outPkts;
  var avgScore = stats.flowCount > 0 ? (stats.scoreSum / stats.flowCount) : 0;
  var thrD = (window._apiMetrics && window._apiMetrics.threshold) || 0;   // api 分数显示统一用「score/阈值」倍数
  var anomalyRate = stats.flowCount > 0 ? (stats.anomalyCount / stats.flowCount * 100) : 0;

  // Select relevant NetFlow features for node detail
  var nodeFeatures = NETFLOW_FEATURES.slice(0, 12); // Use first 12 features as representative

  var html = '';
  // Header
  html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">';
  html += '<span style="font-size:20px">'+riskIcon+'</span>';
  html += '<div><div style="font-size:15px;font-weight:700;color:'+rc+'">'+(d.short?d.short+' ('+d.label+')':d.label)+(d.sub?' ['+d.sub+']':'')+'</div>';
  html += '<div style="font-size:9px;color:var(--text-dim)">'+riskLabel+' · 节点ID: '+d.id+'</div></div></div>';

  // Risk bar
  html += '<div class="replay-progress" style="max-width:none;margin:8px 0"><div class="fill" style="width:'+(d.risk==='critical'?'92%':d.risk==='warning'?'55%':'5%')+';background:'+rcRaw+'"></div></div>';

  // 模块一：流量统计（dp-module 支持点击放大，机制同左右侧栏模块）
  html += '<div class="dp-module"><div class="dm-title"><i class="fa-solid fa-chart-simple"></i> 流量统计 <span class="dm-hint">点击放大</span></div>';
  html += '<div class="dm-grid">';
  html += '<div><span style="color:var(--text-dim)">总流数:</span> <span style="color:var(--accent);font-weight:700">'+stats.flowCount.toLocaleString()+'</span></div>';
  html += '<div><span style="color:var(--text-dim)">异常率:</span> <span style="color:'+rc+';font-weight:700">'+anomalyRate.toFixed(1)+'%</span></div>';
  html += '<div><span style="color:var(--text-dim)">入站字节:</span> <span style="color:var(--text)">'+formatBytes(stats.inBytes)+'</span></div>';
  html += '<div><span style="color:var(--text-dim)">出站字节:</span> <span style="color:var(--text)">'+formatBytes(stats.outBytes)+'</span></div>';
  html += '<div><span style="color:var(--text-dim)">入站包数:</span> <span style="color:var(--text)">'+stats.inPkts.toLocaleString()+'</span></div>';
  html += '<div><span style="color:var(--text-dim)">出站包数:</span> <span style="color:var(--text)">'+stats.outPkts.toLocaleString()+'</span></div>';
  html += '<div><span style="color:var(--text-dim)">总流量:</span> <span style="color:var(--text)">'+formatBytes(totalBytes)+'</span></div>';
  // 分数统一为「score/阈值」倍数（与告警流/分数分布同口径）；scoreColor 内部已按阈值分级上色
  var nodeAvgX = dataSource.mode === 'api' && thrD > 0 ? (avgScore/thrD).toFixed(2)+'×' : avgScore.toFixed(4);
  var nodeMaxX = dataSource.mode === 'api' && thrD > 0 ? (stats.scoreMax/thrD).toFixed(2)+'×' : stats.scoreMax.toFixed(4);
  html += '<div><span style="color:var(--text-dim)">总分值:</span> <span style="color:'+rc+'">'+nodeAvgX+' (平均)</span></div>';
  html += '<div><span style="color:var(--text-dim)">最高分:</span> <span style="color:'+scoreColor(stats.scoreMax)+';font-weight:700">'+nodeMaxX+'</span></div>';
  html += '<div><span style="color:var(--text-dim)">异常数:</span> <span style="color:var(--warn)">'+stats.anomalyCount.toLocaleString()+'</span></div>';
  html += '</div></div>';

  // 模块二：NetFlow 特征字段
  html += '<div class="dp-module"><div class="dm-title"><i class="fa-solid fa-clipboard-list"></i> NetFlow v3 关键特征字段 <span class="dm-hint">点击放大</span></div>';
  html += '<div class="dm-scroll">';
  nodeFeatures.forEach(function(nf){
    html += '<div class="dm-row"><span style="color:var(--accent);font-family:var(--font-mono)">'+nf.f+'</span><span style="color:var(--text-dim)">'+nf.cn+'</span></div>';
  });
  html += '<div style="color:var(--text-dim);font-size:7px;text-align:center;margin-top:3px">...共 '+NETFLOW_FEATURES.length+' 个特征字段</div>';
  html += '</div></div>';

  // 模块三：可到达节点
  if (totalCount > 0) {
    html += '<div class="dp-module"><div class="dm-title"><i class="fa-solid fa-diagram-project"></i> 可到达节点 ('+totalCount+') <span class="dm-hint">点击放大</span></div>';
    html += '<div class="dm-scroll" style="max-height:150px;font-size:10px;line-height:1.8">';
    if(byHop.direct.length>0) html+='<div style="color:#3b82f6;font-size:8px">▸ 直连 ('+byHop.direct.length+')</div>'+byHop.direct.join('<br>');
    if(byHop.indirect.length>0) html+='<div style="color:#ff9500;font-size:8px;margin-top:6px">▸ 经中间节点 ('+byHop.indirect.length+')</div>'+byHop.indirect.join('<br>');
    html += '</div></div>';
  }

  html += '<div style="font-size:8px;color:var(--text-dim);text-align:center">再次点击或点击空白区域取消选择 · 点击连线查看流量详情</div>';
  content.innerHTML = html;
  content.querySelectorAll('.dp-module').forEach(function(m){ bindModule(m); });
  panel.classList.add('open');
}

function formatBytes(bytes) {
  if (bytes >= 1e9) return (bytes/1e9).toFixed(2)+' GB';
  if (bytes >= 1e6) return (bytes/1e6).toFixed(2)+' MB';
  if (bytes >= 1e3) return (bytes/1e3).toFixed(1)+' KB';
  return bytes+' B';
}

function showEdgeDetail(l) {
  if (!l) return;
  var panel=document.getElementById('detailPanel'),content=document.getElementById('detailContent');
  if (!panel || !content) return;
  var sid=typeof l.source==='object'?l.source.id:l.source;
  var tid=typeof l.target==='object'?l.target.id:l.target;
  if (!sid || !tid) return;
  var srcLabel = sid, dstLabel = tid;
  var srcNode = allNodes.find(function(n){return n.id===sid});
  var dstNode = allNodes.find(function(n){return n.id===tid});
  if (srcNode) srcLabel = srcNode.short || srcNode.label;
  if (dstNode) dstLabel = dstNode.short || dstNode.label;

  // Get edge flow stats
  var linkEl = topoLink.filter(function(ll){
    var ls = typeof ll.source==='object'?ll.source.id:ll.source;
    var lt = typeof ll.target==='object'?ll.target.id:ll.target;
    return ls===sid && lt===tid;
  });
  var statsStr = linkEl.attr('data-flowstats');
  var stats = null;
  try { if (statsStr) stats = JSON.parse(statsStr); } catch(e){}
  // 正常节点间的边：流量没进 8000 条采样帧 → edgeFlowMap 无此边 → data-flowstats 为空 →
  // 原来兜底成 flowCount:0（显示总流量0，错）。回退到后端 _apiEdges 的全量真值。
  var beApi = null;
  if (dataSource.mode === 'api' && window._apiEdges) {
    beApi = window._apiEdges.find(function(e){
      return (e.src===sid && e.dst===tid) || (e.src===tid && e.dst===sid);
    });
    if (beApi && !stats) {
      stats = { flowCount: beApi.flowCount||0, anomalyCount: beApi.anomalyCount||0,
                scoreSum: (beApi.scoreMax||0) * (beApi.flowCount||0), scoreMax: beApi.scoreMax||0,
                bytesEst: 0, pktEst: 0,
                types: beApi.topType ? (function(){var o={};o[beApi.topType]=beApi.flowCount||0;return o;})() : {正常:beApi.flowCount||0} };
    }
  }
  // api 模式：链路字节/包数一律走后端全量真值（edgeFlowMap 已归零、采样帧不含字节，不能从帧估算）
  if (beApi) {
    stats.bytesEst = (beApi.inBytes||0) + (beApi.outBytes||0);
    stats.pktEst = (beApi.inPkts||0) + (beApi.outPkts||0);
  }
  if (!stats) stats = { flowCount:0, anomalyCount:0, scoreSum:0, scoreMax:0, bytesEst:0, pktEst:0, types:{正常:0} };
  var avgScore = stats.flowCount > 0 ? (stats.scoreSum / stats.flowCount) : 0;
  var anomalyRate = stats.flowCount > 0 ? (stats.anomalyCount / stats.flowCount * 100) : 0;
  // 链路等级与告警流同规则：取该链路上最严重那条异常流的级别（分数 ≥1.25×阈值 → 严重）。
  // 有异常流时 scoreMax 即异常流最高分，用 scoreMax/阈值 算倍数。
  var thrE = (window._apiMetrics && window._apiMetrics.threshold) || 0.008;
  var eRatio = thrE > 0 ? (stats.scoreMax / thrE) : 0;
  var edgeRisk = stats.anomalyCount > 0 ? (eRatio >= RISK_CRITICAL_RATIO ? '严重' : '警告') : '正常';
  var eRC = edgeRisk === '严重' ? 'var(--danger)' : edgeRisk === '警告' ? 'var(--warn)' : 'var(--normal)';
  var eIcon = edgeRisk === '严重' ? '<i class="fa-solid fa-skull" style="color:var(--danger);filter:drop-shadow(0 0 4px var(--danger))"></i>' : edgeRisk === '警告' ? '<i class="fa-solid fa-triangle-exclamation" style="color:var(--warn);filter:drop-shadow(0 0 4px var(--warn))"></i>' : '<i class="fa-solid fa-shield-check" style="color:var(--normal);filter:drop-shadow(0 0 4px var(--normal))"></i>';

  // Select relevant features for edge/flow display
  var edgeFeatures = [];
  var edgeFeatKeys = ['FLOW_DURATION_MILLISECONDS','PROTOCOL','L7_PROTO','L4_SRC_PORT','L4_DST_PORT','TCP_FLAGS','SRC_TO_DST_AVG_THROUGHPUT','DST_TO_SRC_AVG_THROUGHPUT','SRC_TO_DST_IAT_AVG','DST_TO_SRC_IAT_AVG','MIN_TTL','MAX_TTL'];
  edgeFeatKeys.forEach(function(k){
    var f = NETFLOW_FEATURES.find(function(x){return x.f===k});
    if (f) edgeFeatures.push(f);
  });

  var html = '';
  // Header
  html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">';
  html += '<span style="font-size:20px">'+eIcon+'</span>';
  html += '<div><div style="font-size:13px;font-weight:700;color:'+eRC+'"><i class="fa-solid fa-arrow-right"></i> '+srcLabel+' → '+dstLabel+'</div>';
  html += '<div style="font-size:9px;color:var(--text-dim)">'+edgeRisk+'链路 · '+sid+' → '+tid+'</div></div></div>';

  // Risk bar
  html += '<div class="replay-progress" style="max-width:none;margin:8px 0"><div class="fill" style="width:'+Math.min(100,eRatio*40)+'%;background:'+(edgeRisk==='严重'?'#ff2d55':edgeRisk==='警告'?'#ff9500':'#3b82f6')+'"></div></div>';

  // 模块一：链路流量统计（点击放大；分数统一为「score/阈值」倍数，与告警流/分数分布同口径）
  var edgeAvgX = dataSource.mode === 'api' && thrE > 0 ? (avgScore/thrE).toFixed(2)+'×' : avgScore.toFixed(4);
  var edgeMaxX = dataSource.mode === 'api' && thrE > 0 ? (stats.scoreMax/thrE).toFixed(2)+'×' : stats.scoreMax.toFixed(4);
  html += '<div class="dp-module"><div class="dm-title"><i class="fa-solid fa-chart-simple"></i> 链路流量统计 <span class="dm-hint">点击放大</span></div>';
  html += '<div class="dm-grid">';
  html += '<div><span style="color:var(--text-dim)">总流量数:</span> <span style="color:var(--accent);font-weight:700">'+stats.flowCount.toLocaleString()+'</span></div>';
  html += '<div><span style="color:var(--text-dim)">异常率:</span> <span style="color:'+(edgeRisk==='严重'?'var(--danger)':edgeRisk==='警告'?'var(--warn)':'var(--normal)')+';font-weight:700">'+anomalyRate.toFixed(1)+'%</span></div>';
  html += '<div><span style="color:var(--text-dim)">字节总量:</span> <span style="color:var(--text)">'+(stats.bytesEst>0?formatBytes(stats.bytesEst):'—')+'</span></div>';
  html += '<div><span style="color:var(--text-dim)">包数总量:</span> <span style="color:var(--text)">'+(stats.pktEst>0?stats.pktEst.toLocaleString():'—')+'</span></div>';
  html += '<div><span style="color:var(--text-dim)">平均分数:</span> <span style="color:'+scoreColor(avgScore)+'">'+edgeAvgX+'</span></div>';
  html += '<div><span style="color:var(--text-dim)">最高分数:</span> <span style="color:'+scoreColor(stats.scoreMax)+';font-weight:700">'+edgeMaxX+'</span></div>';
  html += '<div><span style="color:var(--text-dim)">异常流数:</span> <span style="color:var(--warn)">'+stats.anomalyCount.toLocaleString()+'</span></div>';
  html += '<div><span style="color:var(--text-dim)">正常流数:</span> <span style="color:var(--normal)">'+(stats.flowCount-stats.anomalyCount).toLocaleString()+'</span></div>';
  html += '</div></div>';

  // 模块二：链路 NetFlow 特征字段
  html += '<div class="dp-module"><div class="dm-title"><i class="fa-solid fa-clipboard-list"></i> 链路 NetFlow 特征字段 <span class="dm-hint">点击放大</span></div>';
  html += '<div class="dm-scroll">';
  edgeFeatures.forEach(function(ef){
    html += '<div class="dm-row"><span style="color:var(--accent);font-family:var(--font-mono)">'+ef.f+'</span><span style="color:var(--text-dim);text-align:right">'+ef.cn+'</span></div>';
  });
  html += '</div></div>';

  html += '<div style="font-size:8px;color:var(--text-dim);text-align:center">再次点击该连线或空白区域取消选择 · 点击节点查看节点详情</div>';
  content.innerHTML = html;
  content.querySelectorAll('.dp-module').forEach(function(m){ bindModule(m); });
  panel.classList.add('open');
}
function closeDetail(){document.getElementById('detailPanel').classList.remove('open');selectedNodeId=null;selectedEdgeId=null;resetHighlight()}
function updateMinimap(){var mc=document.getElementById('minimap');if(!mc)return;var ctx=mc.getContext('2d');ctx.clearRect(0,0,120,80);ctx.fillStyle=document.documentElement.dataset.theme==='light'?'rgba(255,255,255,0.92)':'rgba(0,0,0,0.9)';ctx.fillRect(0,0,120,80);var xs=allNodes.map(function(n){return n.x}),ys=allNodes.map(function(n){return n.y}),minX=Math.min.apply(null,xs),maxX=Math.max.apply(null,xs),minY=Math.min.apply(null,ys),maxY=Math.max.apply(null,ys),rangeX=maxX-minX||1,rangeY=maxY-minY||1;allNodes.forEach(function(n){var px=10+((n.x-minX)/rangeX)*100,py=5+((n.y-minY)/rangeY)*70;ctx.beginPath();ctx.arc(px,py,1.2,0,Math.PI*2);ctx.fillStyle=n.risk==='critical'?'#ff2d55':n.risk==='warning'?'#ff9500':'#3b82f6';ctx.fill()})}
function topoZoom(factor){topoSvg.transition().duration(300).call(topoZoomBehavior.scaleBy,factor)}
function topoResetView(){topoSvg.transition().duration(300).call(topoZoomBehavior.transform,d3.zoomIdentity)}
function topoToggleClustering(){topoClusterOn=!topoClusterOn;document.getElementById('clusterLabel').textContent=topoClusterOn?'开':'关';topoSim.force('charge',d3.forceManyBody().strength(topoClusterOn?800:-200));topoSim.alpha(0.5).restart()}
function topoSearchNode(query){if(!query)return;var q=String(query).toLowerCase();var node=allNodes.find(function(n){return (n.label&&n.label.toLowerCase().indexOf(q)>=0)||(n.short&&n.short.toLowerCase().indexOf(q)>=0)||(n.id&&n.id.toLowerCase().indexOf(q)>=0)});if(node){var c=document.getElementById('topo-canvas-wrap');topoSvg.transition().duration(500).call(topoZoomBehavior.transform,d3.zoomIdentity.translate(c.clientWidth/2-node.x*2.5,c.clientHeight/2-node.y*2.5).scale(2.5))}}
function topoFilter(){var risk=document.getElementById('topoRiskFilter').value;topoNode.style('display',function(d){return risk==='all'||d.risk===risk?'block':'none'});if(risk==='all'){topoLink.style('display','block').style('opacity',function(l){return l.type==='attack'?1:l.type==='suspect'?0.95:0.7})}else{topoLink.style('display','none')}}

/* ═══ ROUTING（适配 Vue Router：引擎只负责"请求跳转"，实际跳转由注入的函数完成）═══ */
let currentPage = 'topology'
let _navFn = null
// App 启动时注入 router.push 的包装；引擎内部 startUploadDetection 会调 navigateTo('topology')
export function setNavFn(fn) { _navFn = fn }
export function setCurrentPage(p) { currentPage = p }
function navigateTo(page) {
  if (page === currentPage) return
  if (_navFn) _navFn(page)        // 交给 Vue Router
  else { currentPage = page; window.location.hash = page }
}

/* ═══ BOOTSTRAP（老版 DOMContentLoaded 拆成两段）═══ */
// 全局一次性初始化：液态光标 + 库可用性检查（与具体页面无关）
let _engineInited = false
export function initEngine() {
  if (_engineInited) return
  _engineInited = true
  // 窗口尺寸变化时：告警页重算滚动视口；拓扑页只平移力布局中心（防抖），不重建整图。
  // 旧实现 resize 时整图 rebuild → initTopology，容器在防抖窗口内被切走（null）或
  // 浏览器缩放重排瞬间宽高为 0 时会抛错 / 把节点坍缩到原点，导致拓扑图卡没。
  window.addEventListener('resize', function(){
    if (document.getElementById('alertScroll')) { _fitAlertViewport(); _renderAlertWindow(document.getElementById('alertScroll').scrollTop); }
    if (window._apiNodes && window._apiNodes.length && document.getElementById('topo-canvas-wrap')) {
      clearTimeout(window._topoResizeT);
      window._topoResizeT = setTimeout(function(){
        var wrap = document.getElementById('topo-canvas-wrap');
        // 容器已切走 / 宽高为 0（display:none、布局未完成、浏览器缩放重排瞬间）：跳过，
        // 不触碰现有图，回到拓扑页时 initTopologyView 会按真实宽高重建。
        if (!wrap || !wrap.clientWidth || !wrap.clientHeight) return;
        if (!topoSim) return;
        var W = wrap.clientWidth, H = wrap.clientHeight;
        // 只把力布局中心移到新画布中心并温和重启：节点自动回到视野内，
        // 保留节点当前位置与用户缩放/平移，不销毁重建。
        if (topoSim.force('center')) topoSim.force('center', d3.forceCenter(W / 2, H / 2));
        if (topoSim.force('x')) topoSim.force('x', d3.forceX(W / 2).strength(0.035));
        if (topoSim.force('y')) topoSim.force('y', d3.forceY(H / 2).strength(0.035));
        topoSim.alpha(0.3).restart();
      }, 180);
    }
  })
  if (typeof d3 === 'undefined') console.warn('[TopInspect] D3.js 加载失败')
  if (typeof gsap === 'undefined') console.warn('[TopInspect] GSAP 加载失败')
}

// 拓扑视图挂载时调用：装扫描线/环境光/告警流/拖放，并在已有检测数据时重建图谱
export function initTopologyView() {
  try { initScanLine(); initAmbient() } catch (e) { /* 装饰动画失败可忽略 */ }
  // 切回拓扑页时 alertStream DOM 是 Vue 新挂载的（空），但 _alertSig 还存着旧指纹，
  // 会导致 _renderAlertItems 命中 `sig===_alertSig` 跳过渲染 → 告警流空白。重置指纹强制重渲。
  _alertSig = '';
  renderAlertStream()
  // 拖放区
  var dropZone = document.getElementById('uploadDropZone')
  if (dropZone && !dropZone._dndInited) {
    dropZone._dndInited = true
    dropZone.addEventListener('dragover', function (e) { e.preventDefault(); e.stopPropagation(); this.style.borderColor = 'var(--accent)'; this.style.background = 'rgba(0,212,255,0.06)' })
    dropZone.addEventListener('dragleave', function (e) { e.preventDefault(); e.stopPropagation(); this.style.borderColor = 'var(--glass-border)'; this.style.background = '' })
    dropZone.addEventListener('drop', function (e) {
      e.preventDefault(); e.stopPropagation(); this.style.borderColor = 'var(--glass-border)'; this.style.background = ''
      if (e.dataTransfer.files.length) { var f = e.dataTransfer.files[0]; document.getElementById('uploadFileName').textContent = f.name + ' (' + (f.size / 1024 / 1024).toFixed(1) + ' MB)'; document.getElementById('uploadFileName').style.color = 'var(--accent)' }
    })
  }
  // 已检测过：切回拓扑页时重建图谱并恢复到当前回放位置（DOM 是新挂载的）
  if (window._apiNodes && window._apiNodes.length) {
    rebuildTopologyFromApi(window._apiNodes, window._apiEdges)
    replayTick(replayState.position || TOTAL_STEPS)
  }
  setTimeout(function () { updateChartsFromSnapshot(currentSnapshot) }, 200)
}

// 离开拓扑视图：停回放计时器，避免对已卸载 DOM 操作
export function teardownTopologyView() {
  replayState.playing = false
  clearTimeout(replayState.timer)
}

/* 数据提示弹窗（老版独立 script 块 2718-2719，逐行搬迁；均 null-guard，安全）*/
function showDataPromptModal(){ var m=document.getElementById('dataPromptModal'),c=document.getElementById('dpmCard'); if(!m)return; m.style.display='flex'; setTimeout(function(){m.style.opacity='1';c.style.transform='translateY(0)'},50); }
function hideDataPromptModal(){ var m=document.getElementById('dataPromptModal'),c=document.getElementById('dpmCard'); if(!m)return; m.style.opacity='0'; c.style.transform='translateY(20px)'; setTimeout(function(){m.style.display='none'},600); }

/* ═══ 把内联 onX 处理器需要的函数暴露到 window（模板 onclick 在运行时按全局解析）═══ */
Object.assign(window, {
  navigateTo,
  toggleReplay, runReplay, replayStepForward, replayStepBack, replaySkipForward, replaySkipBack,
  resetReplayData, setReplaySpeed, onSpeedChange,
  startUploadDetection, handleFileSelect, handleUploadFile, clearUploadHistory,
  topoZoom, topoResetView, topoSearchNode, topoToggleClustering, topoFilter,
  closeDetail, dismissAlert, dismissAllAlerts, exportAlertCSV, sortAlerts, renderAlertsFiltered,
  setAlertFilter, locateAlert, _onAlertScroll,
  renderReportTab, renderDashboard, renderSettings, renderAlerts, initUploadHandlers,
  hideDataPromptModal, showDataPromptModal, refreshCharts, renderSnapshotInto,
})

// 供 Vue 组件直接 import 调用
export {
  toggleReplay, resetReplayData, setReplaySpeed,
  startUploadDetection, handleUploadFile,
  topoZoom, topoResetView, topoSearchNode, topoToggleClustering, topoFilter,
  closeDetail, replayStepForward, replayStepBack, replaySkipForward, replaySkipBack,
  renderDashboard, renderSettings, renderAlerts, renderReportTab, initUploadHandlers,
}

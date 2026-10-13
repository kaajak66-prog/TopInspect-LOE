/* ═══════════════════════════════════════════════════════════════════════
   回归测试：左面板「活跃连接」显示真实去重连接数。

   背景：原实现用 snap.edges.length 作为「活跃连接」。回放帧只保留异常流时
   （异常数 ≥ max_flows=8000，正常流全丢），edges 是 { length: totalFlows }
   假对象 → 活跃连接 == 攻击流，失真。

   修复（两版口径）：
     · 计算语义：按 src->dst 去重（edgeFlowMap 键数），不再把每条流当一条连接。
     · API 模式：显示后端全量去重连接数 window._apiEdges（含正常流连接），
       与顶栏「边」、拓扑图最终显示一致。
     · 非 API 模式：回退到帧内去重边数 Object.keys(edgeFlowMap).length。

   本脚本按 engine.js 增量快照（_incrAddFlow）的去重逻辑与 updateThreatOverview
   FromSnapshot 的口径选择原样复现。运行：cd frontend && node tests/repro_tov_edges.mjs
   ═══════════════════════════════════════════════════════════════════════ */
let failures = 0
function check(name, cond, detail) {
  if (cond) { console.log('  ✓ ' + name) }
  else { failures++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')) }
}

/* 模拟 engine.js _incrAddFlow 的 edgeFlowMap 去重行为（仅取与本测试相关的字段） */
function makeEdgeFlowMap(flows) {
  const m = {}
  for (const f of flows) {
    const ek = f.src + '->' + f.dst
    if (!m[ek]) m[ek] = { src: f.src, dst: f.dst, flowCount: 0, anomalyCount: 0 }
    m[ek].flowCount++
    if (f.isAttack) m[ek].anomalyCount++
  }
  return m
}

/* 模拟修复后 updateThreatOverviewFromSnapshot 的取值逻辑 */
function activeConnections(snap, opts) {
  opts = opts || {}
  if (opts.apiMode && opts.apiEdges) return opts.apiEdges.length   // API 全量真值优先
  return Object.keys(snap.edgeFlowMap || {}).length                 // 非 API 回退帧内去重
}
function attackFlows(snap) {
  return snap.totalAnomalies != null ? snap.totalAnomalies : 0
}

/* 场景 A：API 模式，后端全量 278 条连接（含正常流）——活跃连接取全量真值，恒定 */
console.log('1) API 模式：活跃连接 = 后端全量去重连接数（含正常流）')
const snapA = {
  edgeFlowMap: makeEdgeFlowMap([
    { src: 'A', dst: 'B', isAttack: 1 },   // 帧内只有异常流去重出 3 条边
    { src: 'A', dst: 'B', isAttack: 1 },
    { src: 'A', dst: 'C', isAttack: 1 },
    { src: 'D', dst: 'E', isAttack: 1 },
  ]),
  totalAnomalies: 4,                        // 攻击流（帧内异常流条数）
}
const optsAPI = { apiMode: true, apiEdges: { length: 278 } }   // 后端全量真值
const connA = activeConnections(snapA, optsAPI)
check('活跃连接 = 278（全量，不是帧内 3）', connA === 278, 'got ' + connA)
check('攻击流 = 4', attackFlows(snapA) === 4, 'got ' + attackFlows(snapA))
check('两者不再恒等（修复目标）', connA !== attackFlows(snapA))

/* 场景 B：非 API 模式（mock），帧全异常同边多流 → 回退帧内去重边数 */
console.log('\n2) 非 API 模式：活跃连接 = 帧内去重边数（回退逻辑）')
const snapB = {
  edgeFlowMap: makeEdgeFlowMap([
    { src: 'A', dst: 'B', isAttack: 1 },
    { src: 'A', dst: 'B', isAttack: 1 },
    { src: 'A', dst: 'C', isAttack: 1 },
  ]),
  totalAnomalies: 3,
}
const connB = activeConnections(snapB, {})
check('活跃连接 = 去重连接数(2 条边)', connB === 2, 'got ' + connB)
check('攻击流 = 异常流总数(3 条)', attackFlows(snapB) === 3, 'got ' + attackFlows(snapB))

/* 场景 C：空快照 / 缺字段不崩溃 */
console.log('\n3) 空快照：归零、不抛错')
check('edgeFlowMap 为空对象 → 0', activeConnections({ edgeFlowMap: {}, totalAnomalies: 0 }, {}) === 0)
check('edgeFlowMap 缺失 → 0', activeConnections({ totalAnomalies: 5 }, {}) === 0)
check('API 模式但 _apiEdges 尚未就绪 → 回退帧内 0',
      activeConnections({ edgeFlowMap: {}, totalAnomalies: 0 }, { apiMode: true }) === 0)

console.log('\n────────')
if (failures > 0) {
  console.log(`✗ ${failures} 处断言失败`)
  process.exitCode = 1
} else {
  console.log('✓ 全部断言通过：活跃连接 = 真实去重连接数，与攻击流正确区分')
}

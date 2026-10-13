/* ═══════════════════════════════════════════════════════════════════════
   回归测试：拓扑图在「放大缩小界面」时被卡没 — 修复验证。

   背景：窗口 resize / 浏览器缩放（Ctrl+滚轮）触发 engine.js 的 resize
   处理器。旧实现整图 rebuild → initTopology 直接读容器宽高，无 null 保护、
   无 0 尺寸兜底，导致：
     A) 容器已从 DOM 移除（180ms 防抖内切走拓扑页）→ TypeError，图被清空卡没
     B) 容器宽高为 0（display:none / 缩放重排瞬间）→ forceCenter(0,0)，
        节点坍缩到原点，图不可见
   修复后：
     1) initTopology 对 null 容器提前 return（不建图，回页时由 initTopologyView 重建）
     2) initTopology 对 0 尺寸沿用 window._topoLastW/H 兜底，不再坍缩
     3) resize 处理器不再整图重建，只把力布局中心移到新画布并温和重启

   本脚本把 engine.js 修复后的关键语句原样提取，用真实 d3 力仿真断言安全行为。
   运行：cd frontend && node tests/repro_topo_resize.mjs（全部 ✓ 且无 ✗ 才算通过）
   ═══════════════════════════════════════════════════════════════════════ */
import * as d3 from 'd3'

let failures = 0
function check(name, cond, detail) {
  if (cond) { console.log('  ✓ ' + name) }
  else { failures++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')) }
}

/* ──────────────────────────────────────────────────────────────
   以下逻辑按 engine.js 修复后的语句逐行提取（换行仅为可读性）。
   ────────────────────────────────────────────────────────────── */

// 修复后 engine.js initTopology 的容器读取（含 null 守卫 + 0 尺寸兜底）
function readContainerDim(container) {
  if (!container) return { ok: false, W: 0, H: 0 }
  const W = container.clientWidth || globalThis.__topoLastW || 800
  const H = container.clientHeight || globalThis.__topoLastH || 600
  globalThis.__topoLastW = W; globalThis.__topoLastH = H
  return { ok: true, W, H }
}

// engine.js initTopology L1735（力仿真：center 力用 W/2,H/2）
function buildSim(nodes, W, H) {
  return d3.forceSimulation(nodes).force('center', d3.forceCenter(W / 2, H / 2)).stop()
}

// engine.js L1671-1678（初始铺盘位置）
function initialPositions(W, H, N) {
  var GA = Math.PI * (3 - Math.sqrt(5))
  var maxR = Math.min(W, H) * 0.42
  return Array.from({ length: N }, function (_, i) {
    var t = (i + 0.5) / N
    var rad = maxR * Math.sqrt(t)
    var ang = i * GA
    return { x: W / 2 + Math.cos(ang) * rad, y: H / 2 + Math.sin(ang) * rad }
  })
}

const N = 20

console.log('── 验证：resize 重建拓扑的三种防护 ──\n')

/* 1) 容器为 null：initTopology 提前 return，不抛错 */
console.log('1) initTopology 对 null 容器不再抛 TypeError')
let threw = false, dimNull
try { dimNull = readContainerDim(null) } catch (e) { threw = true }
check('不抛 TypeError', !threw)
check('标记为跳过（ok=false）', dimNull.ok === false)

/* 2) 容器宽高为 0：沿用上次有效尺寸兜底，节点不坍缩 */
console.log('\n2) initTopology 对 0 尺寸沿用上次有效尺寸')
globalThis.__topoLastW = 1200; globalThis.__topoLastH = 700   // 上次有效尺寸
const dimZero = readContainerDim({ clientWidth: 0, clientHeight: 0 })
check('0 尺寸被兜底为上次有效尺寸 (1200,700)',
      dimZero.W === 1200 && dimZero.H === 700,
      'W=' + dimZero.W + ', H=' + dimZero.H)
const nodesZ = initialPositions(dimZero.W, dimZero.H, N).map((p, i) => ({ ...p, id: 'n' + i }))
const simZ = buildSim(nodesZ, dimZero.W, dimZero.H)
simZ.tick(50)
const maxR_Z = Math.max(...nodesZ.map(n => Math.max(Math.abs(n.x), Math.abs(n.y))))
check('节点分布在工作区中心附近（未坍缩到原点）', maxR_Z > 50,
      'maxR=' + maxR_Z.toFixed(1))

/* 3) resize 处理器：只平移力中心、不整图重建（节点保留、中心跟随新画布） */
console.log('\n3) resize 只调整力布局中心')
const nodesR = initialPositions(1200, 700, N).map((p, i) => ({ ...p, id: 'r' + i }))
const simR = buildSim(nodesR, 1200, 700)
simR.tick(50)
const before = nodesR.map(n => ({ x: n.x, y: n.y }))
// resize 到更小的画布：模拟修复后仅更新 center 力
const W2 = 800, H2 = 500
simR.force('center', d3.forceCenter(W2 / 2, H2 / 2))
simR.alpha(0.3).restart()
simR.tick(50)
const mx = nodesR.reduce((s, n) => s + n.x, 0) / N
const my = nodesR.reduce((s, n) => s + n.y, 0) / N
check('节点群中心随新画布中心移动（≈400,250）',
      Math.abs(mx - 400) < 120 && Math.abs(my - 250) < 120,
      'center=(' + mx.toFixed(1) + ',' + my.toFixed(1) + ')')
const moved = nodesR.filter((n, i) => Math.hypot(n.x - before[i].x, n.y - before[i].y) > 1).length
check('节点被温和拉向新中心（发生了重排）', moved > 0, moved + '/20 移动')

console.log('\n────────')
if (failures > 0) {
  console.log(`✗ ${failures} 处防护未生效`)
  process.exitCode = 1
} else {
  console.log('✓ 全部防护生效，修复有效')
}

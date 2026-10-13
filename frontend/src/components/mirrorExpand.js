/* ═══════════════════════════════════════════════════════════════════════
   侧栏模块放大：原件 → 克隆 实时镜像（纯 DOM 逻辑，无 gsap 依赖，便于测试）。
   原件模块的每次 DOM 更新（文本 / 样式 / 类名 / 属性 / 子节点增删）都通过
   MutationObserver 同步到放大中的克隆；canvas 像素无法镜像，原件画布重绘时
   按放大尺寸把克隆画布重绘（window.renderSnapshotInto）。
   使用方法（见 panelExpand.js）：
     startMirror(active)  —— active 需含 el(原件模块)、clone、timeline/dist(原件 canvas)
                             cloneTimeline/cloneDist(克隆 canvas)
     stopMirror(active)   —— 断开 observer、清除待执行的重绘
   ═══════════════════════════════════════════════════════════════════════ */

let chartTimer = null

/* 原↔克隆节点映射：深度优先并行遍历，克隆侧节点挂 _orig 指向原件对应节点。
   文本节点没有 childNodes，需先判空再递归。 */
export function linkMirror(origRoot, cloneRoot) {
  function walk(o, c) {
    c._orig = o
    const oKids = o.childNodes, cKids = c.childNodes
    if (!oKids || !cKids) return
    const n = Math.min(oKids.length, cKids.length)
    for (let i = 0; i < n; i++) walk(oKids[i], cKids[i])
  }
  walk(origRoot, cloneRoot)
}

/* 在克隆树里找原件 origNode 对应的节点（按 _orig 引用匹配） */
export function findMirror(root, origNode) {
  let found = null
  function walk(n) {
    if (found) return
    if (n._orig === origNode) { found = n; return }
    const kids = n.childNodes
    if (!kids) return
    for (let i = 0; i < kids.length; i++) walk(kids[i])
  }
  walk(root)
  return found
}

/* 原件 canvas 重绘 → 节流后按放大尺寸重绘克隆画布（ratio 环由属性镜像实时同步，不需重绘） */
function scheduleChartRender(a) {
  if (chartTimer || !a) return
  chartTimer = setTimeout(function () {
    chartTimer = null
    if (a && a.cloneTimeline && a.cloneDist && window.renderSnapshotInto) {
      window.renderSnapshotInto({ timeline: a.cloneTimeline, dist: a.cloneDist, ratio: null })
    }
  }, 80)
}

/* 启动镜像：观察原件模块子树，把每次变更同步到克隆。返回 observer。 */
export function startMirror(a) {
  const { el: original, clone, timeline, dist } = a
  linkMirror(original, clone)
  const obs = new MutationObserver(function (muts) {
    for (let i = 0; i < muts.length; i++) {
      const m = muts[i], t = m.target
      if (m.type === 'attributes') {
        // 原件 canvas 重绘（width/height 属性变化）→ 同步重绘克隆画布，属性本身不镜像
        if (t === timeline || t === dist) { scheduleChartRender(a); continue }
        const cn = findMirror(clone, t)
        if (!cn) continue
        const name = m.attributeName
        if (t.hasAttribute(name)) cn.setAttribute(name, t.getAttribute(name))
        else cn.removeAttribute(name)
      } else if (m.type === 'characterData') {
        const cn = findMirror(clone, t)
        if (cn && cn.nodeType === 3) cn.data = t.data
      } else if (m.type === 'childList') {
        const cp = findMirror(clone, t)
        if (!cp) continue
        // 新增节点：克隆后按顺序插到克隆里对应位置
        for (let j = 0; j < m.addedNodes.length; j++) {
          const n = m.addedNodes[j]
          const cn = n.cloneNode(true)
          linkMirror(n, cn)
          const ns = m.nextSibling
          if (ns) {
            const cns = findMirror(clone, ns)
            if (cns && cns.parentNode) cns.parentNode.insertBefore(cn, cns)
            else cp.appendChild(cn)
          } else cp.appendChild(cn)
        }
        // 移除节点：从克隆里移除对应节点
        for (let j = 0; j < m.removedNodes.length; j++) {
          const n = m.removedNodes[j]
          const cn = findMirror(clone, n)
          if (cn && cn.parentNode) cn.parentNode.removeChild(cn)
        }
      }
    }
  })
  obs.observe(original, { childList: true, subtree: true, characterData: true, attributes: true })
  a.obs = obs
  return obs
}

/* 停止镜像：断开 observer、清除待执行的重绘 */
export function stopMirror(a) {
  if (a && a.obs) { try { a.obs.disconnect() } catch (err) {} a.obs = null }
  if (chartTimer) { clearTimeout(chartTimer); chartTimer = null }
}

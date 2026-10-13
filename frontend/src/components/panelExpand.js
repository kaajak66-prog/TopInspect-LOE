/* ═══════════════════════════════════════════════════════════════════════
   侧栏模块点击放大 —— FLIP 过渡 + 实时镜像（左右面板各模块共用）。
   点击任意一个模块（卡片）→ 克隆一份该模块，从原位平滑放大到屏幕中央舞台；
   原模块保持原位不动（界面不变化），放大内容为克隆，并通过 MutationObserver
   把原件的每一次实时更新（文本/样式/类名/属性/子节点）镜像到克隆，时间轴与
   分数分布画布按放大尺寸同步重绘 —— 放大后是「活的」，不是冻结截图。
   点右上角「×」/ 点遮罩空白处 / 按 Esc → 反向 FLIP 缩回原位后移除克隆。
   模块内部的按钮/链接等交互控件仍正常工作（点击它们不会触发放大）。
   全程 GSAP 缓动（expo.out / back.out），丝滑不跳变。
   ═══════════════════════════════════════════════════════════════════════ */
import gsap from 'gsap'
import { startMirror, stopMirror } from './mirrorExpand.js'

let active = null   // { el, clone, mask, stage, close, dx, dy, sx, sy, obs, timeline, dist, cloneTimeline, cloneDist }

// 模块内部这些控件点击时交给它们自己处理，不触发放大
const INTERACTIVE = 'button, a, input, select, textarea, [onclick]'

function _onKey(e) {
  if (e.key === 'Escape' || e.keyCode === 27) collapseModule()
}

export function expandModule(el) {
  if (!el || !document.body.contains(el)) return
  // 若已有放大的克隆但已从 DOM 移除（残留遮罩），先清理
  if (active && !document.body.contains(active.clone)) {
    stopMirror(active)
    try { active.mask.remove() } catch (err) {}
    active = null
  }
  if (active) return   // 同一时间只允许放大一个模块

  const first = el.getBoundingClientRect()
  if (first.width < 20 || first.height < 20) return   // 尚未布局完成则忽略

  // —— 克隆模块（原件保持原位不动）。克隆后 canvas 画布内容会丢失，重绘由镜像接管 ——
  const clone = el.cloneNode(true)
  const timeline = el.querySelector('#chartTimeline')          // 原件 canvas（检测重绘）
  const dist = el.querySelector('#chartScoreDist')
  const cloneTimeline = clone.querySelector('#chartTimeline')  // 克隆 canvas（重绘目标）
  const cloneDist = clone.querySelector('#chartScoreDist')

  // —— 搭建遮罩 + 舞台 + × ——
  const mask = document.createElement('div')
  mask.className = 'panel-expand-mask'
  const stage = document.createElement('div')
  stage.className = 'panel-expand-stage'
  const close = document.createElement('button')
  close.className = 'panel-expand-close'
  close.type = 'button'
  close.title = '退出放大 (Esc)'
  close.innerHTML = '<i class="fa-solid fa-xmark"></i>'
  close.addEventListener('click', function (e) { e.stopPropagation(); collapseModule() })
  stage.appendChild(close)
  mask.appendChild(stage)
  document.body.appendChild(mask)
  mask.addEventListener('mousedown', function (e) { if (e.target === mask) collapseModule() })

  // 克隆进舞台并铺满
  stage.appendChild(clone)
  clone.classList.add('panel-expanded')

  // —— FLIP：量「末」位 → 反算「首」位初始变换 → 播放归位 ——
  const last = clone.getBoundingClientRect()
  const dx = first.left - last.left
  const dy = first.top - last.top
  const sx = first.width / last.width
  const sy = first.height / last.height
  active = { el, clone, mask, stage, close, dx, dy, sx, sy, timeline, dist, cloneTimeline, cloneDist }

  gsap.set(clone, { x: dx, y: dy, scaleX: sx, scaleY: sy, transformOrigin: '0 0', force3D: true, willChange: 'transform' })
  gsap.set(mask, { opacity: 0 })
  gsap.set(close, { opacity: 0, scale: 0.4 })

  const tl = gsap.timeline()
  tl.to(mask, { opacity: 1, duration: 0.3, ease: 'power2.out' }, 0)
  // clearProps：动画落位后清掉 GSAP 残留的内联 transform，CSS hover（× 旋转）与未来交互才生效
  tl.to(clone, { x: 0, y: 0, scaleX: 1, scaleY: 1, duration: 0.55, ease: 'expo.out', clearProps: 'transform,willChange' }, 0.02)
  tl.to(close, { opacity: 1, scale: 1, duration: 0.28, ease: 'back.out(2.2)', clearProps: 'transform' }, '-=0.3')

  document.addEventListener('keydown', _onKey)

  // 启动实时镜像：原件的一切更新同步到克隆（文本/样式/占比环动画/回放进度…）
  startMirror(active)

  // 首次按放大尺寸重绘克隆画布（画布像素克隆不过来）
  if (window.renderSnapshotInto) {
    setTimeout(function () {
      window.renderSnapshotInto({ timeline: cloneTimeline, dist: cloneDist, ratio: null })
    }, 150)
  } else if (window.refreshCharts) {
    setTimeout(window.refreshCharts, 150)
  }
}

/* 组件卸载时的兜底清理：若有放大中的克隆残留，直接移除遮罩。 */
export function forceReset() {
  if (!active) return
  const { clone, mask, close } = active
  stopMirror(active)
  gsap.killTweensOf([clone, mask, close])
  document.removeEventListener('keydown', _onKey)
  mask.remove()   // 连同克隆一起移除（原件在面板里不受影响）
  active = null
}

export function collapseModule() {
  if (!active) return
  const { clone, mask, close, dx, dy, sx, sy } = active
  stopMirror(active)   // 关闭镜像：收回过程不再跟随更新

  const tl = gsap.timeline({ onComplete: function () {
    mask.remove()   // 克隆随遮罩移除，原件始终在原位
    active = null
    document.removeEventListener('keydown', _onKey)
  }})

  // —— 反向 FLIP：沿展开时记录的 dx/dy/sx/sy 缩回原件位置 ——
  tl.to(close, { opacity: 0, scale: 0.4, duration: 0.12, ease: 'power2.in' }, 0)
  tl.to(clone, { x: dx, y: dy, scaleX: sx, scaleY: sy, duration: 0.5, ease: 'expo.in' }, 0.03)
  tl.to(mask, { opacity: 0, duration: 0.3, ease: 'power2.inOut' }, 0.05)
}

/* 给一个模块绑定「点击放大」：内部按钮等控件照常响应，不放大。
   返回解绑函数，供组件 onUnmounted 清理。 */
export function bindModule(el) {
  if (!el || el._panelBound) return null
  el._panelBound = true
  function handler(e) {
    if (e.target.closest && e.target.closest(INTERACTIVE)) return
    expandModule(el)
  }
  el.addEventListener('click', handler)
  return function unbind() {
    el.removeEventListener('click', handler)
    el._panelBound = false
  }
}

export default { expandModule, collapseModule, forceReset, bindModule }

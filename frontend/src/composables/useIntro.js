import gsap from 'gsap'

// 搬自老版 graph-v4-3d.html 开场动画 IIFE（2578-2702）。
// 渲染/编排逻辑逐行保留，仅 2 处适配：
//   ① 不再 getElementById('introOverlay')，改用传入的 overlay 元素 + 其内部 querySelector；
//   ② finish() 结尾不 removeChild，改为调用 onFinish() 让 Vue 的 v-if 卸载组件。
export function useIntro(overlay, onFinish) {
  if (!overlay) { onFinish && onFinish(); return () => {} }
  if (typeof gsap === 'undefined') { onFinish && onFinish(); return () => {} }

  const $ = (sel) => overlay.querySelector(sel)
  const canvas = overlay.querySelector('#introCanvas'), ctx = canvas.getContext('2d')
  let W = 0, H = 0, cx = 0, cy = 0
  const DPR = Math.min(window.devicePixelRatio || 1, 2)
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  function resize() { W = canvas.clientWidth; H = canvas.clientHeight; canvas.width = W * DPR; canvas.height = H * DPR; ctx.setTransform(DPR, 0, 0, DPR, 0, 0); cx = W / 2; cy = H * 0.46 }
  resize(); window.addEventListener('resize', resize)

  /* ── 构建 3D 神经网络图谱(黄金螺旋球面分布 + 最近邻连边)── */
  const RAD = Math.min(W, H) * 0.34, N = reduce ? 22 : 40, FOCAL = 620
  const NODES = [], EDGES = []
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1), phi = Math.acos(1 - 2 * t), th = Math.PI * (1 + Math.sqrt(5)) * i, rr = RAD * (0.55 + 0.45 * Math.random())
    const anomaly = (i % 13 === 5) || (i % 17 === 9)
    NODES.push({ hx: rr * Math.sin(phi) * Math.cos(th), hy: rr * Math.cos(phi) * 0.72, hz: rr * Math.sin(phi) * Math.sin(th),
      sx: (Math.random() - 0.5) * W * 2.6, sy: (Math.random() - 0.5) * H * 2.6, sz: (Math.random() - 0.5) * RAD * 4,
      x: 0, y: 0, z: 0, prog: 0, r: anomaly ? 3.4 : (2 + Math.random() * 2.2), core: i < 6, anomaly: anomaly, px: 0, py: 0, ps: 1, depth: 0 })
  }
  for (let a = 0; a < NODES.length; a++) {
    const ds = []
    for (let b = 0; b < NODES.length; b++) { if (a === b) continue; const dx = NODES[a].hx - NODES[b].hx, dy = NODES[a].hy - NODES[b].hy, dz = NODES[a].hz - NODES[b].hz; ds.push({ b: b, d: dx * dx + dy * dy + dz * dz }) }
    ds.sort(function (m, n) { return m.d - n.d })
    const k = NODES[a].core ? 3 : 2
    for (let e = 0; e < k && e < ds.length; e++) {
      const bi = ds[e].b, lo = Math.min(a, bi), hi = Math.max(a, bi); let ex = false
      for (let q = 0; q < EDGES.length; q++) { if (EDGES[q].a === lo && EDGES[q].b === hi) { ex = true; break } }
      if (!ex) EDGES.push({ a: lo, b: hi, prog: 0, flow: Math.random(), anomaly: NODES[lo].anomaly || NODES[hi].anomaly })
    }
  }

  /* ── 投影与绘制 ── */
  let rotY = -0.6, gAlpha = 0, camPush = 0, running = true, rafId = null, finished = false, autoTween = null
  function project(p) { const c = Math.cos(rotY), s = Math.sin(rotY), X = p.x * c - p.z * s, Z = p.x * s + p.z * c, sc = FOCAL / (FOCAL + Z), pu = 1 + camPush * 1.8; p.px = cx + X * sc * pu; p.py = cy + p.y * sc * pu; p.ps = sc * pu; p.depth = Z }
  function draw() {
    ctx.clearRect(0, 0, W, H)
    if (gAlpha <= 0.002) return
    for (let i = 0; i < NODES.length; i++) { const n = NODES[i], e = n.prog; n.x = n.sx + (n.hx - n.sx) * e; n.y = n.sy + (n.hy - n.sy) * e; n.z = n.sz + (n.hz - n.sz) * e; project(n) }
    const ord = NODES.slice().sort(function (p, q) { return p.depth - q.depth })
    ctx.globalCompositeOperation = 'lighter'
    for (let k = 0; k < EDGES.length; k++) {
      const ed = EDGES[k]; if (ed.prog <= 0) continue
      const na = NODES[ed.a], nb = NODES[ed.b], col = ed.anomaly ? '255,70,100' : '0,200,255', dp = (na.ps + nb.ps) / 2
      const bx = na.px + (nb.px - na.px) * ed.prog, by = na.py + (nb.py - na.py) * ed.prog
      ctx.strokeStyle = 'rgba(' + col + ',' + (0.11 * gAlpha * dp).toFixed(3) + ')'; ctx.lineWidth = Math.max(0.5, dp)
      ctx.beginPath(); ctx.moveTo(na.px, na.py); ctx.lineTo(bx, by); ctx.stroke()
      if (ed.prog >= 1 && dp > 0) { const fl = ed.flow = (ed.flow + 0.005) % 1, fx = na.px + (nb.px - na.px) * fl, fy = na.py + (nb.py - na.py) * fl, fr = 5 * dp
        const fg = ctx.createRadialGradient(fx, fy, 0, fx, fy, fr); fg.addColorStop(0, 'rgba(' + col + ',' + (0.85 * gAlpha).toFixed(3) + ')'); fg.addColorStop(1, 'rgba(' + col + ',0)')
        ctx.fillStyle = fg; ctx.beginPath(); ctx.arc(fx, fy, fr, 0, 6.2832); ctx.fill() }
    }
    for (let o = 0; o < ord.length; o++) {
      const nd = ord[o], c2 = nd.anomaly ? '255,70,100' : (nd.core ? '130,235,255' : '0,200,255'), rad = nd.r * nd.ps, am = Math.max(0.12, Math.min(1, nd.ps)) * gAlpha * Math.max(0, nd.prog)
      if (rad <= 0) continue // 镜头后方(ps<=0)的节点跳过，避免 createRadialGradient 负半径抛错
      const g = ctx.createRadialGradient(nd.px, nd.py, 0, nd.px, nd.py, rad * 5); g.addColorStop(0, 'rgba(' + c2 + ',' + (0.5 * am).toFixed(3) + ')'); g.addColorStop(1, 'rgba(' + c2 + ',0)')
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(nd.px, nd.py, rad * 5, 0, 6.2832); ctx.fill()
      ctx.fillStyle = 'rgba(' + c2 + ',' + am.toFixed(3) + ')'; ctx.beginPath(); ctx.arc(nd.px, nd.py, rad, 0, 6.2832); ctx.fill()
      ctx.fillStyle = 'rgba(255,255,255,' + (0.85 * am).toFixed(3) + ')'; ctx.beginPath(); ctx.arc(nd.px, nd.py, Math.max(0.6, rad * 0.34), 0, 6.2832); ctx.fill()
    }
    ctx.globalCompositeOperation = 'source-over'
  }
  function loop() { if (!running) return; rafId = requestAnimationFrame(loop); if (!reduce) rotY += 0.0016; draw() }

  /* ── 按钮呼吸 ── */
  function pulseEnter() { gsap.to('#introEnter', { boxShadow: '0 0 28px rgba(0,212,255,0.55)', repeat: -1, yoyo: true, duration: 1.0, ease: 'sine.inOut' }) }

  /* ── 收尾溶解:镜头推进 + 整体淡出 → 露出主界面（结尾改为 onFinish 让 Vue 卸载）── */
  function finish() {
    if (finished) return; finished = true
    if (autoTween) autoTween.kill(); gsap.killTweensOf('#introEnter')
    window.removeEventListener('keydown', keyH)
    const out = gsap.timeline({ onComplete: function () { running = false; if (rafId) cancelAnimationFrame(rafId); window.removeEventListener('resize', resize); if (onFinish) onFinish() } })
    out.to({ p: 0 }, { p: 1, duration: 0.9, ease: 'power2.in', onUpdate: function () { camPush = this.targets()[0].p; gAlpha = 1 - this.targets()[0].p * 0.92 } }, 0)
    out.to('#introHud', { scale: 1.06, opacity: 0, duration: 0.7, ease: 'power2.in' }, 0)
    out.to([overlay.querySelector('.intro-corner'), '#introTopline', '#introSkip'].filter(Boolean), { opacity: 0, duration: 0.5 }, 0)
    out.to(overlay, { opacity: 0, duration: 0.7, ease: 'power2.inOut' }, 0.25)
  }
  function keyH(e) { if (e.key === 'Enter' || e.key === 'Escape' || e.key === ' ') { e.preventDefault(); finish() } }

  const enterBtn = $('#introEnter'), skipBtn = $('#introSkip')
  if (enterBtn) enterBtn.addEventListener('click', finish)
  if (skipBtn) skipBtn.addEventListener('click', finish)
  window.addEventListener('keydown', keyH)

  /* ── 入场序列编排 ── */
  function startEnter() {
    loop()
    gsap.set('.intro-title .ch', { transformPerspective: 600 })
    if (reduce) {
      for (let i = 0; i < NODES.length; i++) NODES[i].prog = 1
      for (let k = 0; k < EDGES.length; k++) EDGES[k].prog = 1
      gAlpha = 1; rotY = -0.3
      gsap.set(['.intro-corner', '.intro-topline', '.intro-skip', '#introHud', '.intro-title .ch', '#introWelcome', '#introEnter'], { opacity: 1, y: 0 })
      gsap.set('#introDivider', { width: '72%' })
      gsap.set('#introEnter', { boxShadow: '0 0 20px rgba(0,212,255,0.4)' })
      return
    }
    const tl = gsap.timeline({ defaults: { ease: 'power2.out' } })
    tl.to({ v: 0 }, { v: 1, duration: 1.0, onUpdate: function () { gAlpha = this.targets()[0].v } }, 0)
    tl.to(NODES, { prog: 1, duration: 1.6, ease: 'power3.out', stagger: { each: 0.018, from: 'random' } }, 0.15)
    tl.to({ a: -0.6 }, { a: -0.16, duration: 2.4, ease: 'sine.inOut', onUpdate: function () { rotY = this.targets()[0].a } }, 0.2)
    tl.to(EDGES, { prog: 1, duration: 0.9, ease: 'power1.inOut', stagger: { each: 0.012, from: 'random' } }, 1.0)
    tl.to('.intro-corner', { opacity: 1, duration: 0.6, stagger: 0.08 }, 0.3)
    tl.to('.intro-topline', { opacity: 1, duration: 0.8 }, 0.5)
    tl.to('.intro-skip', { opacity: 1, duration: 0.6 }, 0.9)
    tl.fromTo('#introHud', { opacity: 0, y: 28, scale: 0.95 }, { opacity: 1, y: 0, scale: 1, duration: 0.9, ease: 'power3.out' }, 1.9)
    tl.fromTo('.intro-title .ch', { opacity: 0, y: 20, rotateX: -70 }, { opacity: 1, y: 0, rotateX: 0, duration: 0.55, ease: 'back.out(1.6)', stagger: 0.06 }, 2.2)
    tl.fromTo('#introWelcome', { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.6 }, 2.7)
    tl.to('#introDivider', { width: '72%', duration: 0.7, ease: 'power2.inOut' }, 2.8)
    tl.to('#introEnter', { opacity: 1, duration: 0.6, onComplete: function () { pulseEnter() } }, 3.1)
  }
  requestAnimationFrame(startEnter)

  return function dispose() {
    running = false; if (rafId) cancelAnimationFrame(rafId)
    window.removeEventListener('resize', resize); window.removeEventListener('keydown', keyH)
  }
}

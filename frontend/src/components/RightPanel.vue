<template>
  <div id="right-panel">
    <div class="card spot panel-module" style="padding:8px 10px;">
      <div class="spot-glow"></div>
      <div class="card-title titlefx" style="margin-bottom:5px;"><i class="fa-solid fa-chart-pie tfx-ico"></i> 异常占比</div>
      <div class="ratio-wrap" style="position:relative; flex:1; min-height:0; margin:2px 0 4px;">
        <div class="ring-track" style="position:absolute; inset:0; margin:auto; width:96px; height:96px; border-radius:50%; border:2px solid rgba(255,255,255,0.04); box-shadow:inset 0 0 30px rgba(0,212,255,0.05);"></div>
        <div class="ring-data" style="position:absolute; inset:0; margin:auto; width:96px; height:96px; filter:drop-shadow(0 0 12px rgba(0,212,255,0.4));">
          <svg width="96" height="96" viewBox="0 0 100 100" style="overflow:visible">
            <defs>
              <linearGradient id="neonGlowRatio" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#4df0ff" /><stop offset="50%" stop-color="#00d4ff" /><stop offset="100%" stop-color="#0055ff" />
              </linearGradient>
              <linearGradient id="neonGlowRed" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#ffc24d" /><stop offset="50%" stop-color="#ff9500" /><stop offset="100%" stop-color="#8a4d00" />
              </linearGradient>
              <filter id="blurGlowRatio">
                <feGaussianBlur stdDeviation="4" result="coloredBlur"/>
                <feMerge><feMergeNode in="coloredBlur"/><feMergeNode in="SourceGraphic"/></feMerge>
              </filter>
            </defs>
            <circle id="ratioSvgCircle" cx="50" cy="50" r="40" fill="none" stroke="url(#neonGlowRatio)" stroke-width="8" stroke-linecap="round" stroke-dasharray="251.32" stroke-dashoffset="251.32" filter="url(#blurGlowRatio)" transform="rotate(-90 50 50)" />
          </svg>
        </div>
        <div class="center-data" style="position:absolute; inset:0; margin:auto; display:flex; flex-direction:column; align-items:center; justify-content:center;">
          <div id="ratioNumber" style="font-family:'JetBrains Mono', monospace; font-size:22px; font-weight:bold; background:linear-gradient(180deg, #ffffff 0%, #a0c4d8 100%); -webkit-background-clip:text; -webkit-text-fill-color:transparent; margin:0; line-height:1; letter-spacing:-1px;">--</div>
          <div class="ratio-caption" style="font-size:7px; color:var(--text-dim); letter-spacing:2px; text-transform:uppercase; margin-top:4px; font-weight:600;">异常占比</div>
        </div>
      </div>
      <div id="ratioLabel" style="position:relative; text-align:center; font-size:8px; color:var(--text-dim);">等待数据...</div>
    </div>

    <div class="card spot panel-module" style="padding:8px 10px;">
      <div class="spot-glow"></div>
      <div class="card-title titlefx" style="margin-bottom:5px;"><i class="fa-solid fa-wave-square tfx-ico"></i> 异常时间轴</div>
      <div class="timeline-scroll">
        <canvas id="chartTimeline" style="height:95px;display:block"></canvas>
      </div>
      <div class="chart-legend">
        <span class="cl-item"><span class="cl-dot" style="background:#ff9500"></span>每步异常数</span>
        <span class="cl-item" style="margin-left:auto;color:var(--text-dim)">横轴: 时间步 →</span>
      </div>
    </div>
    <div class="card spot panel-module" style="padding:8px 10px;">
      <div class="spot-glow"></div>
      <div class="card-title titlefx" style="margin-bottom:5px;"><i class="fa-solid fa-chart-column tfx-ico"></i> 分数分布</div>
      <canvas id="chartScoreDist" class="mini-chart"></canvas>
      <div class="chart-legend">
        <span class="cl-item"><span class="cl-dot" style="background:#3b82f6"></span>正常</span>
        <span class="cl-item"><span class="cl-dot" style="background:#ff9500"></span>警告</span>
        <span class="cl-item"><span class="cl-dot" style="background:#ff2d55"></span>严重</span>
        <span class="cl-item" style="margin-left:auto;color:var(--text-dim)">横轴: 异常分数(×阈值)</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue'
import { bindModule, forceReset } from './panelExpand.js'

// Spotlight：右面板卡片 hover 跟随光晕（与左面板一致）
let panel = null
const unbind = []
function onMove(e) {
  const card = e.target.closest?.('.card.spot')
  if (!card) return
  const r = card.getBoundingClientRect()
  card.style.setProperty('--mx', (e.clientX - r.left) + 'px')
  card.style.setProperty('--my', (e.clientY - r.top) + 'px')
}
onMounted(() => {
  panel = document.getElementById('right-panel')
  panel?.addEventListener('mousemove', onMove)
  // 每个模块点击放大（模块内部按钮等控件不受影响）
  panel?.querySelectorAll('.panel-module').forEach(el => {
    const u = bindModule(el)
    if (u) unbind.push(u)
  })
})
onUnmounted(() => {
  panel?.removeEventListener('mousemove', onMove)
  unbind.forEach(fn => fn())
  forceReset()   // 组件卸载时若仍有放大中的模块则清理残留遮罩
})
</script>

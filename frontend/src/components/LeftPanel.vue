<template>
<div id="left-panel">
      <div class="card spot panel-module">
        <div class="spot-glow"></div>
        <div class="card-title titlefx"><i class="fa-solid fa-gauge-high tfx-ico"></i> 实时统计</div>
        <div class="stat-row">
          <div class="stat-cell"><div class="val" style="color:var(--accent)" id="lcFlows">—</div><div class="lbl">总流量</div></div>
          <div class="stat-cell"><div class="val" style="color:var(--warn)" id="lcAnomalies">—</div><div class="lbl">异常数</div></div>
        </div>
        <div class="stat-row">
          <div class="stat-cell"><div class="val" style="color:var(--warn)" id="lcLatency">—</div><div class="lbl">延迟</div></div>
        </div>
      </div>
      <div class="card spot panel-module">
        <div class="spot-glow"></div>
        <div class="card-title titlefx"><i class="fa-solid fa-shield-virus tfx-ico"></i> 威胁概览</div>
        <div class="threat-grid">
          <div class="threat-cell critical"><div class="tc-num" id="tovCritical">0</div><div class="tc-lbl">危险节点</div></div>
          <div class="threat-cell warning"><div class="tc-num" id="tovWarning">0</div><div class="tc-lbl">警告节点</div></div>
          <div class="threat-cell safe"><div class="tc-num" id="tovSafe">0</div><div class="tc-lbl">安全节点</div></div>
        </div>
        <div class="threat-meter">
          <div class="tm-label"><span>受影响节点占比</span><span id="tovAffectedPct">0%</span></div>
          <div class="tm-track"><div class="tm-fill" id="tovAffectedBar" style="width:0%"></div></div>
        </div>
        <div class="threat-foot">
          <span><i class="fa-solid fa-network-wired"></i> 活跃连接 <b id="tovEdges">0</b></span>
          <span><i class="fa-solid fa-bolt"></i> 攻击流 <b id="tovAttackFlows">0</b></span>
        </div>
      </div>
      <div class="card spot panel-module">
        <div class="spot-glow"></div>
        <div class="card-title titlefx"><i class="fa-solid fa-circle-play tfx-ico"></i> 回放控制</div>
        <div class="replay-btns">
          <button onclick="replaySkipBack()" title="回到起点"><i class="fa-solid fa-backward"></i></button>
          <button onclick="replayStepBack()" title="上一步"><i class="fa-solid fa-caret-left"></i></button>
          <button onclick="toggleReplay()" id="btnPlayPause"><i class="fa-solid fa-play"></i></button>
          <button onclick="replayStepForward()" title="下一步"><i class="fa-solid fa-caret-right"></i></button>
          <button onclick="replaySkipForward()" title="跳到结尾"><i class="fa-solid fa-forward"></i></button>
        </div>
        <button onclick="resetReplayData()" class="replay-reset" style="width:100%;margin-top:6px;padding:4px;background:rgba(255,45,85,0.06);border:1px solid rgba(255,45,85,0.15);color:var(--danger);font-size:8px;font-family:var(--font-mono);border-radius:3px;cursor:pointer;transition:all 0.2s"><i class="fa-solid fa-rotate-left"></i> 重置全部数据</button>
        <div class="replay-progress" style="max-width:none"><div class="fill" id="replayFill2"></div></div>
        <div class="replay-meta" style="display:flex;justify-content:space-between;align-items:center;font-size:9px;color:var(--text-dim);margin-top:4px;font-family:var(--font-mono)">
          <span id="replayCurrent">00:00</span>
          <span class="replay-pct" id="replayPct">0%</span>
          <span id="replaySpeed">1x</span>
          <span id="replayTotal">00:00</span>
        </div>
      </div>
    </div>
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue'
import { RouterLink } from 'vue-router'
import { bindModule, forceReset } from './panelExpand.js'

// Spotlight：卡片 hover 时让光晕跟随鼠标（借鉴 ReactBits SpotlightCard）
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
  panel = document.getElementById('left-panel')
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

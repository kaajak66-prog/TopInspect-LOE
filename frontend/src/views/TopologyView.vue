<script setup>
import { onMounted, onUnmounted, nextTick } from 'vue'
import LeftPanel from '../components/LeftPanel.vue'
import RightPanel from '../components/RightPanel.vue'
import TopologyArea from '../components/TopologyArea.vue'
import { initTopologyView, teardownTopologyView } from '../engine'

onMounted(async () => {
  await nextTick()
  initTopologyView()
})
onUnmounted(() => {
  teardownTopologyView()
})
</script>

<template>
  <!-- 栅格 minmax 约束：窗口变窄时侧栏收缩，不与画布重叠；
       侧栏内容超高时在面板内部上下滚动（滚动条样式见 main.css #left-panel/#right-panel） -->
  <div id="main-area" style="display:grid;grid-template-columns:minmax(210px,300px) minmax(0,1fr) minmax(210px,300px);grid-template-rows:minmax(0,1fr) auto;gap:12px;flex:1;overflow:hidden;padding:12px;">
    <LeftPanel />
    <TopologyArea />
    <RightPanel />
    <!-- 实时告警流：横跨左中右三列，占满左右面板下方空白 -->
    <div id="topo-alert-strip">
      <div class="strip-head">
        <span class="strip-title"><i class="fa-solid fa-bell" style="margin-right:4px;color:var(--accent)"></i>告警流</span>
        <span class="strip-count" id="alertCount">0</span>
        <div class="strip-filters">
          <button class="sf-btn active" data-af="all" onclick="setAlertFilter('all',this)">全部</button>
          <button class="sf-btn" data-af="critical" onclick="setAlertFilter('critical',this)">严重</button>
          <button class="sf-btn" data-af="warning" onclick="setAlertFilter('warning',this)">警告</button>
        </div>
      </div>
      <div id="alertStream" style="flex:1;overflow-y:auto"></div>
      <div class="strip-fade-b"></div>
    </div>
  </div>
</template>

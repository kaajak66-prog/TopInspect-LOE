<script setup>
import { onMounted, nextTick } from 'vue'
import { RouterLink } from 'vue-router'
import { renderDashboard } from '../engine'

onMounted(async () => { await nextTick(); renderDashboard() })
</script>

<template>
  <div class="page-overlay active" id="page-dashboard">
    <div class="po-header">
      <div class="po-head-left">
        <span class="po-title"><i class="fa-solid fa-gauge-high"></i> 仪表盘</span>
        <span class="po-sub">实时检测态势总览</span>
      </div>
      <div class="po-actions">
        <RouterLink to="/topology" class="po-back"><i class="fa-solid fa-diagram-project"></i> 返回拓扑</RouterLink>
      </div>
    </div>
    <div class="po-body" id="dashboardBody"></div>
  </div>
</template>

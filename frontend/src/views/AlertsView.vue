<script setup>
import { onMounted, nextTick } from 'vue'
import { RouterLink } from 'vue-router'
import { renderAlerts } from '../engine'

onMounted(async () => { await nextTick(); renderAlerts() })
</script>

<template>
  <div class="page-overlay active" id="page-alerts">
    <div class="po-header">
      <div class="po-head-left">
        <span class="po-title"><i class="fa-solid fa-triangle-exclamation"></i> 告警列表</span>
        <span class="po-sub">检测告警明细与处置</span>
      </div>
      <div class="po-actions">
        <RouterLink to="/topology" class="po-back"><i class="fa-solid fa-diagram-project"></i> 返回拓扑</RouterLink>
      </div>
    </div>
    <div class="po-body" id="alertsBody"></div>
  </div>
</template>

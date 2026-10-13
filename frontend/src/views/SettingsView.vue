<script setup>
import { onMounted, nextTick } from 'vue'
import { RouterLink } from 'vue-router'
import { renderSettings } from '../engine'

onMounted(async () => { await nextTick(); renderSettings() })
</script>

<template>
  <div class="page-overlay active" id="page-settings">
    <div class="po-header">
      <div class="po-head-left">
        <span class="po-title"><i class="fa-solid fa-sliders"></i> 系统设置</span>
        <span class="po-sub">检测参数与系统配置</span>
      </div>
      <div class="po-actions">
        <RouterLink to="/topology" class="po-back"><i class="fa-solid fa-diagram-project"></i> 返回拓扑</RouterLink>
      </div>
    </div>
    <div class="po-body" id="settingsBody"></div>
  </div>
</template>

<script setup>
import { onMounted, nextTick } from 'vue'
import { RouterLink } from 'vue-router'
import { initUploadHandlers } from '../engine'

onMounted(async () => { await nextTick(); initUploadHandlers() })
</script>

<template>
  <div class="page-overlay active" id="page-upload">
    <div class="po-header">
      <div class="po-head-left">
        <span class="po-title"><i class="fa-solid fa-cloud-arrow-up"></i> 数据上传</span>
        <span class="po-sub">导入 NetFlow CSV 进行入侵检测分析</span>
      </div>
      <div class="po-actions">
        <RouterLink to="/topology" class="po-back"><i class="fa-solid fa-diagram-project"></i> 返回拓扑</RouterLink>
      </div>
    </div>
    <div class="po-body" id="uploadBody"></div>
  </div>
</template>

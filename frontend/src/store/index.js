import { reactive } from 'vue'

// API 基址：file:// 直开时打到本地后端，否则同源（由 FastAPI 托管时为空）
export const API_BASE = (location.protocol === 'file:') ? 'http://localhost:8000' : ''

// 是否降级动画
export const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

// ═══ 共享响应式状态（替代老版散落的全局 var）═══
export const store = reactive({
  // 数据来源
  dataSource: { mode: '', jobId: null }, // '' 无数据 | 'api' 已检测

  // 回放
  replayState: { playing: false, position: 0, speed: 16 },
  TOTAL_STEPS: 300,

  // 数据缓存
  allFlows: [],
  alertData: [],
  currentSnapshot: null,
  apiMetrics: null,

  // 拓扑选中态
  selectedNodeId: null,
  selectedEdgeId: null,
})

// ═══ API 客户端（搬自老版 dataSource 的取数方法）═══
export const api = {
  async loadReplay(jobId) {
    const r = await fetch(API_BASE + '/api/jobs/' + jobId + '/replay')
    if (!r.ok) throw new Error('replay 拉取失败')
    return await r.json() // { nodes, edges, flows, total_steps }
  },
  async getMetrics(jobId) {
    const r = await fetch(API_BASE + '/api/jobs/' + jobId + '/metrics')
    return r.ok ? await r.json() : null
  },
  async getNodeDetail(jobId, ip) {
    const r = await fetch(API_BASE + '/api/jobs/' + jobId + '/nodes/' + encodeURIComponent(ip))
    return r.ok ? await r.json() : null
  },
  async getEdgeFlows(jobId, src, dst, page) {
    const r = await fetch(API_BASE + '/api/jobs/' + jobId + '/edges/' +
      encodeURIComponent(src) + '/' + encodeURIComponent(dst) + '?page=' + (page || 0))
    return r.ok ? await r.json() : null
  },
  async generateReport(jobId) {
    const r = await fetch(API_BASE + '/api/jobs/' + jobId + '/report', { method: 'POST' })
    if (!r.ok) throw new Error('报告生成失败（' + r.status + '），请确认已运行检测')
    return await r.json() // { job_id, generated_at, model, facts, ai_sections }
  },
}

export function hasDetectionData() {
  return store.dataSource.mode === 'api' && store.dataSource.jobId && store.apiMetrics
}

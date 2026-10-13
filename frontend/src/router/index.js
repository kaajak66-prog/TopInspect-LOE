import { createRouter, createWebHashHistory } from 'vue-router'
import TopologyView from '../views/TopologyView.vue'

// 加页面 = 在此加一条路由 + 一个 views/*.vue 组件
const routes = [
  { path: '/', redirect: '/topology' },
  { path: '/topology', name: 'topology', component: TopologyView,
    meta: { title: '拓扑视图', icon: 'fa-diagram-project' } },
  { path: '/dashboard', name: 'dashboard', component: () => import('../views/DashboardView.vue'),
    meta: { title: '仪表盘', icon: 'fa-gauge-high' } },
  { path: '/alerts', name: 'alerts', component: () => import('../views/AlertsView.vue'),
    meta: { title: '告警列表', icon: 'fa-triangle-exclamation' } },
  { path: '/reports', name: 'reports', component: () => import('../views/ReportsView.vue'),
    meta: { title: '分析报告', icon: 'fa-chart-line' } },
  { path: '/upload', name: 'upload', component: () => import('../views/UploadView.vue'),
    meta: { title: '数据上传', icon: 'fa-cloud-arrow-up' } },
  { path: '/settings', name: 'settings', component: () => import('../views/SettingsView.vue'),
    meta: { title: '系统设置', icon: 'fa-sliders' } },
]

export const navRoutes = routes.filter(r => r.meta)

export default createRouter({
  history: createWebHashHistory(),
  routes,
})

import { ref } from 'vue'

// 主题状态：night（深空星云，默认）/ light（日间晴空）。
// 持久化到 localStorage；切换时同步 <html data-theme> 属性，
// CSS 变量与 useBackground3D 都据此切换。
const THEME_KEY = 'topinspect_theme'

function readInitial() {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'night'
  } catch (e) {
    return 'night'
  }
}

export const theme = ref(readInitial())

export function applyTheme(t) {
  theme.value = t === 'light' ? 'light' : 'night'
  try { localStorage.setItem(THEME_KEY, theme.value) } catch (e) {}
  document.documentElement.setAttribute('data-theme', theme.value)
}

export function toggleTheme() {
  applyTheme(theme.value === 'night' ? 'light' : 'night')
}

// 读取当前 CSS 变量的具体颜色值（canvas 绘制无法直接使用 var()，需取实值）。
export function cssColor(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return v || fallback
  } catch (e) {
    return fallback
  }
}

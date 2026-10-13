<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { useIntro } from '../composables/useIntro'

const emit = defineEmits(['finish'])
const overlay = ref(null)
let dispose = null

onMounted(() => {
  // 点击进入/跳过/按键 都由 useIntro 内部处理，结束时带溶解动画再回调 finish
  dispose = useIntro(overlay.value, () => emit('finish'))
})
onUnmounted(() => { if (dispose) dispose() })
</script>

<template>
  <div id="introOverlay" ref="overlay" role="dialog" aria-label="拓察 TopInspect 启动界面">
    <canvas id="introCanvas"></canvas>
    <div class="intro-vignette"></div>
    <div class="intro-corner tl"></div><div class="intro-corner tr"></div><div class="intro-corner bl"></div><div class="intro-corner br"></div>
    <div class="intro-topline" id="introTopline">TOPINSPECT<span class="dot"></span>SELF-SUPERVISED GRAPH INTRUSION DETECTION</div>
    <div class="intro-skip" id="introSkip">跳过 · SKIP</div>
    <div class="intro-hud" id="introHud">
      <div class="intro-eyebrow">SECURITY OPERATIONS CENTER</div>
      <div class="intro-title" id="introTitle"><span class="ch">T</span><span class="ch">o</span><span class="ch">p</span><span class="ch hl">I</span><span class="ch hl">n</span><span class="ch hl">s</span><span class="ch hl">p</span><span class="ch hl">e</span><span class="ch hl">c</span><span class="ch hl">t</span></div>
      <div class="intro-welcome" id="introWelcome">欢迎进入 拓察 TopInspect</div>
      <div class="intro-divider" id="introDivider"></div>
      <button class="intro-enter" id="introEnter"><span class="pulse"></span>进入作战中心<span class="arr"></span></button>
    </div>
  </div>
</template>

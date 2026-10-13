<template>
  <div id="topo-area">
    <div id="topo-canvas-wrap">
      <svg id="topoSvg"></svg>
      <div id="topoEmpty">
        <div class="te-ring"><i class="fa-solid fa-diagram-project"></i></div>
        <div class="te-title">等待检测数据</div>
        <div class="te-sub">请上传 NetFlow CSV 文件<br>检测结果将在此实时构建威胁图谱</div>
        <button class="te-btn" onclick="navigateTo('upload')"><i class="fa-solid fa-cloud-arrow-up"></i> 上传数据并检测</button>
      </div>
      <div id="tooltip"></div>
      <div id="detailPanel">
        <button class="dp-close" onclick="closeDetail()"><i class="fa-solid fa-xmark"></i></button>
        <div id="detailContent"></div>
      </div>
      <canvas id="minimap" width="120" height="80"></canvas>
      <div class="zoom-ctrl">
        <button onclick="topoZoom(1.3)"><i class="fa-solid fa-plus"></i></button>
        <button onclick="topoZoom(0.7)"><i class="fa-solid fa-minus"></i></button>
        <button onclick="topoResetView()"><i class="fa-solid fa-arrows-to-circle"></i></button>
      </div>
      <div class="topo-toolbar">
        <input type="text" placeholder="搜索IP或节点..." id="topoSearch" onkeyup="topoSearchNode(this.value)">
        <select id="topoRiskFilter" onchange="topoFilter()">
          <option value="all">全部风险</option>
          <option value="critical">严重</option>
          <option value="warning">警告</option>
        </select>
        <button onclick="topoResetView()"><i class="fa-solid fa-rotate-right"></i> 重置</button>
        <button onclick="topoToggleClustering()">聚类: <span id="clusterLabel">开</span></button>
      </div>
      <div class="topo-legend">
        <span><span class="ld" style="background:#3b82f6;box-shadow:0 0 4px #3b82f6"></span> 正常</span>
        <span><span class="ld" style="background:#ff2d55;box-shadow:0 0 4px #ff2d55"></span> 攻击</span>
        <span><span class="ld" style="background:#ff9500;box-shadow:0 0 4px #ff9500"></span> 可疑</span>
      </div>
    </div>
    <!-- 检测进度 HUD（engine.js 的 showDetectHud/updateDetectHud 驱动）-->
    <div id="detectHud">
      <div class="dh-card">
        <div class="dh-scan"></div>
        <div class="dh-title"><i class="fa-solid fa-shield-halved"></i> 实时入侵检测引擎 · 推进中</div>
        <div class="dh-stages">
          <div class="dh-stage" data-st="解析数据流">解析数据流</div>
          <div class="dh-stage" data-st="神经网络推理">神经网络推理</div>
          <div class="dh-stage" data-st="构建威胁图谱">构建威胁图谱</div>
          <div class="dh-stage" data-st="done">完成</div>
        </div>
        <div class="dh-bar"><div class="dh-fill" id="dhFill"></div></div>
        <div class="dh-meta">
          <span id="dhStage">等待启动...</span>
          <span id="dhRows"></span>
        </div>
        <div style="text-align:center;margin-top:8px"><span class="dh-pct" id="dhPct">0%</span></div>
        <div class="dh-err" id="dhErr"></div>
      </div>
    </div>
  </div>
</template>

<script setup>
// 拓扑交互逻辑全部在 engine.js（D3 引擎），由 TopologyView 的生命周期挂载。
// 此处仅提供 DOM 骨架，onclick 处理器在运行时按 window 全局解析。
</script>

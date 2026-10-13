#!/usr/bin/env bash
# TopInspect 拓察 - 网络入侵检测系统 一键启动（Linux / macOS）
set -e
cd "$(dirname "$0")"

PY="python"
if [ -x ".venv/bin/python" ]; then
  PY=".venv/bin/python"
fi

if ! "$PY" -c "import fastapi, torch, torch_geometric" >/dev/null 2>&1; then
  echo "[提示] 依赖尚未安装，首次运行请先执行：uv sync"
  exit 1
fi

echo "================================================"
echo "  TopInspect 拓察 - 网络入侵检测系统"
echo "  前端已构建到 frontend/dist，由后端直接托管。"
echo "  打开浏览器访问 http://localhost:8000"
echo "================================================"

# 3 秒后打开浏览器（等待服务就绪）
( sleep 3; xdg-open http://localhost:8000 >/dev/null 2>&1 || open http://localhost:8000 >/dev/null 2>&1 ) &

exec "$PY" -m uvicorn server.api:app --host 127.0.0.1 --port 8000

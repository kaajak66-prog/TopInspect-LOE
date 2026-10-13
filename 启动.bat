@echo off
chcp 65001 >nul
title TopInspect 网络威胁感知系统
cd /d %~dp0
set "PY=python"
if exist .venv\Scripts\python.exe set "PY=.venv\Scripts\python.exe"

echo ================================================
echo   TopInspect 网络威胁感知系统
echo   正在启动后端服务，请稍候 ...
echo   前端已构建于 frontend\dist，由后端统一托管
echo   启动后自动打开 http://localhost:8000
echo ================================================

%PY% -c "import fastapi, torch, torch_geometric" >nul 2>&1
if errorlevel 1 goto need_deps

REM 若 8000 端口已被本项目的旧服务占用，先结束它，避免新进程静默绑定失败
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8000" ^| findstr "LISTENING"') do taskkill /f /pid %%p >nul 2>&1

start "" /b cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:8000"
%PY% -m uvicorn server.api:app --host 127.0.0.1 --port 8000
pause
exit /b 0

:need_deps
echo.
echo [提示] 依赖未安装，请先执行：
echo        uv sync
echo    或用 pip 安装：pip install -e .
echo.
pause
exit /b 1

@echo off
chcp 65001 >nul
REM ============================================
REM EasyVoice 一键部署（Windows）
REM 主服务 + OpenVoice 换声 + RVC 换声
REM 前提：已安装 Docker Desktop（并已启动）
REM ============================================
cd /d "%~dp0"

where docker >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 docker，请先安装并启动 Docker Desktop
  pause
  exit /b 1
)

if not exist .env (
  copy .env.example .env >nul
  echo [提示] 已从 .env.example 生成 .env，请编辑填写 OPENAI_API_KEY 等 AI 配置（也可部署后在页面「AI 模型配置」中填写）
)

echo 正在构建并启动服务（首次构建约需 10-20 分钟）...
docker compose --profile vc --profile rvc up -d --build
if errorlevel 1 (
  echo [错误] 部署失败，请检查上方错误信息
  pause
  exit /b 1
)

echo.
echo ============================================
echo  EasyVoice 已启动：http://localhost:3000
echo  - OpenVoice 换声: http://localhost:9090
echo  - RVC 换声:       http://localhost:9091
echo  需要 XTTS 声音克隆时额外执行:
echo    docker compose --profile clone up -d
echo  查看日志: docker compose logs -f easyvoice
echo ============================================
pause

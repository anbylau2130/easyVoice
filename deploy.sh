#!/usr/bin/env bash
# ============================================
# EasyVoice 一键部署（Linux / macOS）
# 主服务 + OpenVoice 换声 + RVC 换声
# 用法：bash deploy.sh
# ============================================
set -e
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "[错误] 未检测到 docker，请先安装 Docker Engine"
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "[提示] 已从 .env.example 生成 .env，请编辑填写 OPENAI_API_KEY 等 AI 配置（也可部署后在页面「AI 模型配置」中填写）"
fi

echo "正在构建并启动服务（首次构建约需 10-20 分钟）..."
docker compose --profile vc --profile rvc up -d --build

echo
echo "============================================"
echo " EasyVoice 已启动：http://localhost:3000"
echo " - OpenVoice 换声: http://localhost:9090"
echo " - RVC 换声:       http://localhost:9091"
echo " 需要 XTTS 声音克隆时额外执行: docker compose --profile clone up -d"
echo " 查看日志: docker compose logs -f easyvoice"
echo "============================================"

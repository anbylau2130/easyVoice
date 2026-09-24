#!/usr/bin/env bash
# 预下载 OmniVoice 构建所需模型到 models/hf/（一次即可，可断点续传）。
# 下载完成后执行 docker compose 构建将完全离线使用本地缓存，不再依赖 hf-mirror。
set -e
cd "$(dirname "$0")"

# Windows Git Bash 下禁用路径自动转换（否则容器内路径 /root/... 会被改写成 Windows 路径，
# 挂载错位导致模型写进容器临时层、退出即丢）；Linux/macOS 上该变量无副作用
export MSYS_NO_PATHCONV=1
# Git Bash 的 pwd 返回 /d/... 形式，docker -v 需要 Windows 形式（pwd -W）；Linux/macOS 回退普通 pwd
HOST_DIR=$(pwd -W 2>/dev/null || pwd)

docker run --rm \
  -v "$HOST_DIR/models/hf:/root/.cache/huggingface" \
  -e HF_ENDPOINT=https://hf-mirror.com \
  -e HF_HUB_DISABLE_XET=1 \
  python:3.10-slim sh -c "pip install -q huggingface_hub -i https://pypi.tuna.tsinghua.edu.cn/simple || pip install -q huggingface_hub; python -c \"from huggingface_hub import snapshot_download; snapshot_download('k2-fsa/OmniVoice'); snapshot_download('openai/whisper-small', allow_patterns=['*.json','*.txt','*.model','model.safetensors'])\""

# 落盘校验：防止挂载错位导致数据写进容器临时层
if [ -z "$(ls -A models/hf 2>/dev/null)" ]; then
  echo "[失败] models/hf 为空：挂载可能未生效（Windows 请在 Git Bash 中运行本脚本）" >&2
  exit 1
fi
echo
echo "[完成] 模型已就绪：models/hf/  现在可以直接 docker compose 构建。"

#!/bin/sh
# 容器启动入口：HF 缓存缺失时自动下载模型（走 HF_ENDPOINT 镜像，支持断点续传），
# 然后启动主服务。模型缓存建议通过 download-models 脚本预下载并挂载
# docker-data/omnivoice-models/hf:/root/.cache/huggingface，启动即秒级就绪。
set -e

if [ ! -e /root/.cache/huggingface/hub/models--k2-fsa--OmniVoice ]; then
  echo "[entrypoint] HF 缓存中未发现 OmniVoice 模型，开始下载（约 3GB，支持断点续传）..."
  python -c "from huggingface_hub import snapshot_download; \
    snapshot_download('k2-fsa/OmniVoice'); \
    snapshot_download('openai/whisper-small', allow_patterns=['*.json', '*.txt', '*.model', 'model.safetensors'])"
  echo "[entrypoint] 模型下载完成"
fi

exec "$@"

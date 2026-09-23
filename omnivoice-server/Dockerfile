# OmniVoice 零样本声音克隆服务：文本 + 参考音频一步合成（新一代 TTS，Apache-2.0）
# 与 vc-server（OpenVoice 换声）/ rvc-server（RVC 换声）相互独立、互不影响。
# 主模型与 ASR 模型在构建期从 hf-mirror 预置进镜像，运行期零下载；
# CPU 可跑但较慢（约 0.8B 扩散模型），推荐 GPU 机器启用。
FROM python:3.10-slim

# torch 构建变体：cpu（默认）/ cu126 / cu128。
# GPU 加速：构建时 --build-arg TORCH_BUILD=cu126（compose 部署则在 .env 设 TORCH_BUILD=cu126），
# 并配合 docker-compose.gpu.yml 声明 GPU；需 NVIDIA 显卡与就绪的驱动（详见 README）
ARG TORCH_BUILD=cpu

# apt 源：清华镜像优先（国内网络直连 Debian 官方源常超时），失败自动回退官方源
RUN { sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g; s|security.debian.org|mirrors.tuna.tsinghua.edu.cn|g'       /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null; apt-get update; }  && apt-get install -y --no-install-recommends ffmpeg libsndfile1 libgomp1 curl ca-certificates  && rm -rf /var/lib/apt/lists/*  || { sed -i 's|mirrors.tuna.tsinghua.edu.cn|deb.debian.org|g'       /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null;       apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 libgomp1 curl ca-certificates && rm -rf /var/lib/apt/lists/*; }


WORKDIR /app

# torch 轮子：cpu 体积小（约 200MB）；cu126/cu128 含 CUDA 运行库（数 GB，GPU 推理必需）。
# 清华源仅作为 extra-index 提供构建依赖，并兜底回落完整版 torch
RUN pip install --no-cache-dir --retries 10 --timeout 60 \
      torch==2.8.0+${TORCH_BUILD} torchaudio==2.8.0 \
      --index-url https://download.pytorch.org/whl/${TORCH_BUILD} \
      --extra-index-url https://pypi.tuna.tsinghua.edu.cn/simple \
 || pip install --no-cache-dir --retries 10 --timeout 60 \
      torch==2.8.0 torchaudio==2.8.0 -i https://pypi.tuna.tsinghua.edu.cn/simple

COPY requirements.txt .
# 依赖安装：清华源优先（国内网络），失败回落官方 PyPI
RUN (pip install --no-cache-dir -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple \
 || pip install --no-cache-dir -r requirements.txt)

# 模型预置（本层在 COPY app.py 之前，改动 app.py 不触发模型重下）：
# 主模型 k2-fsa/OmniVoice + 参考音频自动转写用的 whisper-small（只取推理必需文件）。
# HF_HUB_DISABLE_XET：新版 huggingface_hub 默认走 Xet 协议，其 CAS 端点直连官方且
# 需要鉴权（hf-mirror 不代理），401 失败；禁用后回退普通 HTTP 下载，hf-mirror 可完整加速
ENV HF_ENDPOINT=https://hf-mirror.com \
    HF_HUB_DISABLE_XET=1
RUN python -c "from huggingface_hub import snapshot_download; \
    snapshot_download('k2-fsa/OmniVoice'); \
    snapshot_download('openai/whisper-small', allow_patterns=['*.json', '*.txt', '*.model', 'model.safetensors'])" \
 && du -sh /root/.cache/huggingface

COPY app.py .

ENV OMNIVOICE_MODEL_ID=k2-fsa/OmniVoice \
    OMNIVOICE_DEVICE=auto \
    OMNIVOICE_NUM_STEP=16 \
    OMNIVOICE_ASR_MODEL=openai/whisper-small \
    OMNI_REFS_DIR=/app/references \
    OMNI_PROMPTS_DIR=/app/prompts
RUN mkdir -p /app/references /app/prompts

# 注意：不要挂载 /root/.cache/huggingface —— 空目录会遮蔽镜像内预置的模型
EXPOSE 9092
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9092"]

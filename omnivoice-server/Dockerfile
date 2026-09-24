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

# torch 轮子：优先使用仓库内置的 CPU 轮子分片（wheels/，离线可用、不受网络波动影响；
# 分片拼接后与官方轮子逐字节一致）。TORCH_BUILD 非 cpu（GPU 构建）或本地轮子缺失/安装
# 失败时，走网络三级回退：pytorch 官方源 → 阿里云镜像 → 清华完整版
COPY wheels/ ./wheels/
RUN { [ "$TORCH_BUILD" = "cpu" ] \
      && cat wheels/torch-cpu.whl.part-* > wheels/torch-2.8.0+cpu-cp310-cp310-manylinux_2_28_x86_64.whl \
      && pip install --no-cache-dir --retries 10 --timeout 60 \
           "wheels/torch-2.8.0+cpu-cp310-cp310-manylinux_2_28_x86_64.whl" \
           "wheels/torchaudio-2.8.0+cpu-cp310-cp310-manylinux_2_28_x86_64.whl"; } \
 || pip install --no-cache-dir --retries 10 --timeout 60 \
      torch==2.8.0+${TORCH_BUILD} torchaudio==2.8.0 \
      --index-url https://download.pytorch.org/whl/${TORCH_BUILD} \
      --extra-index-url https://pypi.tuna.tsinghua.edu.cn/simple \
 || pip install --no-cache-dir --retries 10 --timeout 60 \
      torch==2.8.0+${TORCH_BUILD} torchaudio==2.8.0 \
      -f https://mirrors.aliyun.com/pytorch-wheels/${TORCH_BUILD}/ \
      --index-url https://mirrors.aliyun.com/pypi/simple/ \
 || pip install --no-cache-dir --retries 10 --timeout 60 \
      torch==2.8.0 torchaudio==2.8.0 -i https://pypi.tuna.tsinghua.edu.cn/simple
RUN rm -rf wheels

COPY requirements.txt .
# 依赖安装：清华源优先（国内网络），失败回落官方 PyPI
RUN (pip install --no-cache-dir -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple \
 || pip install --no-cache-dir -r requirements.txt)

# 模型不进镜像（约 3GB）：构建期零模型下载、构建上下文轻量稳定。
# 运行期从挂载的 HF 缓存读取（推荐先运行 download-models 脚本预下载到
# docker-data/omnivoice-models/hf）；缓存为空时入口脚本自动从 hf-mirror 下载。
# HF_HUB_DISABLE_XET：新版 huggingface_hub 默认走 Xet 协议，其 CAS 端点直连官方且
# 需要鉴权（hf-mirror 不代理），401 失败；禁用后回退普通 HTTP 下载，hf-mirror 可完整加速
ENV HF_ENDPOINT=https://hf-mirror.com \
    HF_HUB_DISABLE_XET=1

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

COPY app.py .

ENV OMNIVOICE_MODEL_ID=k2-fsa/OmniVoice \
    OMNIVOICE_DEVICE=auto \
    OMNIVOICE_NUM_STEP=16 \
    OMNIVOICE_ASR_MODEL=openai/whisper-small \
    OMNI_REFS_DIR=/app/references \
    OMNI_PROMPTS_DIR=/app/prompts \
    # 限制 glibc 内存池数量：torch 多线程会开出大量 arena，RSS 只涨不降
    MALLOC_ARENA_MAX=2
RUN mkdir -p /app/references /app/prompts

# 注意：模型缓存在运行期挂载，不要再挂载/覆盖 /root/.cache/huggingface 以外的东西
EXPOSE 9092
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9092"]

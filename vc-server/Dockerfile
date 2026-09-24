# OpenVoice 音色转换服务：Edge-TTS 合成后的可选后处理（频谱重建换音色）
# 依赖：python3.10 + CPU torch + OpenVoice（仅 ToneColorConverter，裁剪掉 MeloTTS/whisper 重依赖）
# 构建上下文为仓库根目录（compose 已配置）：优先使用 build-deps/ 本地预下载文件
# （运行仓库根目录的 download-build-deps 脚本生成），缺失时回退在线下载。
FROM python:3.10-slim

# apt 源：清华镜像优先（国内网络直连 Debian 官方源常超时），失败自动回退官方源
RUN { sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g; s|security.debian.org|mirrors.tuna.tsinghua.edu.cn|g'       /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null; apt-get update; }  && apt-get install -y --no-install-recommends git ffmpeg libsndfile1 libgomp1 unzip curl ca-certificates  && rm -rf /var/lib/apt/lists/*  || { sed -i 's|mirrors.tuna.tsinghua.edu.cn|deb.debian.org|g'       /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null;       apt-get update && apt-get install -y --no-install-recommends git ffmpeg libsndfile1 libgomp1 unzip curl ca-certificates && rm -rf /var/lib/apt/lists/*; }


WORKDIR /app

# torch 2.2.2 CPU：优先使用 build-deps/torch/rvc-cpu/ 本地轮子（与 rvc-server 共用同一份，
# download-build-deps 脚本预下载）；缺失时在线回退：pytorch CPU 源 → 清华完整版
COPY build-deps/ ./build-deps/
RUN { ls build-deps/torch/rvc-cpu/*.whl >/dev/null 2>&1 \
      && echo "[build] torch: using pre-downloaded local wheels" \
      && pip install --no-cache-dir --retries 10 --timeout 60 build-deps/torch/rvc-cpu/*.whl; } \
 || pip install --no-cache-dir --retries 10 --timeout 60 torch==2.2.2 --index-url https://download.pytorch.org/whl/cpu \
 || pip install --no-cache-dir --retries 10 --timeout 60 torch==2.2.2 -i https://pypi.tuna.tsinghua.edu.cn/simple

COPY vc-server/requirements.txt .
# 依赖安装：清华源优先（国内网络），失败回落官方 PyPI
RUN (pip install --no-cache-dir -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple \
 || pip install --no-cache-dir -r requirements.txt)

# OpenVoice 包已 vendor 进镜像（源：github.com/myshell-ai/OpenVoice，MIT 协议）。
# __init__.py 置空避免拉起 MeloTTS/se_extractor 等重依赖——换声只需 ToneColorConverter
COPY vc-server/openvoice/ ./openvoice/
RUN echo "" > ./openvoice/__init__.py

# 转换器权重（converter/config.json + checkpoint.pth，约 110MB）：
# 优先使用 build-deps/vc-ckpt/ 本地文件；缺失时从 hf-mirror 单文件下载（免代理）。
# 注意：本层在 COPY app.py 之前，改动 app.py 不触发权重重下
RUN mkdir -p /app/checkpoints_v2/converter \
 && { [ -s build-deps/vc-ckpt/converter/checkpoint.pth ] \
      && echo "[build] openvoice checkpoints: using pre-downloaded local files" \
      && cp build-deps/vc-ckpt/converter/config.json build-deps/vc-ckpt/converter/checkpoint.pth \
        /app/checkpoints_v2/converter/; } \
 || { curl -f -L --retry 5 --retry-all-errors --retry-delay 10 --connect-timeout 20 \
        "https://hf-mirror.com/myshell-ai/OpenVoiceV2/resolve/main/converter/config.json" \
        -o /app/checkpoints_v2/converter/config.json \
      && curl -f -L --retry 5 --retry-all-errors --retry-delay 10 --connect-timeout 20 \
        "https://hf-mirror.com/myshell-ai/OpenVoiceV2/resolve/main/converter/checkpoint.pth" \
        -o /app/checkpoints_v2/converter/checkpoint.pth; } \
 && test -s /app/checkpoints_v2/converter/checkpoint.pth \
 && rm -rf build-deps

COPY vc-server/app.py ./app.py

# 转换器权重：运行期挂载 /app/checkpoints_v2 持久化，重建容器不再下载
ENV HF_ENDPOINT=https://hf-mirror.com
ENV CKPT_DIR=/app/checkpoints_v2/converter
ENV REFS_DIR=/app/references
VOLUME ["/app/checkpoints_v2"]

EXPOSE 9090
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9090"]

# RVC v2 音色转换服务：Edge-TTS 合成后的可选后处理（用已训练模型换音色）
# 独立于 vc-server（OpenVoice）：RVC 依赖链（fairseq 0.12.2 等）较老，
# 隔离部署避免影响稳定的 OpenVoice 服务。
# 模型放置：宿主机 rvc-models/<模型名>/xx.pth（+ 可选 xx.index），社区模型或自训均可
# 构建上下文为仓库根目录（compose 已配置）：优先使用 build-deps/ 本地预下载文件
# （运行仓库根目录的 download-build-deps 脚本生成），缺失时回退在线下载。
FROM python:3.10-slim

# apt 源：清华镜像优先（国内网络直连 Debian 官方源常超时），失败自动回退官方源
RUN { sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g; s|security.debian.org|mirrors.tuna.tsinghua.edu.cn|g'       /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null; apt-get update; }  && apt-get install -y --no-install-recommends ffmpeg libsndfile1 libgomp1 curl ca-certificates g++ make  && rm -rf /var/lib/apt/lists/*  || { sed -i 's|mirrors.tuna.tsinghua.edu.cn|deb.debian.org|g'       /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list 2>/dev/null;       apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 libgomp1 curl ca-certificates g++ make && rm -rf /var/lib/apt/lists/*; }


WORKDIR /app

# torch 2.2.2 CPU：优先使用 build-deps/torch/rvc-cpu/ 本地轮子（download-build-deps 脚本
# 预下载，离线可用）；缺失时在线回退：pytorch CPU 源 → 清华完整版
COPY build-deps/ ./build-deps/
RUN { ls build-deps/torch/rvc-cpu/*.whl >/dev/null 2>&1 \
      && echo "[build] torch: using pre-downloaded local wheels" \
      && pip install --no-cache-dir --retries 10 --timeout 60 build-deps/torch/rvc-cpu/*.whl; } \
 || pip install --no-cache-dir --retries 10 --timeout 60 torch==2.2.2 --index-url https://download.pytorch.org/whl/cpu \
 || pip install --no-cache-dir --retries 10 --timeout 60 torch==2.2.2 -i https://pypi.tuna.tsinghua.edu.cn/simple

COPY rvc-server/requirements.txt .
# fairseq==0.12.2 的依赖 omegaconf==2.0.6 元数据含老式 '>=5.1.*' 说明符，pip>=24.1 拒装，先降级；
# 依赖安装清华源优先（国内网络），失败回落官方 PyPI
RUN (pip install --no-cache-dir "pip<24.1" -i https://pypi.tuna.tsinghua.edu.cn/simple \
 || pip install --no-cache-dir "pip<24.1") \
 && (pip install --no-cache-dir -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple \
 || pip install --no-cache-dir -r requirements.txt)

# RVC 基础模型：rvc-python 初始化时从硬编码的 huggingface.co 下载（内网不可达且不认 HF_ENDPOINT）。
# 构建期预置到其期望位置 site-packages/rvc_python/base_model/，运行时自动跳过下载。
# 优先使用 build-deps/rvc-base/ 本地文件；缺失时从 hf-mirror 下载。
# 注意：本层在 COPY app.py 之前，改动 app.py 不触发模型重下
RUN mkdir -p /usr/local/lib/python3.10/site-packages/rvc_python/base_model \
 && { ls build-deps/rvc-base/*.pt >/dev/null 2>&1 \
      && echo "[build] rvc base models: using pre-downloaded local files" \
      && cp build-deps/rvc-base/hubert_base.pt build-deps/rvc-base/rmvpe.pt build-deps/rvc-base/rmvpe.onnx \
        /usr/local/lib/python3.10/site-packages/rvc_python/base_model/; } \
 || for f in hubert_base.pt rmvpe.pt; do \
      curl -f -L --retry 5 --retry-all-errors --retry-delay 10 --connect-timeout 20 \
        "https://hf-mirror.com/Daswer123/RVC_Base/resolve/main/$f" \
        -o "/usr/local/lib/python3.10/site-packages/rvc_python/base_model/$f" || exit 1; \
    done \
 && curl -f -L --retry 5 --retry-all-errors --retry-delay 10 --connect-timeout 20 \
      "https://hf-mirror.com/Daswer123/RVC_Base/resolve/main/rmvpe.onnx" \
      -o /usr/local/lib/python3.10/site-packages/rvc_python/base_model/rmvpe.onnx \
 && du -sh /usr/local/lib/python3.10/site-packages/rvc_python/base_model \
 && rm -rf build-deps

COPY rvc-server/app.py .

# RVC 首次推理会从 HF 拉取 hubert/rmvpe 基础模型，走 hf-mirror 并持久化缓存
ENV HF_ENDPOINT=https://hf-mirror.com
ENV RVC_MODELS_DIR=/app/models
RUN mkdir -p /app/models
VOLUME ["/app/models", "/root/.cache/huggingface"]

EXPOSE 9091
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9091"]

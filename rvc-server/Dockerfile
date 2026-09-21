# RVC v2 音色转换服务：Edge-TTS 合成后的可选后处理（用已训练模型换音色）
# 独立于 vc-server（OpenVoice）：RVC 依赖链（fairseq 0.12.2 等）较老，
# 隔离部署避免影响稳定的 OpenVoice 服务。
# 模型放置：宿主机 rvc-models/<模型名>/xx.pth（+ 可选 xx.index），社区模型或自训均可
FROM python:3.10-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg libsndfile1 libgomp1 curl ca-certificates g++ make \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU 优先：先尝试 CPU 轮子，失败回落 PyPI 清华镜像（与 vc-server 保持一致）
RUN pip install --no-cache-dir torch==2.2.2 --index-url https://download.pytorch.org/whl/cpu \
 || pip install --no-cache-dir torch==2.2.2 -i https://pypi.tuna.tsinghua.edu.cn/simple

COPY requirements.txt .
# fairseq==0.12.2 的依赖 omegaconf==2.0.6 元数据含老式 '>=5.1.*' 说明符，pip>=24.1 拒装，先降级
RUN pip install --no-cache-dir "pip<24.1" \
 && pip install --no-cache-dir -r requirements.txt

# RVC 基础模型：rvc-python 初始化时从硬编码的 huggingface.co 下载（内网不可达且不认 HF_ENDPOINT）。
# 构建期从 hf-mirror 预置到其期望位置 site-packages/rvc_python/base_model/，运行时自动跳过下载。
# 注意：本层在 COPY app.py 之前，改动 app.py 不触发模型重下
RUN mkdir -p /usr/local/lib/python3.10/site-packages/rvc_python/base_model \
 && for f in hubert_base.pt rmvpe.pt rmvpe.onnx; do \
      curl -f -L --retry 5 --retry-all-errors --retry-delay 10 --connect-timeout 20 \
        "https://hf-mirror.com/Daswer123/RVC_Base/resolve/main/$f" \
        -o "/usr/local/lib/python3.10/site-packages/rvc_python/base_model/$f" || exit 1; \
    done \
 && du -sh /usr/local/lib/python3.10/site-packages/rvc_python/base_model

COPY app.py .

# RVC 首次推理会从 HF 拉取 hubert/rmvpe 基础模型，走 hf-mirror 并持久化缓存
ENV HF_ENDPOINT=https://hf-mirror.com
ENV RVC_MODELS_DIR=/app/models
RUN mkdir -p /app/models
VOLUME ["/app/models", "/root/.cache/huggingface"]

EXPOSE 9091
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9091"]

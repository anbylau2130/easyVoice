#!/usr/bin/env bash
# ============================================================
#  构建依赖预下载脚本（可选但强烈推荐）
#  把 Docker 构建期需要的大文件提前下载到 build-deps/（断点续传），
#  之后构建镜像优先使用本地文件，网络只做兜底，大幅降低构建失败率。
#
#  下载内容：
#    build-deps/torch/rvc-cpu/    RVC/VC 用的 torch 2.2.2 CPU 轮子（约 190MB）
#    build-deps/rvc-base/         RVC 基础模型 hubert/rmvpe（约 520MB）
#    build-deps/vc-ckpt/          OpenVoice 转换器权重（约 110MB）
#    build-deps/torch/omni-cu126/ OmniVoice GPU 版 torch（仅 TORCH_BUILD=cu126 时，约 2GB+）
#
#  已存在的文件自动跳过；下载中断重新运行即可断点续传。
# ============================================================
set -e
cd "$(dirname "$0")"
mkdir -p build-deps

export MSYS_NO_PATHCONV=1

MIRROR_HF=https://hf-mirror.com
MIRROR_ALIYUN_WHEELS=https://mirrors.aliyun.com/pytorch-wheels/cpu

download() {
  local url="$1" out="$2"
  if [ -s "$out" ]; then
    echo "[跳过] $out 已存在"
    return 0
  fi
  mkdir -p "$(dirname "$out")"
  echo "[下载] $out"
  curl -f -L -C - --retry 10 --retry-all-errors --retry-delay 5 --connect-timeout 20 -o "$out" "$url"
}

download "$MIRROR_ALIYUN_WHEELS/torch-2.2.2%2Bcpu-cp310-cp310-linux_x86_64.whl" \
  "build-deps/torch/rvc-cpu/torch-2.2.2+cpu-cp310-cp310-linux_x86_64.whl"
download "$MIRROR_ALIYUN_WHEELS/torchaudio-2.2.2%2Bcpu-cp310-cp310-linux_x86_64.whl" \
  "build-deps/torch/rvc-cpu/torchaudio-2.2.2+cpu-cp310-cp310-linux_x86_64.whl"

download "$MIRROR_HF/Daswer123/RVC_Base/resolve/main/hubert_base.pt" "build-deps/rvc-base/hubert_base.pt"
download "$MIRROR_HF/Daswer123/RVC_Base/resolve/main/rmvpe.pt" "build-deps/rvc-base/rmvpe.pt"
download "$MIRROR_HF/Daswer123/RVC_Base/resolve/main/rmvpe.onnx" "build-deps/rvc-base/rmvpe.onnx"

download "$MIRROR_HF/myshell-ai/OpenVoiceV2/resolve/main/converter/config.json" "build-deps/vc-ckpt/converter/config.json"
download "$MIRROR_HF/myshell-ai/OpenVoiceV2/resolve/main/converter/checkpoint.pth" "build-deps/vc-ckpt/converter/checkpoint.pth"

# OmniVoice GPU 变体（仅在设置 TORCH_BUILD=cu126/cu128 时下载）
if [ -n "$TORCH_BUILD" ] && [ "$TORCH_BUILD" != "cpu" ]; then
  download "https://download.pytorch.org/whl/$TORCH_BUILD/torch-2.8.0%2B$TORCH_BUILD-cp310-cp310-manylinux_2_28_x86_64.whl" \
    "build-deps/torch/omni-$TORCH_BUILD/torch-2.8.0+$TORCH_BUILD-cp310-cp310-manylinux_2_28_x86_64.whl"
  download "https://download.pytorch.org/whl/$TORCH_BUILD/torchaudio-2.8.0%2B$TORCH_BUILD-cp310-cp310-manylinux_2_28_x86_64.whl" \
    "build-deps/torch/omni-$TORCH_BUILD/torchaudio-2.8.0+$TORCH_BUILD-cp310-cp310-manylinux_2_28_x86_64.whl"
fi

echo
echo "[完成] 构建依赖已就绪（build-deps/）。直接 docker compose 构建即可，构建优先使用本地文件。"

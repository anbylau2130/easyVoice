@echo off
rem ============================================================
rem  构建依赖预下载脚本（可选但强烈推荐）
rem  把 Docker 构建期需要的大文件提前下载到 build-deps/（断点续传），
rem  之后构建镜像优先使用本地文件，网络只做兜底，大幅降低构建失败率。
rem
rem  下载内容：
rem    build-deps\torch\rvc-cpu\    RVC/VC 用的 torch 2.2.2 CPU 轮子（约 190MB）
rem    build-deps\rvc-base\         RVC 基础模型 hubert/rmvpe（约 520MB）
rem    build-deps\vc-ckpt\          OpenVoice 转换器权重（约 110MB）
rem    build-deps\torch\omni-cu126\ OmniVoice GPU 版 torch（仅设置 TORCH_BUILD=cu126 时，约 2GB+）
rem
rem  已存在的文件自动跳过；下载中断重新运行即可断点续传。
rem ============================================================
setlocal enabledelayedexpansion
cd /d %~dp0
if not exist build-deps mkdir build-deps

set MIRROR_HF=https://hf-mirror.com
set MIRROR_PYTORCH=https://download.pytorch.org/whl/cpu
set MIRROR_ALIYUN_WHEELS=https://mirrors.aliyun.com/pytorch-wheels/cpu

rem ---------- 工具函数（下载：已存在跳过，支持续传） ----------
call :download "%MIRROR_ALIYUN_WHEELS%/torch-2.2.2%%2Bcpu-cp310-cp310-linux_x86_64.whl" "build-deps\torch\rvc-cpu\torch-2.2.2+cpu-cp310-cp310-linux_x86_64.whl"
call :download "%MIRROR_ALIYUN_WHEELS%/torchaudio-2.2.2%%2Bcpu-cp310-cp310-linux_x86_64.whl" "build-deps\torch\rvc-cpu\torchaudio-2.2.2+cpu-cp310-cp310-linux_x86_64.whl"

call :download "%MIRROR_HF%/Daswer123/RVC_Base/resolve/main/hubert_base.pt" "build-deps\rvc-base\hubert_base.pt"
call :download "%MIRROR_HF%/Daswer123/RVC_Base/resolve/main/rmvpe.pt" "build-deps\rvc-base\rmvpe.pt"
call :download "%MIRROR_HF%/Daswer123/RVC_Base/resolve/main/rmvpe.onnx" "build-deps\rvc-base\rmvpe.onnx"

call :download "%MIRROR_HF%/myshell-ai/OpenVoiceV2/resolve/main/converter/config.json" "build-deps\vc-ckpt\converter\config.json"
call :download "%MIRROR_HF%/myshell-ai/OpenVoiceV2/resolve/main/converter/checkpoint.pth" "build-deps\vc-ckpt\converter\checkpoint.pth"

rem ---------- OmniVoice GPU 变体（仅在设置 TORCH_BUILD=cu126/cu128 时下载） ----------
if not "%TORCH_BUILD%"=="" if not "%TORCH_BUILD%"=="cpu" (
  call :download "https://download.pytorch.org/whl/%TORCH_BUILD%/torch-2.8.0%%2B%TORCH_BUILD%-cp310-cp310-manylinux_2_28_x86_64.whl" "build-deps\torch\omni-%TORCH_BUILD%\torch-2.8.0+%TORCH_BUILD%-cp310-cp310-manylinux_2_28_x86_64.whl"
  call :download "https://download.pytorch.org/whl/%TORCH_BUILD%/torchaudio-2.8.0%%2B%TORCH_BUILD%-cp310-cp310-manylinux_2_28_x86_64.whl" "build-deps\torch\omni-%TORCH_BUILD%\torchaudio-2.8.0+%TORCH_BUILD%-cp310-cp310-manylinux_2_28_x86_64.whl"
)

echo.
echo [完成] 构建依赖已就绪（build-deps/）。直接 docker compose 构建即可，构建优先使用本地文件。
pause
exit /b 0

:download
rem %1=URL %2=本地路径
if exist "%~2" (
  echo [跳过] %~2 已存在
  exit /b 0
)
if not exist "%~dp2" mkdir "%~dp2"
echo [下载] %~2
curl -f -L -C - --retry 10 --retry-all-errors --retry-delay 5 --connect-timeout 20 -o "%~2" "%~1"
if %ERRORLEVEL% NEQ 0 (
  echo [失败] %~2 下载失败，重新运行本脚本可断点续传
  exit /b 1
)
exit /b 0

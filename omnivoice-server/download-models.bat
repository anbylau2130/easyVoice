@echo off
rem 预下载 OmniVoice 模型到 docker-data\omnivoice-models\hf（一次即可，可断点续传）。
rem 下载完成后重启 omnivoice-server 容器即生效，无需重新构建镜像。
rem 用法：双击运行，或在仓库 omnivoice-server 目录执行 download-models.bat

cd /d %~dp0
rem 模型缓存统一放在 docker-data/omnivoice-models/hf（运行期挂载进容器）
if not exist "..\docker-data\omnivoice-models" mkdir "..\docker-data\omnivoice-models"

docker run --rm ^
  -v "%cd%\..\docker-data\omnivoice-models\hf:/root/.cache/huggingface" ^
  -e HF_ENDPOINT=https://hf-mirror.com ^
  -e HF_HUB_DISABLE_XET=1 ^
  python:3.10-slim sh -c "pip install -q huggingface_hub -i https://pypi.tuna.tsinghua.edu.cn/simple || pip install -q huggingface_hub; python -c \"from huggingface_hub import snapshot_download; snapshot_download('k2-fsa/OmniVoice'); snapshot_download('openai/whisper-small', allow_patterns=['*.json','*.txt','*.model','model.safetensors'])\""

if %ERRORLEVEL% NEQ 0 (
  echo.
  echo [失败] 模型下载出错，可重新运行本脚本断点续传。
  pause
  exit /b 1
)
echo.
echo [完成] 模型已就绪：docker-data\omnivoice-models\hf  重启容器即生效。
pause

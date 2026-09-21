"""RVC v2 音色转换服务：Edge-TTS 合成后的可选后处理（用已训练模型换音色）。

独立于 vc-server（OpenVoice）运行，避免 RVC 的老依赖链（fairseq 等）影响 OpenVoice 服务。

用法：
  POST /convert  (multipart)
      audio=待转换音频(mp3/wav)
      ref=模型名（rvc-models/ 中的已训练模型）
      pitch=变调半音数（可选，跨性别换声建议 ±12）
  GET  /models    列出可用模型
  GET  /health    健康检查

模型来自 MODELS_DIR（挂载宿主机 rvc-models/ 目录），布局：
  rvc-models/<模型名>/<模型名>.pth（+ 可选同名 .index，检索特征）
或扁平布局 rvc-models/<模型名>.pth。
社区模型可从 HuggingFace 搜索 "rvc" 下载；自训模型推荐 Ov2Super 底模。
"""

import os
import subprocess
import tempfile
import threading
from pathlib import Path

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse, Response

MODELS_DIR = Path(os.environ.get('RVC_MODELS_DIR', '/app/models'))
DEVICE = 'cpu'
F0_METHOD = os.environ.get('RVC_F0METHOD', 'rmvpe')

app = FastAPI(title='EasyVoice RVC Server', description='RVC v2 tone-color conversion')
# 模型懒加载缓存 + 推理互斥（CPU 推理非线程安全）
inference_cache: dict[str, object] = {}
infer_lock = threading.Lock()


def scan_model_names() -> list[str]:
    """扫描全部模型名（嵌套目录用目录名，扁平文件用文件名）"""
    names = set()
    for pth in MODELS_DIR.rglob('*.pth'):
        names.add(pth.parent.name if pth.parent != MODELS_DIR else pth.stem)
    return sorted(names)


def find_model(name: str) -> tuple[Path, Path | None] | None:
    """按名查找模型，返回 (pth, index)。名字不得含路径分隔符（防目录穿越）"""
    if not name or '/' in name or '\\' in name or '..' in name:
        return None
    for pth in sorted(MODELS_DIR.rglob('*.pth')):
        candidate = pth.parent.name if pth.parent != MODELS_DIR else pth.stem
        if candidate == name:
            index = next(iter(sorted(pth.parent.glob('*.index'))), None)
            return pth, index
    return None


def get_inference(name: str):
    """懒加载并缓存指定模型的推理器（首次调用会拉取 hubert/rmvpe 基础模型）"""
    found = find_model(name)
    if not found:
        return None
    pth, index = found
    if name in inference_cache:
        return inference_cache[name]
    from rvc_python.infer import RVCInference

    inference = RVCInference(device=DEVICE)
    if index is not None:
        inference.load_model(str(pth), index_path=str(index))
    else:
        inference.load_model(str(pth))
    inference_cache[name] = inference
    return inference


def decode_to_wav(data: bytes, out_wav: Path) -> None:
    """任意输入格式 → 24kHz 单声道 wav"""
    src = out_wav.with_suffix('.src')
    src.write_bytes(data)
    subprocess.run(
        ['ffmpeg', '-y', '-i', str(src), '-ar', '24000', '-ac', '1', str(out_wav)],
        check=True,
        capture_output=True,
    )
    src.unlink(missing_ok=True)


@app.on_event('startup')
def startup() -> None:
    MODELS_DIR.mkdir(parents=True, exist_ok=True)


@app.get('/health')
def health() -> dict:
    return {'status': 'ok', 'device': DEVICE, 'models': scan_model_names()}


@app.get('/models')
def models() -> dict:
    items = []
    for name in scan_model_names():
        found = find_model(name)
        index = found[1] if found else None
        items.append({'name': name, 'hasIndex': index is not None})
    return {'models': items}


@app.post('/convert')
async def convert(
    audio: UploadFile = File(...),
    ref: str = Form(''),
    pitch: int = Form(0),
) -> Response:
    model_name = ref.strip()
    if not model_name:
        return JSONResponse(status_code=400, content={'message': '缺少模型名 ref'})
    data = await audio.read()
    if not data:
        return JSONResponse(status_code=400, content={'message': '音频内容为空'})

    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        wav_in = td_path / 'in.wav'
        decode_to_wav(data, wav_in)
        with infer_lock:
            try:
                inference = get_inference(model_name)
            except Exception as exc:
                return JSONResponse(
                    status_code=500,
                    content={'message': f'RVC 模型加载失败（{model_name}）：{exc}'},
                )
            if inference is None:
                return JSONResponse(
                    status_code=404,
                    content={'message': f'RVC 模型不存在：{model_name}（挂载到 rvc-models/ 目录）'},
                )
            out_wav = td_path / 'out.wav'
            try:
                inference.infer_file(
                    str(wav_in),
                    str(out_wav),
                    f0up_key=pitch,
                    f0method=F0_METHOD,
                    index_rate=0.75,
                    protect=0.33,
                )
            except TypeError:
                # rvc-python 版本间参数名有差异时的保守回退
                inference.infer_file(str(wav_in), str(out_wav))
        return Response(content=out_wav.read_bytes(), media_type='audio/wav')

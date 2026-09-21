"""OpenVoice 音色转换服务：Edge-TTS 合成后的可选后处理（频谱重建换音色）。

用法：
  POST /convert  (multipart)  audio=待转换音频(mp3/wav), ref=参考音色名(不含扩展名)
  GET  /references             列出可用的参考音色
  GET  /health                 健康检查（含权重加载状态）

参考音色来自 REFS_DIR 目录（挂载宿主机 voices/ 目录）中的 wav 文件。
RVC 引擎在独立的 rvc-server 容器中提供，本服务只做 OpenVoice。
"""

import os
import subprocess
import tempfile
from pathlib import Path

import torch
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse, Response

from openvoice.api import ToneColorConverter

CKPT_DIR = os.environ.get('CKPT_DIR', '/app/checkpoints_v2/converter')
REFS_DIR = Path(os.environ.get('REFS_DIR', '/app/references'))
DEVICE = 'cpu'

app = FastAPI(title='EasyVoice VC Server', description='OpenVoice tone-color conversion')
converter: ToneColorConverter | None = None
# 参考音色的 speaker embedding 缓存（提取一次，重复转换复用）
se_cache: dict[str, torch.Tensor] = {}


def load_converter() -> None:
    global converter
    converter = ToneColorConverter(f'{CKPT_DIR}/config.json', device=DEVICE)
    converter.load_ckpt(f'{CKPT_DIR}/checkpoint.pth')
    # 参考音色 speaker embedding 预提取（启动时一次，换声时复用）
    REFS_DIR.mkdir(parents=True, exist_ok=True)
    for wav in sorted(REFS_DIR.glob('*.wav')):
        try:
            se_cache[wav.stem] = converter.extract_se(str(wav))
        except Exception as exc:  # 单个参考损坏不阻塞服务
            print(f'[vc-server] 提取参考音色失败 {wav.name}: {exc}')


@app.on_event('startup')
def startup() -> None:
    load_converter()


def decode_to_wav(data: bytes, out_wav: Path) -> None:
    """任意输入格式 → 24kHz 单声道 wav（OpenVoice 推理输入要求）"""
    src = out_wav.with_suffix('.src')
    src.write_bytes(data)
    subprocess.run(
        ['ffmpeg', '-y', '-i', str(src), '-ar', '24000', '-ac', '1', str(out_wav)],
        check=True,
        capture_output=True,
    )
    src.unlink(missing_ok=True)


@app.get('/health')
def health() -> dict:
    return {
        'status': 'ok',
        'converter_loaded': converter is not None,
        'references': sorted(se_cache.keys()),
    }


@app.get('/references')
def references() -> dict:
    return {'references': sorted(wav.stem for wav in REFS_DIR.glob('*.wav'))}


@app.post('/convert')
async def convert(
    audio: UploadFile = File(...),
    ref: str = Form(''),
    reference: str = Form(''),
) -> Response:
    # ref 为标准字段名；reference 兼容旧客户端
    target = (ref or reference).strip()
    if not target:
        return JSONResponse(status_code=400, content={'message': '缺少参考音色名 ref'})
    if converter is None:
        return JSONResponse(status_code=503, content={'message': '转换器尚未加载完成'})
    ref_path = REFS_DIR / f'{target}.wav'
    tgt_se = se_cache.get(target)
    if not ref_path.exists() or tgt_se is None:
        return JSONResponse(
            status_code=404,
            content={'message': f'参考音色不存在：{target}'},
        )
    data = await audio.read()
    if not data:
        return JSONResponse(status_code=400, content={'message': '音频内容为空'})

    with tempfile.TemporaryDirectory() as td:
        td_path = Path(td)
        wav_in = td_path / 'in.wav'
        decode_to_wav(data, wav_in)
        # 源音色 embedding：从输入音频实时提取（Edge 各基础声线各不相同）
        src_se = converter.extract_se(str(wav_in))
        out_wav = td_path / 'out.wav'
        converter.convert(
            audio_src_path=str(wav_in),
            src_se=src_se,
            tgt_se=tgt_se,
            output_path=str(out_wav),
        )
        wav_bytes = out_wav.read_bytes()

    return Response(content=wav_bytes, media_type='audio/wav')

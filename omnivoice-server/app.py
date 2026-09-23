"""OmniVoice 零样本声音克隆合成服务：文本 + 参考音频 → 目标音色语音（一步合成）。

与 vc-server（OpenVoice）/ rvc-server（RVC）的「转换」路线不同：
OmniVoice 是 TTS（不能对已有音频换声），因此有换声源的角色在生成管线中
跳过 Edge 合成、直接调用本服务；无换声源的角色（如旁白）仍走 Edge 预设音色。

用法：
  POST /generate  (multipart)
      text=待合成文本
      ref=参考音色名（voices/ 中 wav 文件名，不含扩展名，与 vc-server 同一命名）
      speed=语速倍率（可选，默认 1.0，范围 0.5~3）
  GET  /references   列出可用的参考音色（与 vc-server 共用 voices/ 目录）
  GET  /health       健康检查

参考音频的编码结果（VoiceClonePrompt，含 Whisper 自动转写）按参考名缓存为
PROMPTS_DIR/<ref>.pt：每个参考只需跑一次 ASR，之后的合成直接复用。
"""

import io
import os
import threading
from pathlib import Path

from fastapi import FastAPI, Form
from fastapi.responses import JSONResponse, Response

MODEL_ID = os.environ.get('OMNIVOICE_MODEL_ID', 'k2-fsa/OmniVoice')
# auto = CUDA 优先、无 GPU 回落 CPU（本机无独显时即 CPU，速度较慢）
DEVICE = os.environ.get('OMNIVOICE_DEVICE', 'auto')
# 扩散解码步数：官方默认 32 质量最优；CPU 部署用 16（约快一倍，质量损失很小）
NUM_STEP = int(os.environ.get('OMNIVOICE_NUM_STEP', '16'))
# 参考音频自动转写模型（每个参考仅首次编码时运行一次）：
# 默认 CPU 友好的 whisper-small；追求更高质量可换 openai/whisper-large-v3-turbo
ASR_MODEL = os.environ.get('OMNIVOICE_ASR_MODEL', 'openai/whisper-small')
REFS_DIR = Path(os.environ.get('OMNI_REFS_DIR', '/app/references'))
PROMPTS_DIR = Path(os.environ.get('OMNI_PROMPTS_DIR', '/app/prompts'))

app = FastAPI(title='EasyVoice OmniVoice Server', description='OmniVoice zero-shot voice cloning TTS')

_model = None
_prompt_cache: dict[str, object] = {}
_model_lock = threading.Lock()
_infer_lock = threading.Lock()  # 推理互斥（模型非线程安全，CPU 串行合成）


def find_reference(name: str) -> Path | None:
    """按名查找参考音频。名字不得含路径分隔符（防目录穿越）"""
    if not name or '/' in name or '\\' in name or '..' in name:
        return None
    path = REFS_DIR / f'{name}.wav'
    return path if path.is_file() else None


def scan_reference_names() -> list[str]:
    REFS_DIR.mkdir(parents=True, exist_ok=True)
    return sorted(wav.stem for wav in REFS_DIR.glob('*.wav'))


def get_model():
    """懒加载主模型（首个合成请求时才占内存），加载后常驻"""
    global _model
    with _model_lock:
        if _model is None:
            import torch
            from omnivoice import OmniVoice

            device = DEVICE
            if device == 'auto':
                device = 'cuda' if torch.cuda.is_available() else 'cpu'
            dtype = torch.float16 if device.startswith('cuda') else torch.float32
            print(f'[omnivoice-server] loading {MODEL_ID} on {device} ({dtype}), asr={ASR_MODEL} ...', flush=True)
            _model = OmniVoice.from_pretrained(
                MODEL_ID,
                device_map=device,
                dtype=dtype,
                asr_model_name=ASR_MODEL,
            )
            print('[omnivoice-server] model loaded', flush=True)
    return _model


def get_prompt(model, name: str):
    """取参考音频的克隆提示：优先读 PROMPTS_DIR 缓存，缺失时现场编码一次"""
    if name in _prompt_cache:
        return _prompt_cache[name]
    prompt_path = PROMPTS_DIR / f'{name}.pt'
    if prompt_path.is_file():
        from omnivoice import VoiceClonePrompt

        prompt = VoiceClonePrompt.load(str(prompt_path))
        print(f'[omnivoice-server] prompt loaded from cache: {prompt_path.name}', flush=True)
    else:
        ref_path = find_reference(name)
        if ref_path is None:
            return None
        PROMPTS_DIR.mkdir(parents=True, exist_ok=True)
        # ref_text 缺省 → Whisper 自动转写参考音频（仅首次，结果随 .pt 持久化）
        with _infer_lock:
            prompt = model.create_voice_clone_prompt(ref_audio=str(ref_path))
        prompt.save(str(prompt_path))
        print(f'[omnivoice-server] prompt encoded & cached: {prompt_path.name}', flush=True)
    _prompt_cache[name] = prompt
    return prompt


def clamp_speed(value: float) -> float:
    try:
        value = float(value)
    except (TypeError, ValueError):
        return 1.0
    if value <= 0:
        return 1.0
    return min(3.0, max(0.5, value))


@app.get('/health')
def health() -> dict:
    return {
        'status': 'ok',
        'device': DEVICE,
        'model_loaded': _model is not None,
        'num_step': NUM_STEP,
        'asr_model': ASR_MODEL,
        'references': scan_reference_names(),
    }


@app.get('/references')
def references() -> dict:
    return {'references': scan_reference_names()}


@app.post('/generate')
def generate(
    text: str = Form(''),
    ref: str = Form(''),
    speed: float = Form(1.0),
) -> Response:
    """同步端点：FastAPI 自动放入线程池执行，推理期间事件循环不被阻塞，
    /health、/references 仍可正常响应"""
    if not text.strip():
        return JSONResponse(status_code=400, content={'message': '缺少合成文本 text'})
    name = ref.strip()
    if find_reference(name) is None:
        return JSONResponse(
            status_code=404,
            content={'message': f'参考音色不存在：{name}（放到 voices/ 目录，wav 格式）'},
        )
    model = get_model()
    prompt = get_prompt(model, name)
    if prompt is None:
        return JSONResponse(status_code=404, content={'message': f'参考音色编码失败：{name}'})
    with _infer_lock:
        audio = model.generate(
            text=text,
            voice_clone_prompt=prompt,
            speed=clamp_speed(speed),
            num_step=NUM_STEP,
        )
    # 返回 list[np.ndarray]（24kHz）：拼接为一条 16bit PCM wav
    import numpy as np
    import soundfile as sf

    chunks = [np.asarray(chunk, dtype='float32') for chunk in audio if len(chunk)]
    if not chunks:
        return JSONResponse(status_code=500, content={'message': '合成结果为空'})
    buf = io.BytesIO()
    sf.write(buf, np.concatenate(chunks), 24000, format='WAV', subtype='PCM_16')
    return Response(content=buf.getvalue(), media_type='audio/wav')

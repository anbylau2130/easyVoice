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

声音设计（Voice Design）：用文字描述（instruct）造声音，无需参考音频。
注意：同一 instruct 每次生成的是"符合描述的不同人声"，直接用于有声书会导致
角色声音漂移；因此设计结果以"声纹样本"固化——保存设计时用 instruct 生成一段
固定试音文本，存为 voices/omni-<名字>.wav 参考音频，之后与普通参考音色一样走
克隆合成，保证全书同一角色声音一致。
  POST /design-preview    (json: instruct, text?)        按描述生成试听（不保存）
  GET  /designs           列出已保存的设计
  POST /designs           (json: name, instruct, gender)  按 instruct 现场生成声纹并保存
                                                          （同名=重摇；AI 生成模式亦走此接口）
  POST /designs/upload    (multipart: name, instruct, gender, wav) 保存外部音频为声纹：
                          试听满意的声音纹理，或用户上传的参考音频（规一化为 24kHz
                          单声道并裁到 10 秒）
  POST /designs/sample    (json: name)                    取已保存的声纹样本（不推理）
  POST /designs/delete    (json: name)                    删除设计（声纹+缓存+登记）
（name 走 body 而非路径参数：服务端 URL 保持固定路径，动态参数集中校验）
"""

import io
import json
import os
import re
import subprocess
import tempfile
import threading
import time
from pathlib import Path

from fastapi import Body, FastAPI, File, Form, UploadFile
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
DESIGNS_PATH = PROMPTS_DIR / 'designs.json'

# 声纹样本固定试音文本：约 30 字 ≈ 8~10 秒（官方建议参考音频 3~10 秒）
VOICE_PRINT_TEXT = '大家好，这是一段声音样本。山不在高，有仙则名；水不在深，有龙则灵。'
# 设计名：中文/字母/数字/短横线/下划线，长度 1~40
DESIGN_NAME_RE = re.compile(r'^[\w\u4e00-\u9fff-]{1,40}$')

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
        # 编码完成即卸载 Whisper（下次编码新参考时自动重载），常态内存显著降低
        release_memory(unload_asr=True)
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


def release_memory(unload_asr: bool = False) -> None:
    """推理后尽量归还内存：
    - unload_asr=True 时卸载 Whisper 管线（约 1GB）。ASR 只在参考音频编码时需要，
      缺失时 create_voice_clone_prompt 会自动重载（loading on-the-fly），卸载是安全的；
    - gc + malloc_trim 归还 glibc 空闲页（torch 大量临时张量释放后 RSS 常驻不降）"""
    import gc

    if unload_asr and _model is not None:
        try:
            if getattr(_model, '_asr_pipe', None) is not None:
                _model._asr_pipe = None
                print('[omnivoice-server] idle ASR pipeline unloaded to free memory', flush=True)
        except Exception as exc:
            print(f'[omnivoice-server] ASR unload failed: {exc}', flush=True)
    gc.collect()
    try:
        import ctypes

        ctypes.CDLL('libc.so.6').malloc_trim(0)
    except Exception:
        pass


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
    release_memory()
    # 返回 list[np.ndarray]（24kHz）：拼接为一条 16bit PCM wav
    import numpy as np
    import soundfile as sf

    chunks = [np.asarray(chunk, dtype='float32') for chunk in audio if len(chunk)]
    if not chunks:
        return JSONResponse(status_code=500, content={'message': '合成结果为空'})
    buf = io.BytesIO()
    sf.write(buf, np.concatenate(chunks), 24000, format='WAV', subtype='PCM_16')
    return Response(content=buf.getvalue(), media_type='audio/wav')


# ===== 声音设计（Voice Design）=====

_designs_lock = threading.Lock()


def load_designs() -> dict:
    try:
        return json.loads(DESIGNS_PATH.read_text(encoding='utf-8'))
    except Exception:
        return {}


def save_designs(designs: dict) -> None:
    PROMPTS_DIR.mkdir(parents=True, exist_ok=True)
    DESIGNS_PATH.write_text(json.dumps(designs, ensure_ascii=False, indent=2), encoding='utf-8')


def generate_by_instruct(instruct: str, text: str) -> bytes:
    """按描述生成音频（wav bytes）。同一描述每次生成的是不同人声，仅用于试听/固化声纹"""
    import numpy as np
    import soundfile as sf

    model = get_model()
    with _infer_lock:
        audio = model.generate(text=text, instruct=instruct, num_step=NUM_STEP)
    release_memory()
    chunks = [np.asarray(chunk, dtype='float32') for chunk in audio if len(chunk)]
    if not chunks:
        raise RuntimeError('合成结果为空')
    buf = io.BytesIO()
    sf.write(buf, np.concatenate(chunks), 24000, format='WAV', subtype='PCM_16')
    return buf.getvalue()


def design_ref(name: str) -> str:
    """设计名 → 参考音色名（voices/ 中 wav 文件名，不含扩展名）"""
    return f'omni-{name}'


@app.post('/design-preview')
def design_preview(body: dict = Body(...)) -> Response:
    instruct = str(body.get('instruct') or '').strip()
    if not instruct:
        return JSONResponse(status_code=400, content={'message': '缺少声音描述 instruct'})
    text = str(body.get('text') or '').strip() or VOICE_PRINT_TEXT
    if len(text) > 300:
        text = text[:300]
    try:
        return Response(content=generate_by_instruct(instruct, text), media_type='audio/wav')
    except Exception as exc:
        return JSONResponse(status_code=500, content={'message': f'声音设计合成失败：{exc}'})


@app.get('/designs')
def list_designs() -> dict:
    with _designs_lock:
        designs = load_designs()
    items = [dict(d, name=name) for name, d in designs.items()]
    items.sort(key=lambda d: d.get('createdAt') or 0, reverse=True)
    return {'designs': items}


@app.post('/designs')
def create_design(body: dict = Body(...)) -> dict:
    """按 instruct 现场生成新声纹并保存（同名=重摇；供「重摇」按钮与 AI 生成模式调用）"""
    name = str(body.get('name') or '').strip()
    instruct = str(body.get('instruct') or '').strip()
    gender = str(body.get('gender') or '').strip().lower()
    if not DESIGN_NAME_RE.match(name):
        return JSONResponse(
            status_code=400,
            content={'message': '音色名称仅支持中文/字母/数字/短横线/下划线，长度 1~40'},
        )
    if not instruct:
        return JSONResponse(status_code=400, content={'message': '缺少声音描述 instruct'})
    try:
        wav_bytes = generate_by_instruct(instruct, VOICE_PRINT_TEXT)
    except Exception as exc:
        return JSONResponse(status_code=500, content={'message': f'声纹生成失败：{exc}'})
    ref = design_ref(name)
    REFS_DIR.mkdir(parents=True, exist_ok=True)
    (REFS_DIR / f'{ref}.wav').write_bytes(wav_bytes)
    with _designs_lock:
        designs = load_designs()
        designs[name] = {
            'ref': ref,
            'instruct': instruct,
            'gender': gender if gender in ('female', 'male') else '',
            'createdAt': int(time.time()),
        }
        save_designs(designs)
    print(f'[omnivoice-server] design saved (instruct, {len(wav_bytes)}B): {ref} ({instruct})', flush=True)
    return {'design': dict(designs[name], name=name)}


@app.post('/designs/upload')
async def upload_design(
    name: str = Form(''),
    instruct: str = Form(''),
    gender: str = Form(''),
    wav: UploadFile = File(...),
) -> dict:
    """保存外部音频为设计声纹（试听满意的声音纹理，或用户上传的参考音频）。
    音频统一规一化为 24kHz 单声道 wav 并裁到 10 秒内（官方建议参考音频 3~10 秒）"""
    name = name.strip()
    instruct = instruct.strip()
    gender = gender.strip().lower()
    if not DESIGN_NAME_RE.match(name):
        return JSONResponse(
            status_code=400,
            content={'message': '音色名称仅支持中文/字母/数字/短横线/下划线，长度 1~40'},
        )
    data = await wav.read()
    if not data:
        return JSONResponse(status_code=400, content={'message': '音频内容为空'})
    ref = design_ref(name)
    ref_path = REFS_DIR / f'{ref}.wav'
    REFS_DIR.mkdir(parents=True, exist_ok=True)
    try:
        normalize_to_wav(data, ref_path)
    except Exception as exc:
        return JSONResponse(status_code=500, content={'message': f'声纹音频规一化失败：{exc}'})
    with _designs_lock:
        designs = load_designs()
        designs[name] = {
            'ref': ref,
            'instruct': instruct,
            'gender': gender if gender in ('female', 'male') else '',
            'createdAt': int(time.time()),
        }
        save_designs(designs)
    print(f'[omnivoice-server] design saved (uploaded, {ref_path.stat().st_size}B): {ref} ({instruct})', flush=True)
    return {'design': dict(designs[name], name=name)}


def normalize_to_wav(data: bytes, out_path: Path) -> None:
    """任意音频输入 → 24kHz 单声道 16bit wav，裁到 10 秒内（克隆参考的推荐上限）"""
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / 'src.audio'
        src.write_bytes(data)
        subprocess.run(
            ['ffmpeg', '-y', '-i', str(src), '-t', '10', '-ar', '24000', '-ac', '1',
             '-c:a', 'pcm_s16le', str(out_path)],
            check=True,
            capture_output=True,
        )
        if not out_path.is_file() or out_path.stat().st_size < 1000:
            raise RuntimeError('音频解码结果为空或过短')


@app.post('/designs/sample')
def design_sample(body: dict = Body(...)) -> Response:
    name = str(body.get('name') or '').strip()
    if not DESIGN_NAME_RE.match(name):
        return JSONResponse(status_code=400, content={'message': '音色名称无效'})
    path = REFS_DIR / f'{design_ref(name)}.wav'
    if not path.is_file():
        return JSONResponse(status_code=404, content={'message': f'设计音色不存在：{name}'})
    return Response(content=path.read_bytes(), media_type='audio/wav')


@app.post('/designs/delete')
def delete_design(body: dict = Body(...)) -> dict:
    name = str(body.get('name') or '').strip()
    if not DESIGN_NAME_RE.match(name):
        return JSONResponse(status_code=400, content={'message': '音色名称无效'})
    ref = design_ref(name)
    removed = False
    with _designs_lock:
        designs = load_designs()
        if name in designs:
            designs.pop(name)
            save_designs(designs)
            removed = True
    (REFS_DIR / f'{ref}.wav').unlink(missing_ok=True)
    (PROMPTS_DIR / f'{ref}.pt').unlink(missing_ok=True)
    _prompt_cache.pop(ref, None)
    if not removed:
        return JSONResponse(status_code=404, content={'message': f'设计音色不存在：{name}'})
    return {'ok': True}

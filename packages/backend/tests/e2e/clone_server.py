# tests/e2e/clone_server.py
# 声音克隆合成服务：跑在 ebook2audiobook 容器内，直接用 Xtts 类做本地推理。
# 接口：POST /clone_speech {text, speaker(容器内参考wav路径), language} -> wav 音频
import io
import os

os.environ.setdefault("COQUI_TOS_AGREED", "1")
os.environ.setdefault("HF_HUB_OFFLINE", "1")  # 模型已本地化，禁止联网

import threading

import numpy as np
import scipy.io.wavfile as wavfile
from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

app = FastAPI(title="EasyVoice Clone TTS")
_model = None
_lock = threading.Lock()

SAMPLE_RATE = 24000


def load_model():
    from TTS.tts.configs.xtts_config import XttsConfig
    from TTS.tts.models.xtts import Xtts

    config = XttsConfig()
    config.load_json("/models/config.json")
    model = Xtts.init_from_config(config)
    model.load_checkpoint(config, checkpoint_dir="/models", eval=True)
    return model


def get_model():
    global _model
    with _lock:
        if _model is None:
            _model = load_model()
    return _model


class CloneRequest(BaseModel):
    text: str
    speaker: str  # 容器内参考 wav 路径（挂载的 /ref-voices/xxx.wav）
    language: str = "zh-cn"
    temperature: float = 0.7
    speed: float = 1.0


@app.get("/health")
def health():
    return {"ok": True, "loaded": _model is not None}


@app.post("/clone_speech")
def clone_speech(req: CloneRequest):
    try:
        model = get_model()
        gpt_cond_latent, speaker_embedding = model.get_conditioning_latents(
            audio_path=[req.speaker]
        )
        out = model.inference(
            req.text,
            req.language,
            gpt_cond_latent,
            speaker_embedding,
            temperature=req.temperature,
            speed=req.speed,
            enable_text_splitting=True,
        )
        audio = np.clip(np.asarray(out["wav"]), -1, 1)
        int16 = (audio * 32767).astype(np.int16)
        buf = io.BytesIO()
        wavfile.write(buf, SAMPLE_RATE, int16)
        return Response(content=buf.getvalue(), media_type="audio/wav")
    except Exception as err:  # noqa: BLE001
        import traceback

        return JSONResponse(
            status_code=500,
            content={"success": False, "message": str(err), "trace": traceback.format_exc()[-800:]},
        )

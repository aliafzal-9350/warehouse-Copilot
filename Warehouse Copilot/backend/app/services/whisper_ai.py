import os
import tempfile
from faster_whisper import WhisperModel

MODEL_NAME = os.getenv("WHISPER_MODEL", "tiny")

# Faster CPU config
_model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")

def transcribe_audio_bytes(audio_bytes: bytes) -> str:
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
            tmp.write(audio_bytes)
            temp_path = tmp.name

        segments, _ = _model.transcribe(
            temp_path,
            language="en",
            task="transcribe",
            vad_filter=True
        )

        text = " ".join(seg.text.strip() for seg in segments).strip()
        return text
    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                pass
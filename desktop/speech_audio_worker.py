"""Speech & Audio synthesis worker for AutoTask AI.
Generates spoken PCM WAV audio files from target text using Windows SAPI
(System.Speech.Synthesis.SpeechSynthesizer) with a deterministic pure-Python
syllable-modulated PCM WAV fallback so speaking/recording tasks work even in
headless or sandbox environments without audio hardware.
"""
from __future__ import annotations

import json
import math
import os
import re
import struct
import subprocess
import sys
import tempfile
import uuid
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / 'artifacts' / 'audio'
BLOCKED_SEGMENTS = {'.private', '.ssh', '.git'}


def validate_output_wav_path(raw: str | None) -> Path:
    if not raw or not str(raw).strip():
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        return (OUT_DIR / f'speech_{uuid.uuid4().hex[:8]}.wav').resolve()
    s = str(raw).strip()
    if re.match(r'^[a-zA-Z]+://', s):
        raise ValueError('URL paths are not allowed')
    p = Path(s).expanduser().resolve()
    if any(part.lower() in BLOCKED_SEGMENTS for part in p.parts):
        raise ValueError('Sensitive path segment is not permitted')
    if p.suffix.lower() != '.wav':
        p = p.with_suffix('.wav')
    if p.exists() and p.is_symlink():
        raise ValueError('Refusing symlink output path')
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def try_windows_sapi_wav(text: str, out_path: Path, rate: int = 0) -> bool:
    """Attempts to synthesize natural spoken WAV via Windows .NET System.Speech."""
    if os.name != 'nt':
        return False
    clean_text = re.sub(r'\s+', ' ', (text or '').strip())[:1000]
    if not clean_text:
        return False
    # Pass text and output path via environment variables to avoid shell/PS quoting hazards
    ps_script = (
        "Add-Type -AssemblyName System.Speech; "
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
        "try { "
        "$s.Rate = [int]$env:AT_TTS_RATE; "
        "$s.SetOutputToWaveFile($env:AT_TTS_OUT); "
        "$s.Speak($env:AT_TTS_TEXT); "
        "} finally { $s.Dispose() }"
    )
    env = os.environ.copy()
    env['AT_TTS_TEXT'] = clean_text
    env['AT_TTS_OUT'] = str(out_path)
    env['AT_TTS_RATE'] = str(max(-5, min(5, int(rate))))
    try:
        proc = subprocess.run(
            ['powershell', '-NoProfile', '-NonInteractive', '-Command', ps_script],
            env=env,
            capture_output=True,
            text=True,
            timeout=6,
        )
        return proc.returncode == 0 and out_path.exists() and out_path.stat().st_size > 1024
    except Exception:
        return False


def synthesize_python_syllable_wav(text: str, out_path: Path, sample_rate: int = 16000) -> float:
    """Deterministic pure-Python PCM WAV generator with speech-like formant & syllable envelopes."""
    words = [w for w in re.split(r'\s+', (text or 'Hello world').strip()) if w]
    if not words:
        words = ['Hello']

    # Build syllable timeline: ~0.26s active phonation per word + 0.08s micro-pause, clamped 1.2s..8.0s
    word_dur = 0.28
    pause_dur = 0.07
    total_dur = max(1.2, min(8.0, len(words) * (word_dur + pause_dur)))
    n_frames = int(total_dur * sample_rate)

    samples = bytearray(n_frames * 2)
    step = word_dur + pause_dur

    for i in range(n_frames):
        t = i / sample_rate
        word_idx = min(len(words) - 1, int(t / step))
        local_t = t - word_idx * step
        word_seed = sum(ord(ch) for ch in words[word_idx])

        if local_t > word_dur or t > len(words) * step:
            val = 0
        else:
            # Smooth raised-cosine syllable envelope
            env = math.sin(math.pi * (local_t / word_dur)) ** 1.4
            f0 = 135.0 + (word_seed % 45) + 12.0 * math.sin(2.0 * math.pi * 2.5 * local_t)
            f1 = 420.0 + (word_seed % 260)
            f2 = 1350.0 + (word_seed % 500)
            sig = (
                0.50 * math.sin(2.0 * math.pi * f0 * t)
                + 0.30 * math.sin(2.0 * math.pi * (f0 * 2.0) * t)
                + 0.14 * math.sin(2.0 * math.pi * f1 * t)
                + 0.06 * math.sin(2.0 * math.pi * f2 * t)
            )
            val = int(max(-32000, min(32000, 14000.0 * env * sig)))

        struct.pack_into('<h', samples, i * 2, val)

    with wave.open(str(out_path), 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(bytes(samples))

    return round(n_frames / sample_rate, 3)


def wav_duration_seconds(wav_path: Path) -> float:
    with wave.open(str(wav_path), 'rb') as wf:
        frames = wf.getnframes()
        rate = wf.getframerate() or 16000
        return round(frames / rate, 3)


def main() -> int:
    try:
        if len(sys.argv) >= 3 and sys.argv[1] == '--input':
            raw = Path(sys.argv[2]).read_text(encoding='utf-8')
        elif len(sys.argv) >= 2 and sys.argv[1] in ('-h', '--help'):
            print(json.dumps({'ok': True, 'usage': 'echo JSON | python speech_audio_worker.py'}))
            return 0
        else:
            raw = sys.stdin.read()

        payload = json.loads(raw or '{}')
        action = str(payload.get('action') or 'synthesize_speech')
        if action != 'synthesize_speech':
            raise ValueError(f'Unsupported action: {action}')

        text = str(payload.get('text') or 'Could you repeat that, please?').strip()
        out_path = validate_output_wav_path(payload.get('outputPath'))
        rate = int(payload.get('rate') or 0)
        prefer_fast = bool(payload.get('preferFastWave'))

        engine = 'python-wave'
        if not prefer_fast and try_windows_sapi_wav(text, out_path, rate=rate):
            engine = 'sapi'
            duration = wav_duration_seconds(out_path)
        else:
            duration = synthesize_python_syllable_wav(text, out_path)

        size_bytes = out_path.stat().st_size
        print(json.dumps({
            'ok': True,
            'outputPath': str(out_path),
            'durationSeconds': duration,
            'sizeBytes': size_bytes,
            'engine': engine,
        }))
        return 0
    except Exception as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

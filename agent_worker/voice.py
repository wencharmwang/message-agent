"""语音消息：SILK 解码 + 本地转文字。

微信语音在库里是 **SILK v3** 编码的音频（`media_0.db` 的 `VoiceInfo.voice_data`），
没有文字。要读懂它必须自己转，这里做两段：

1. **SILK → WAV**：用一个 **75 KB 的预编译解码器**（`silk-decoder-x64.exe`，随包走，
   零安装、不联网）。它输出裸 PCM（24kHz 单声道 16bit），这里补上 WAV 头。
2. **WAV → 文字**：调用本机的 faster-whisper（**用户自己决定装不装**，
   模型 ~470MB，不进安装包）。

为什么要拆成两段、还要用户自己装第二段：

* 第一段只有 75 KB，随包分发没有负担，装上就能用；
* 第二段是几百 MB 的模型 + CTranslate2，硬塞进包会让所有人都为"可能不用"的功能买单；
* 聊天语音属于敏感内容，**是否送去识别应该是用户自己的决定**（设置里的开关）。
"""

from __future__ import annotations

import io
import json
import os
import struct
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

#: 解码器随包分发的相对位置（安装后在 <InstallDir>\components\silk\ 下）
DECODER_NAME = 'silk-decoder-x64.exe'
#: 解码器固定输出 24kHz 单声道 16bit
SAMPLE_RATE = 24000
#: 转文字的模型。**必须从 small 起步**：base 会直接输出繁体（实测过），中文用户看到会以为坏了。
DEFAULT_MODEL = 'small'
#: 强迫简体输出。不给这句，模型经常吐繁体（实测对比过）。
ZH_PROMPT = '以下是普通话的句子，请用简体中文。'
#: 太短的语音（<0.3 秒）通常是误触，不值得花时间转
MIN_SECONDS = 0.3


class VoiceError(RuntimeError):
    pass


def decoder_path(app_root: str | Path) -> Path | None:
    """找到随包的解码器。开发时在 packaging/components/silk 下，安装后在 components/silk 下。"""
    root = Path(app_root)
    for candidate in (root / 'components' / 'silk' / DECODER_NAME,
                      root.parent / 'packaging' / 'components' / 'silk' / DECODER_NAME,
                      root / 'packaging' / 'components' / 'silk' / DECODER_NAME):
        if candidate.exists():
            return candidate
    return None


def silk_to_wav(blob: bytes, out_path: str | Path, app_root: str | Path, timeout: int = 30) -> Path:
    """SILK 字节流 -> WAV 文件。失败抛 VoiceError（调用方据此退回到"读不到内容"的说明）。"""
    exe = decoder_path(app_root)
    if exe is None:
        raise VoiceError('找不到语音解码组件')
    if not blob or not blob.startswith(b'\x02#!SILK_V3'):
        # 不是 SILK_V3 流（老版本微信可能是 AMR/其他），交给调用方按"读不到"处理
        raise VoiceError('这段语音不是 SILK 格式')

    work = Path(tempfile.mkdtemp(prefix='ma-voice-'))
    silk = work / 'in.silk'
    pcm = work / 'out.pcm'
    try:
        silk.write_bytes(blob)
        result = subprocess.run([str(exe), str(silk), str(pcm)],
                                capture_output=True, timeout=timeout,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode != 0 or not pcm.exists():
            raise VoiceError('语音解码没有成功')
        raw = pcm.read_bytes()
        if len(raw) < SAMPLE_RATE * 2 * MIN_SECONDS:
            raise VoiceError('这段语音太短了')
        target = Path(out_path)
        with wave.open(str(target), 'wb') as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(SAMPLE_RATE)
            handle.writeframes(raw)
        return target
    finally:
        for item in (silk, pcm):
            try:
                item.unlink()
            except OSError:
                pass
        try:
            work.rmdir()
        except OSError:
            pass


def wav_seconds(path: str | Path) -> float:
    with wave.open(str(path), 'rb') as handle:
        return handle.getnframes() / float(handle.getframerate() or SAMPLE_RATE)


def transcribe(wav_path: str | Path, python_exe: str, model: str = DEFAULT_MODEL,
               lib_dir: str | Path | None = None, timeout: int = 120) -> str:
    """用本机装好的 faster-whisper 转文字。

    走子进程调用那个 venv 的解释器：Whisper 依赖 CTranslate2，装不进主程序自带的
    Python（3.13 embeddable 没有 pip、也不想污染），所以它独立成 <data>/voice/venv。
    """
    script = (
        'import sys\n'
        'from faster_whisper import WhisperModel\n'
        'model = WhisperModel(sys.argv[2], device="cpu", compute_type="int8")\n'
        'segments, _ = model.transcribe(sys.argv[1], language="zh", beam_size=5,\n'
        f'                              initial_prompt={ZH_PROMPT!r})\n'
        'print("".join(segment.text for segment in segments).strip())\n'
    )
    env = dict(os.environ)
    if lib_dir:
        # 依赖装在独立目录里（自带 Python 是 embeddable 版，没有 site-packages），
        # 靠 PYTHONPATH 让它能被 import。
        env['PYTHONPATH'] = str(lib_dir) + os.pathsep + env.get('PYTHONPATH', '')
    result = subprocess.run([python_exe, '-c', script, str(wav_path), model],
                            capture_output=True, timeout=timeout, text=True,
                            encoding='utf-8', errors='replace', env=env,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode != 0:
        raise VoiceError((result.stderr or '语音识别没有成功').strip().splitlines()[-1][:200])
    return (result.stdout or '').strip()


def voice_python(data_dir: str | Path) -> Path | None:
    """用户自己装的那套识别环境（没装返回 None）。返回 (解释器, 依赖目录或 None)。

    两种布局都支持：
      * `<data>/voice/venv/...`  —— 开发机上用真 Python 建的 venv（我实测走的就是这条）
      * `<data>/voice/lib` + 自带 Python —— install-voice.ps1 在用户机器上的布局
        （自带的是 embeddable 版，没有 venv/site-packages，所以依赖单独装、用 PYTHONPATH 挂上）
    """
    root = Path(data_dir) / 'voice'
    for name in ('Scripts/python.exe', 'bin/python'):
        candidate = root / 'venv' / name
        if candidate.exists():
            return candidate, None
    bundled = Path(sys.executable)
    if (root / 'lib').exists() and bundled.exists():
        return bundled, root / 'lib'
    return None


def available(data_dir: str | Path, app_root: str | Path) -> dict:
    """给界面/设置用的状态：解码器在不在、识别装没装。"""
    return {
        'decoder': decoder_path(app_root) is not None,
        'transcriber': voice_python(data_dir) is not None,
        'lib': str(Path(data_dir) / 'voice' / 'lib'),
        'model': DEFAULT_MODEL,
    }


# --------------------------------------------------------------------------
# 用户偏好：要不要把语音转成文字
#
# 存在数据目录下的一个 JSON 里（和数据库同处），因为**两个进程都要读**：
# Worker 要在事件进来时决定转不转，Host 要把它显示给用户。写在谁的内存里都不合适。
# --------------------------------------------------------------------------
PREF_FILE = 'voice.json'


def pref_path(data_dir: str | Path) -> Path:
    return Path(data_dir) / PREF_FILE


def load_prefs(data_dir: str | Path) -> dict:
    """读用户偏好。默认关闭 —— 聊天语音要不要送去识别，得用户自己点开。"""
    try:
        raw = json.loads(io.open(pref_path(data_dir), encoding='utf-8-sig').read())
    except (OSError, ValueError):
        raw = {}
    return {
        'enabled': raw.get('enabled') is True,
        'model': raw.get('model') if isinstance(raw.get('model'), str) else DEFAULT_MODEL,
    }


def save_prefs(data_dir: str | Path, patch: dict) -> dict:
    current = load_prefs(data_dir)
    if 'enabled' in patch:
        current['enabled'] = patch['enabled'] is True
    if isinstance(patch.get('model'), str) and patch['model'].strip():
        current['model'] = patch['model'].strip()
    target = pref_path(data_dir)
    target.parent.mkdir(parents=True, exist_ok=True)
    with io.open(target, 'w', encoding='utf-8') as handle:
        handle.write(json.dumps(current, ensure_ascii=False, indent=2))
    return current

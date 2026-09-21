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
import threading
import time
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
    # **必须**让子进程用 UTF-8 输出：Windows 下管道默认是 GBK(cp936)，
    # 而我们按 utf-8 读 —— 不设这个，转出来的中文直接是乱码。
    # （同一个坑在 watcher_source.py 里踩过一次，注释还在那儿。）
    env['PYTHONUTF8'] = '1'
    env['PYTHONIOENCODING'] = 'utf-8'
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


def cached_transcript(data_dir: str | Path, key: str, producer) -> str:
    """带缓存的转写。

    为什么必须有缓存：转一条要 1~2 秒（CPU），而**每次读消息列表都可能碰上同一条语音**
    （首页、整理、会话详情各读一遍），不缓存会把界面拖垮、也白烧 CPU。
    键用 local_id（微信的本地消息号，全局单调），所以同一条语音只会转一次。
    """
    cache = Path(data_dir) / 'voice' / 'cache'
    target = cache / (str(key) + '.txt')
    try:
        if target.exists():
            return io.open(target, encoding='utf-8').read().strip()
    except OSError:
        pass
    try:
        text = (producer() or '').strip()
    except Exception:
        return ''
    if text:
        try:
            cache.mkdir(parents=True, exist_ok=True)
            with io.open(target, 'w', encoding='utf-8') as handle:
                handle.write(text)
        except OSError:
            pass
    return text


# --------------------------------------------------------------------------
# 常驻识别服务：模型只加载一次
#
# 为什么非做不可：一次性起进程 + 载模型实测 **9-12 秒/条**，而真正的转写只要 1-2 秒。
# 用户打开语音开关就说明有需求，"每条等十秒"是不能接受的手感。
# 这里起一个后台进程（voice_daemon.py），用 stdin/stdout 的 JSON 行通信，模型只载一次。
# --------------------------------------------------------------------------
class Daemon:
    """常驻的 faster-whisper 进程。进程崩了下次调用会自动重起。"""

    def __init__(self, python_exe: str, model: str, lib_dir=None):
        self.python_exe = str(python_exe)
        self.model = model
        self.lib_dir = str(lib_dir) if lib_dir else None
        self._proc = None
        self._lock = threading.Lock()
        self._startup_error = ''

    def _env(self) -> dict:
        env = dict(os.environ)
        env['PYTHONUTF8'] = '1'
        env['PYTHONIOENCODING'] = 'utf-8'
        env['MA_VOICE_MODEL'] = self.model
        if self.lib_dir:
            env['PYTHONPATH'] = self.lib_dir + os.pathsep + env.get('PYTHONPATH', '')
        return env

    def _ensure(self):
        """确保进程活着。返回 (proc, error)。"""
        if self._proc is not None and self._proc.poll() is None:
            return self._proc, ''
        script = Path(__file__).resolve().parent / 'voice_daemon.py'
        try:
            self._proc = subprocess.Popen(
                [self.python_exe, str(script)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                text=True, encoding='utf-8', errors='replace', env=self._env(), bufsize=1,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        except Exception as error:
            self._proc = None
            return None, '识别服务起不来：%s' % error
        # 第一行是就绪信息（含模型载入失败的原因）
        ready = self._read_line(timeout=600)
        if not ready:
            return None, '识别服务没有就绪'
        if ready.get('error'):
            self._startup_error = str(ready['error'])[:200]
            return None, self._startup_error
        self._startup_error = ''
        return self._proc, ''

    def _read_line(self, timeout: int):
        """读一行 JSON。daemon 载模型可能要几十秒，所以超时给得很宽。"""
        deadline = time.time() + timeout
        stream = self._proc.stdout
        while time.time() < deadline:
            line = stream.readline()
            if not line:
                return None
            line = line.strip()
            if not line:
                continue
            try:
                return json.loads(line)
            except ValueError:
                continue
        return None

    def transcribe(self, wav_path: str | Path, local_id) -> str:
        with self._lock:
            proc, error = self._ensure()
            if proc is None:
                raise VoiceError(error or '识别服务不可用')
            try:
                line = json.dumps({'wav': str(wav_path), 'id': local_id})
                proc.stdin.write(line + chr(10))
                proc.stdin.flush()
            except Exception as write_error:
                self.close()
                raise VoiceError('识别服务连接断了：%s' % write_error)
            reply = self._read_line(timeout=300)
            if reply is None:
                self.close()
                raise VoiceError('识别服务没有回应')
            if reply.get('error'):
                raise VoiceError(str(reply['error'])[:200])
            return str(reply.get('text') or '').strip()

    def close(self):
        proc, self._proc = self._proc, None
        if proc is None:
            return
        try:
            proc.stdin and proc.stdin.close()
        except Exception:
            pass
        try:
            proc.terminate()
        except Exception:
            pass


def cached_only(data_dir: str | Path, key) -> str:
    """只看缓存，**绝不触发转写**。

    读消息列表（首页、整理、会话详情）必须走这条：一条语音要 1-2 秒，
    一次读十几条就把页面卡死了（用户实测："进消息页要等好久才显示"）。
    没转过的就先不显示，交给后台队列，用户看到的是「转写中」。
    """
    target = Path(data_dir) / 'voice' / 'cache' / (str(key) + '.txt')
    try:
        if target.exists():
            return io.open(target, encoding='utf-8').read().strip()
    except OSError:
        pass
    return ''

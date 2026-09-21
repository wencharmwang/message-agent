"""常驻的语音识别服务（模型只加载一次）。

为什么要常驻：faster-whisper 每次启动都要重新载模型，实测一条语音要 **9-12 秒**，
其中绝大部分是进程启动 + 载模型，真正的转写只要 1-2 秒。
用户开了语音就是真有需求，不能每条都等十秒。

用法：由 voice.py 用装好依赖的那个 Python 起起来，走 **stdin/stdout 的 JSON 行**：

    进来：{"wav": "C:\\...\\v133.wav", "id": 133}
    出去：{"id": 133, "text": "转写结果"}
    出错：{"id": 133, "error": "原因"}

用管道而不是 HTTP：少一个端口、少一层依赖，而且这个进程本来就只服务于本机的一个调用方。
"""

from __future__ import annotations

import json
import os
import sys

# 强制 UTF-8：Windows 下管道默认 GBK，中文会读成乱码（这个坑踩过两次了）
os.environ.setdefault('PYTHONUTF8', '1')
os.environ.setdefault('PYTHONIOENCODING', 'utf-8')
# 别每次都去远端探测：先按"只用本地缓存"载，失败（第一次还没下）再走联网。
# 直接设 HF_HUB_OFFLINE=1 会把"第一次下载"也堵死。
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
# 转写只要 CPU 的少数几个核；开满会把用户机器占满
os.environ.setdefault('OMP_NUM_THREADS', str(max(2, (os.cpu_count() or 4) // 2)))

MODEL_NAME = os.environ.get('MA_VOICE_MODEL', 'small')
ZH_PROMPT = '以下是普通话的句子，请用简体中文。'


def main() -> int:
    try:
        from faster_whisper import WhisperModel
    except Exception as error:  # 没装依赖时直接说清楚，别让调用方猜
        json.dump({'ready': False, 'error': 'faster-whisper 不可用：%s' % error}, sys.stdout, ensure_ascii=False)
        sys.stdout.write('\n')
        sys.stdout.flush()
        return 2

    try:
        try:
            model = WhisperModel(MODEL_NAME, device='cpu', compute_type='int8', local_files_only=True)
        except Exception:
            # 本地还没有这个模型：联网下一次（只下一次）
            model = WhisperModel(MODEL_NAME, device='cpu', compute_type='int8')
    except Exception as error:
        json.dump({'ready': False, 'error': '模型载入失败：%s' % error}, sys.stdout, ensure_ascii=False)
        sys.stdout.write('\n')
        sys.stdout.flush()
        return 3

    json.dump({'ready': True, 'model': MODEL_NAME}, sys.stdout, ensure_ascii=False)
    sys.stdout.write('\n')
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            continue
        wav = request.get('wav') or ''
        job_id = request.get('id')
        try:
            segments, _info = model.transcribe(wav, language='zh', beam_size=5,
                                               initial_prompt=ZH_PROMPT)
            text = ''.join(segment.text for segment in segments).strip()
            payload = {'id': job_id, 'text': text}
        except Exception as error:
            payload = {'id': job_id, 'error': str(error)[:200]}
        json.dump(payload, sys.stdout, ensure_ascii=False)
        sys.stdout.write('\n')
        sys.stdout.flush()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

"""通过子进程调用 wechat-db-lab 的 ``watch`` 命令，把 stdout 的 ndjson 事件喂给 worker。

为什么用子进程而不是直接 import：agent_worker 跑在 messaging-runtime 自带的
``runtime\\python\\python.exe`` 上（无 cryptography/zstandard）；而 wechat-db-lab 依赖
这些包、且运行在自己的 venv 里。子进程把两个环境的依赖彻底解耦，也让"读 db"的进程
与"控制面"进程隔离——读 db 崩溃不会拖垮 worker，worker 重启也不打断监听。

事件协议：watch 命令首次建基线后输出 ``{"event": "ready", "workspace": ...}``，
之后每轮把新消息逐条输出为 ndjson（字段见 watcher.MessageEvent.as_dict）。
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import threading


class WatcherSource:
    """spawn 一个 watch 子进程，非阻塞地缓存其 stdout 事件。"""

    def __init__(
        self,
        python: str,
        src: str,
        *,
        workspace: str | None = None,
        account: str | None = None,
        interval: float = 3.0,
        overlap: int = 10,
    ) -> None:
        command = [
            python, "-m", "wechat_db_lab.cli", "watch",
            "--interval", str(interval),
            "--overlap", str(overlap),
        ]
        if workspace:
            command += ["--workspace", workspace]
        if account:
            command += ["--account", account]

        env = dict(os.environ)
        env["PYTHONPATH"] = str(src) + os.pathsep + env.get("PYTHONPATH", "")
        # 强制 watch 子进程用 UTF-8 输出：Windows 下默认 stdout 是 GBK(cp936)，
        # 而这里用 encoding="utf-8" 读，不一致会把中文消息正文读成乱码。
        env["PYTHONUTF8"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"

        self._events: queue.Queue[dict] = queue.Queue()
        self._ready = threading.Event()
        self._workspace: str | None = None
        self._stderr_tail: list[str] = []
        self._proc = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            bufsize=1,
            # Windows：不加这个会弹出一个 venv python.exe 的命令行窗口。
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def _read_stdout(self) -> None:
        assert self._proc.stdout is not None
        for line in self._proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if payload.get("event") == "ready":
                self._workspace = payload.get("workspace")
                self._ready.set()
            else:
                self._events.put(payload)

    def _read_stderr(self) -> None:
        assert self._proc.stderr is not None
        for line in self._proc.stderr:
            text = line.strip()
            if text:
                self._stderr_tail.append(text)
                del self._stderr_tail[:-20]

    def ready(self, timeout: float = 60.0) -> bool:
        """等到 watch 子进程完成首次基线（输出 ready）。超时返回 False。"""
        return self._ready.wait(timeout)

    def workspace(self) -> str | None:
        """watch 子进程最近一次解锁出的 workspace 根目录（未就绪为 None）。"""
        return self._workspace

    def poll(self) -> list[dict]:
        """取出累积事件（非阻塞）。"""
        out: list[dict] = []
        while True:
            try:
                out.append(self._events.get_nowait())
            except queue.Empty:
                break
        return out

    def alive(self) -> bool:
        return self._proc.poll() is None

    def last_error(self) -> str:
        return "\n".join(self._stderr_tail)

    def close(self) -> None:
        try:
            self._proc.terminate()
        except Exception:
            pass
        try:
            self._proc.wait(timeout=5)
        except Exception:
            try:
                self._proc.kill()
            except Exception:
                pass

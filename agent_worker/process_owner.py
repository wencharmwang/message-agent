"""Start the shared local MCP host once, without opening a console window.

**平台说明**：Windows 侧用 Job Object 保证"停掉计划任务就连带停掉 host 与 OCR 后代进程"。
其它平台没有 Job Object（macOS 的对应物是进程组 / launchd），这里整体降级为空操作，
让上层不用分平台写两套。

（原来顶部有一句 `import msvcrt`，而且根本没用上 —— 但 `launch.py` 是无条件 import
本模块的，于是那一句会让整个启动路径在 macOS 上**连 import 都过不去**。）
"""
import json
import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request

IS_WINDOWS = os.name == 'nt'

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / '.runtime-data'

# The scheduled supervisor owns a Windows job so stopping the task also stops its
# host and OCR descendants. Standalone one-shot starts intentionally do not own it.
SUPERVISOR_JOB = None

class BasicLimitInformation(ctypes.Structure):
    _fields_ = [('PerProcessUserTimeLimit',ctypes.c_longlong),('PerJobUserTimeLimit',ctypes.c_longlong),
                ('LimitFlags',wintypes.DWORD),('MinimumWorkingSetSize',ctypes.c_size_t),
                ('MaximumWorkingSetSize',ctypes.c_size_t),('ActiveProcessLimit',wintypes.DWORD),
                ('Affinity',ctypes.c_size_t),('PriorityClass',wintypes.DWORD),('SchedulingClass',wintypes.DWORD)]

class IoCounters(ctypes.Structure):
    _fields_ = [(name,ctypes.c_ulonglong) for name in ('ReadOperationCount','WriteOperationCount',
                 'OtherOperationCount','ReadTransferCount','WriteTransferCount','OtherTransferCount')]

class ExtendedLimitInformation(ctypes.Structure):
    _fields_ = [('BasicLimitInformation',BasicLimitInformation),('IoInfo',IoCounters),
                ('ProcessMemoryLimit',ctypes.c_size_t),('JobMemoryLimit',ctypes.c_size_t),
                ('PeakProcessMemoryUsed',ctypes.c_size_t),('PeakJobMemoryUsed',ctypes.c_size_t)]

def create_supervisor_job():
    """建一个"句柄一关就带走整棵子进程树"的 Job Object。

    非 Windows 返回 ``None`` —— 上层用 ``SUPERVISOR_JOB is None`` 判断即可，
    不用自己分平台。``ctypes.WinDLL`` 在 macOS 上根本不存在，所以这里必须先挡一道。
    """
    if not IS_WINDOWS:
        return None
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.CreateJobObjectW.argtypes=[ctypes.c_void_p,wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype=wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes=[wintypes.HANDLE,ctypes.c_int,ctypes.c_void_p,wintypes.DWORD]
    handle=kernel.CreateJobObjectW(None,None)
    limits=ExtendedLimitInformation()
    limits.BasicLimitInformation.LimitFlags=0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not handle or not kernel.SetInformationJobObject(handle,9,ctypes.byref(limits),ctypes.sizeof(limits)):
        raise ctypes.WinError(ctypes.get_last_error())
    return handle

def supervise_child(process):
    if not IS_WINDOWS or SUPERVISOR_JOB is None:
        return
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD]
    kernel.OpenProcess.restype=wintypes.HANDLE
    kernel.AssignProcessToJobObject.argtypes=[wintypes.HANDLE,wintypes.HANDLE]
    kernel.CloseHandle.argtypes=[wintypes.HANDLE]
    handle=kernel.OpenProcess(0x0101,False,process.pid)
    try:
        if not handle or not kernel.AssignProcessToJobObject(SUPERVISOR_JOB,handle):
            process.terminate()
            process.wait(timeout=10)
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        if handle: kernel.CloseHandle(handle)




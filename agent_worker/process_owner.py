"""Start the shared local MCP host once, without opening a console window."""
import json
import ctypes
from ctypes import wintypes
import msvcrt
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request

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
    if SUPERVISOR_JOB is None:
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




"""Retire message-agent supervisor processes that were left behind.

`tools/start_shared_runtime.py --supervise` and `launch.py` never exit on their own:
once another host already owns port 8766 they only idle, so every restart leaves one
more orphan behind. A stale supervisor is not harmless — it can win the race for the
port and spawn a Host from a window station that cannot see user windows, which makes
every read fail with provider_unavailable while it holds the port.

Run this before starting fresh supervisors (restart.ps1 does), or on its own to see
what is left over. Only processes whose command line references one of the supervisor
entry points are touched.

Usage:  python reap-supervisors.py [--dry-run]
"""
import argparse
import ctypes
from ctypes import wintypes
import os
import subprocess
import sys
import time

SUPERVISOR_MARKERS = ('start_shared_runtime.py', 'launch.py')

kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
ntdll = ctypes.WinDLL('ntdll')
kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.ReadProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p,
                                       ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
kernel32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD,
                                                wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
PROCESS_TERMINATE = 0x0001
# x64 PEB.RTL_USER_PROCESS_PARAMETERS.CommandLine. Reading another process of the same
# user and integrity level needs no elevation, which is exactly our situation.
PEB_PROCESS_PARAMETERS = 0x20
PARAMETERS_COMMAND_LINE = 0x70


class ProcessBasicInformation(ctypes.Structure):
    _fields_ = [('Reserved1', ctypes.c_void_p), ('PebBaseAddress', ctypes.c_void_p),
                ('Reserved2', ctypes.c_void_p * 2), ('UniqueProcessId', ctypes.c_void_p),
                ('InheritedFromUniqueProcessId', ctypes.c_void_p)]


def _read(handle, address, size):
    buffer = ctypes.create_string_buffer(size)
    read = ctypes.c_size_t()
    if not kernel32.ReadProcessMemory(handle, ctypes.c_void_p(address), buffer, size, ctypes.byref(read)):
        return None
    return buffer.raw[:read.value]


def command_line(pid):
    handle = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        return None
    try:
        info = ProcessBasicInformation()
        returned = ctypes.c_ulong()
        if ntdll.NtQueryInformationProcess(handle, 0, ctypes.byref(info), ctypes.sizeof(info),
                                           ctypes.byref(returned)) != 0:
            return None
        raw = _read(handle, int(info.PebBaseAddress) + PEB_PROCESS_PARAMETERS, 8)
        if not raw:
            return None
        parameters = int.from_bytes(raw, 'little')
        raw = _read(handle, parameters + PARAMETERS_COMMAND_LINE, 16)
        if not raw:
            return None
        length = int.from_bytes(raw[0:2], 'little')
        buffer_address = int.from_bytes(raw[8:16], 'little')
        if not length or not buffer_address:
            return None
        raw = _read(handle, buffer_address, length)
        return raw.decode('utf-16-le', errors='replace') if raw else None
    finally:
        kernel32.CloseHandle(handle)


def parent_pid(pid):
    handle = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION, False, pid)
    if not handle:
        return None
    try:
        info = ProcessBasicInformation()
        returned = ctypes.c_ulong()
        if ntdll.NtQueryInformationProcess(handle, 0, ctypes.byref(info), ctypes.sizeof(info),
                                           ctypes.byref(returned)) != 0:
            return None
        return int(info.InheritedFromUniqueProcessId)
    finally:
        kernel32.CloseHandle(handle)


def process_names():
    """pid -> image name, from tasklist so no extra dependency is needed."""
    names = {}
    completed = subprocess.run(['tasklist', '/FO', 'CSV', '/NH'], capture_output=True,
                               text=True, errors='replace')
    for line in completed.stdout.splitlines():
        parts = [piece.strip('"') for piece in line.split('","')]
        if len(parts) >= 2 and parts[1].isdigit():
            names[int(parts[1])] = parts[0]
    return names


def is_alive(pid):
    handle = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION, False, pid)
    if not handle:
        return False
    kernel32.CloseHandle(handle)
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--dry-run', action='store_true', help='list the supervisors without terminating them')
    args = parser.parse_args()

    self_pid = os.getpid()
    names = process_names()
    alive = {pid for pid in names if is_alive(pid)}
    found = []
    for pid, name in sorted(names.items()):
        if pid == self_pid or not name.lower().startswith('python'):
            continue
        if pid not in alive:
            continue
        line = command_line(pid)
        if not line or not any(marker in line for marker in SUPERVISOR_MARKERS):
            continue
        found.append((pid, name, parent_pid(pid), line.strip()))

    if not found:
        print('no leftover supervisor processes found')
        return 0

    for pid, name, parent, line in found:
        orphan = 'orphan' if parent not in names else f'parent {names[parent]}({parent})'
        action = 'would stop' if args.dry_run else 'stopping'
        print(f'{action} {name}({pid}) [{orphan}]')
        if not args.dry_run:
            handle = kernel32.OpenProcess(PROCESS_TERMINATE, False, pid)
            if not handle:
                print(f'  could not open for termination (error {ctypes.get_last_error()})')
                continue
            kernel32.TerminateProcess(handle, 0)
            kernel32.CloseHandle(handle)

    if not args.dry_run:
        time.sleep(1.0)
        survivors = [pid for pid, _, _, _ in found if is_alive(pid)]
        print(f'stopped {len(found) - len(survivors)} of {len(found)}'
              + (f'; still alive: {survivors}' if survivors else ''))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

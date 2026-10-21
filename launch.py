"""Supervise the message worker and the supported dsh Web profile together."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
from agent_worker import process_owner, secrets_store
from agent_worker.decision import read_dotenv

ROOT = Path(__file__).resolve().parent
# config.json 的位置分两种布局：开发态 launch.py 与 config.json 同在仓库根；
# 安装态 launch.py 在 <安装目录>\app\ 下，config.json 在安装根（上一层）。
# 其余资源（plugin/presets/web.patch.yml/node-bootstrap）两种布局都跟 launch.py 同目录，用 ROOT。
CONFIG_ROOT = ROOT if (ROOT / 'config.json').is_file() else ROOT.parent

# 非 Windows 上没有这个常量：直接写 `subprocess.CREATE_NO_WINDOW` 会在 macOS 上报
# AttributeError，而这是启动路径上第一行 Popen —— 等于一开就死。
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


def _launcher_log_path():
    """启动器自己的日志（和 harness.log 同目录）。"""
    try:
        config = json.loads((CONFIG_ROOT / 'config.json').read_text(encoding='utf-8-sig'))
        base = Path(config.get('log_file') or (CONFIG_ROOT / 'harness.log'))
    except Exception:
        base = CONFIG_ROOT / 'harness.log'
    return base.with_name('launcher.log')


def _attach_stderr():
    """把 sys.stdout / sys.stderr 接到 launcher.log 上。

    start.ps1 用 **pythonw** 起这个文件，而 pythonw 没有控制台 —— 于是
    `sys.stdout` / `sys.stderr` 都是 None。后果有两个，都踩过：
      * 本文件里任何 `print(..., file=sys.stderr)` 直接抛 AttributeError，
        启动当场死掉；
      * 未捕获异常的 traceback 无处可写，**harness.log 一个字都不留**。
    症状就是"双击/重启后什么都不发生，只有一句启动超时"，查一整天。
    （2026-10-21 实例：`_start_runtime_and_wait` 漏了 import socket，一进等待
    循环就 NameError；安装版 pythonw 静默退出，日志 mtime 还停在前一次。）
    所以：一进来就把两个流指到文件，并且写一行启动横幅当路标。
    """
    if sys.stdout is not None and sys.stderr is not None:
        return None
    try:
        path = _launcher_log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        # 新建时带 BOM：Windows 上 PowerShell 5.1 默认按 ANSI(GBK) 读文件，
        # 无 BOM 的 UTF-8 中文会显示成乱码 —— 而这份日志就是给人和维护者看的。
        encoding = 'utf-8' if path.exists() and path.stat().st_size else 'utf-8-sig'
        sink = open(path, 'a', encoding=encoding, buffering=1)
    except OSError:
        return None
    sink.write('\n=== {0} launch pid={1} python={2} root={3}\n'.format(
        time.strftime('%Y-%m-%d %H:%M:%S'), os.getpid(), sys.executable, CONFIG_ROOT))
    if sys.stdout is None:
        sys.stdout = sink
    if sys.stderr is None:
        sys.stderr = sink
    return sink

# 注：这里**不再有任何微信密钥的处理**。本项目不接触密钥与解密 —— 解锁由外部完成，
# 产物是一个"已解锁目录"（协议见 docs/unlocked-db-protocol.md），本项目只读它。
# 因此原来那套"把密钥解到运行目录喂给 watcher / 用标记文件控制是否允许扫内存"的机制
# 整体删除：既然不再解锁，也就没有"要不要允许扫内存"这个问题。


def _token_rejected(port, token):
    """用登记 token 探一次 MCP：401 说明端口上不是我们的服务（陌生实例）。"""
    import urllib.error
    import urllib.request
    try:
        body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                           'params': {'name': 'get_send_status',
                                      'arguments': {'request_id': 'launch-probe'}}}).encode('utf-8')
        request = urllib.request.Request(f'http://127.0.0.1:{port}/mcp', body,
                                         headers={'Authorization': 'Bearer ' + token,
                                                  'Content-Type': 'application/json',
                                                  'Accept': 'application/json'})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=5):
            return False
    except urllib.error.HTTPError as error:
        # 401 = 明确拒收我们的 token（别人家的实例）；5xx = 服务自身没起来好，
        # 不算陌生实例，别吓用户。
        return error.code == 401
    except OSError:
        return False


def _start_runtime_and_wait(exe, runtime_root, port, runtime_cfg, runtime_token):
    """拉起消息服务进程并等它在端口就绪。返回是否就绪（输出细节落 runtime-*.log）。"""
    import socket

    args = [str(exe), '--http', '--port', str(port), '--config', str(runtime_cfg)]
    # HTTP 模式要求 MESSAGING_RUNTIME_TOKEN（32+ 字符）环境变量，运行时用它鉴权。
    child_env = dict(os.environ)
    child_env['MESSAGING_RUNTIME_TOKEN'] = runtime_token
    # 输出落文件：NO_WINDOW 下看不到它的报错（比如微信桌面被另一个实例占用）。
    runtime_log = open(runtime_root / 'runtime-first-start.log', 'a', encoding='utf-8')
    # 尽量让消息服务脱离本程序的作业对象（它该独立常驻）；作业对象不允许脱离时退回继承。
    breakaway = getattr(subprocess, 'CREATE_BREAKAWAY_FROM_JOB', 0)
    try:
        subprocess.Popen(args, cwd=str(runtime_root), env=child_env,
                         stdout=runtime_log, stderr=runtime_log, creationflags=NO_WINDOW | breakaway)
    except OSError:
        subprocess.Popen(args, cwd=str(runtime_root), env=child_env,
                         stdout=runtime_log, stderr=runtime_log, creationflags=NO_WINDOW)
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        time.sleep(1)
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=1):
                return True
        except OSError:
            pass
    return False


def ensure_message_runtime(config):
    """拿到消息服务（messaging-runtime）的令牌；没初始化时拉起它并登记端点。

    消息服务是独立进程（MCP over HTTP）。shared-service.json **不是运行时自己写的**
    （dev 环境里它是建环境时手工放好的），安装版由这里负责。关键：**登记在案 ≠ 活着**。
    以前登记文件存在就直接拿令牌返回，不看服务死活 —— 服务没跑时 worker 拿着
    令牌调 8766 每次都连接拒绝，所有发送变 uncertain/needs_user，症状就是
    "自动回复全都发不出去"（实测踩到：客户机重启后没人再拉它）。现在：
      1. 有登记 → 端口活着直接用；死了按登记的 config+token 拉活（令牌不变，
         worker 与服务的约定不受影响）；
      2. 端口在监听但**没登记** → 说不上它的令牌，只能降级（不猜别人的实例）；
      3. 什么都没有、安装目录里有 exe → 生成令牌与默认配置、写登记、首启一次。
    都不行 → 返回 None，引擎和页面照常起，发消息功能等消息服务就绪后重启生效。
    """
    import secrets as _secrets
    import socket

    runtime_settings = Path(config['runtime_settings_file'])
    port = config.get('runtime_port', 8766)
    # runtime_settings_file 约定是 <RuntimeRoot>\.runtime-data\shared-service.json
    runtime_root = runtime_settings.parent.parent
    exe = runtime_root / 'artifacts' / 'app' / 'messaging-runtime.exe'

    def port_listening():
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=1):
                return True
        except OSError:
            return False

    registered = None
    if runtime_settings.is_file():
        try:
            registered = json.loads(runtime_settings.read_text(encoding='utf-8-sig'))
        except Exception:
            registered = None
    if registered and registered.get('token'):
        if port_listening():
            # 端口活着 ≠ 是**我们的**服务：开发机上 dev 环境的 messaging-runtime
            # 有自己的守护任务，抢着常驻 8766 —— 本产品 worker 拿本安装的 token
            # 去调它，每次都 401，自动回复全部 "Runtime: uncertain"（实测踩到）。
            # 用登记 token 探一下：401 就说明端口上是陌生实例，如实报警。
            if _token_rejected(port, registered['token']):
                print(f'[launch] 端口 {port} 被一个不认识的服务占着（多半是开发环境的 '
                      'messaging-runtime 在跑）。自动回复会发不出去；测试安装版请先停掉它。'
                      '（本安装自己的服务等端口空出来、下次重启时自动接上。）', file=sys.stderr)
            return registered['token']
        runtime_cfg = registered.get('config')
        if exe.is_file() and runtime_cfg and Path(runtime_cfg).is_file():
            print(f'[launch] 消息服务没在运行（端口 {port}），按登记拉起…', file=sys.stderr)
            if _start_runtime_and_wait(exe, runtime_root, port, runtime_cfg, registered['token']):
                return registered['token']
            print(f'[launch] 消息服务拉起后 60 秒内没就绪（输出见 {runtime_root / "runtime-first-start.log"}），'
                  '先不带 runtime 令牌启动。', file=sys.stderr)
            return None
        print(f'[launch] 消息服务有登记但起不来（缺 {exe} 或配置 {runtime_cfg}），先不带 runtime 令牌。', file=sys.stderr)
        return None

    if not exe.is_file():
        print(f'[launch] 消息服务未初始化且找不到 {exe}，先不带 runtime 令牌启动。', file=sys.stderr)
        return None
    runtime_settings.parent.mkdir(parents=True, exist_ok=True)

    if port_listening():
        # 端口被占但没有登记文件：多半是别的实例（token 无从知晓），不猜。
        print(f'[launch] 端口 {port} 已被占用但没有 {runtime_settings}，先不带 runtime 令牌启动。', file=sys.stderr)
        return None

    cfg_dir = runtime_root / 'config'
    runtime_cfg = cfg_dir / 'messaging-runtime.json'
    example = cfg_dir / 'messaging-runtime.example.json'
    if not runtime_cfg.is_file() and example.is_file():
        cfg = json.loads(example.read_text(encoding='utf-8-sig'))
        # 相对路径全部改写成安装位置上的绝对路径
        cfg['data_directory'] = str(runtime_root / '.runtime-data')
        if config.get('database'):
            cfg['auto_reply_database'] = config['database']
        if config.get('worker_token_file'):
            cfg['auto_reply_token_file'] = config['worker_token_file']
        runtime_cfg.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding='utf-8')

    # 令牌先落盘再拉起：worker 与消息服务用同一份，launch 重启也能接上。
    runtime_token = _secrets.token_hex(32)
    runtime_settings.write_text(json.dumps(
        {'port': port, 'token': runtime_token, 'config': str(runtime_cfg)},
        ensure_ascii=False, indent=2), encoding='utf-8')

    print(f'[launch] 首次启动消息服务（端口 {port}），最多等 60 秒…', file=sys.stderr)
    if _start_runtime_and_wait(exe, runtime_root, port, runtime_cfg, runtime_token):
        return runtime_token
    print(f'[launch] 消息服务 60 秒内没在端口 {port} 就绪，先不带 runtime 令牌启动。'
          f'（首启输出见 {runtime_root / "runtime-first-start.log"}）', file=sys.stderr)
    return None


def main():
    config_path = CONFIG_ROOT / 'config.json'
    config = json.loads(config_path.read_text(encoding='utf-8-sig'))
    process_owner.SUPERVISOR_JOB = process_owner.create_supervisor_job()
    class OwnProcess:
        pid = os.getpid()
    process_owner.supervise_child(OwnProcess())
    env = dict(os.environ)
    # 开发布局把 key 放在引擎的 .env 里；正式安装由安装器写进 DPAPI 存储（明文不落盘）。
    # 两个来源都读，DPAPI 优先：它是新的、也是给用户看的那个。
    env.update(read_dotenv(Path(config['harness_root']) / '.env'))
    credentials = Path(config.get('credentials_dir') or (ROOT / 'credentials'))
    stored = secrets_store.read_secret(credentials / 'model-cloud.dat')
    if stored:
        # 注进来的是**所有** `<供应商>_API_KEY` —— 用户可以在界面里换供应商
        # （OpenAI / Claude / 通义 / 智谱 / Kimi…），换一家就往这个文件里加一个键，
        # 不该每加一家都要回来改这里。
        for name, value in stored.items():
            if name.endswith('_API_KEY') and isinstance(value, str) and value:
                env[name] = value
    env['MESSAGE_AGENT_CONFIG'] = str(config_path)
    env['MESSAGE_AGENT_ROOT'] = str(ROOT)
    env['MESSAGE_AGENT_CREDENTIALS'] = str(credentials)
    env['DSH_HOME'] = str(config.get('harness_home') or (ROOT / '.harness'))
    env['DSH_TELEMETRY_DISABLED'] = '1'
    # worker 令牌先就位：消息服务的默认配置里 auto_reply_token_file 指向它。
    worker_token = Path(config['worker_token_file'])
    if worker_token.is_file():
        env['MESSAGE_WORKER_TOKEN'] = worker_token.read_text().strip()
    else:
        worker_token.parent.mkdir(parents=True, exist_ok=True)
        import secrets as _secrets
        worker_token.write_text(_secrets.token_hex(32))
        env['MESSAGE_WORKER_TOKEN'] = worker_token.read_text().strip()
    runtime_token = ensure_message_runtime(config)
    if runtime_token:
        env['MESSAGE_RUNTIME_TOKEN'] = runtime_token
    # **harness 侧也需要这两个** —— 别只给 worker：
    #   * plugin/index.mjs 启动时就 `readFileSync(process.env.MESSAGE_AGENT_CONFIG)`，
    #     拿不到就是 `path ... Received undefined`，整个插件树加载失败、harness 起不来；
    #   * web.patch.yml 里用 `process.env.MESSAGE_AGENT_ROOT + '/presets'` 定位预设。
    # 之前只有 worker 那侧设了它们，于是"从干净 shell 启动"必然失败，
    # 而在恰好带着这两个变量的环境里启动又能成功 —— 表现成"有时能起有时起不来"。
    env['MESSAGE_AGENT_CONFIG'] = str(config_path)
    env['MESSAGE_AGENT_ROOT'] = str(ROOT)
    env['PATH'] = str(Path(config['node_executable']).parent) + os.pathsep + env.get('PATH', '')
    # 安装在 Program Files 那类只读位置时，日志不能往安装目录写；位置由安装器给。
    log_path = Path(config.get('log_file') or (ROOT / 'harness.log'))
    log_path.parent.mkdir(parents=True, exist_ok=True)
    # 简单轮转：超过 5 MB 就把当前日志挪成 .1（只留一份）。原来是无上限追加，
    # 长期跑下来会把磁盘吃掉。
    try:
        if log_path.exists() and log_path.stat().st_size > 5 * 1024 * 1024:
            os.replace(log_path, log_path.with_suffix(log_path.suffix + '.1'))
    except OSError:
        pass
    log = open(log_path, 'a', encoding='utf-8')
    # 引擎入口按布局挑：部署目录（pnpm deploy 产物，lib/bin.js 在根部）→ 已构建的
    # 源码仓（apps/cli/lib/bin.js）→ 纯 TS 源码（apps/cli/src/bin.ts，要挂 tsx）。
    # 构建产物用普通 node 直接跑，比 tsx 转译 TS 快得多；tsx 只在跑源码时才需要。
    harness_root = Path(config['harness_root'])
    entry = None
    for relative in ('lib/bin.js', 'apps/cli/lib/bin.js', 'apps/cli/src/bin.ts'):
        candidate = harness_root / relative
        if candidate.is_file():
            entry = candidate
            break
    if entry is None:
        raise RuntimeError(f'engine entry not found under {harness_root}')
    command = [config['node_executable'], '--import', (ROOT/'node-bootstrap.mjs').as_uri()]
    if entry.suffix == '.ts':
        command += ['--import', 'tsx/esm']
    command += [str(entry),
                '--profile','web','--patch',str(ROOT/'web.patch.yml'),'--port',str(config['harness_port']),'--no-open']
    host = subprocess.Popen(command,cwd=config['harness_root'],env=env,stdout=log,stderr=log,creationflags=NO_WINDOW)
    # The TCP listener opens before the message plugin finishes loading. Do not
    # start the worker until its private job route is actually ready.
    health_token = Path(config['control_token_file']).read_text().strip()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.time() + 60
    while True:
        if host.poll() is not None:
            raise RuntimeError('Harness exited before the message plugin became ready')
        try:
            request = urllib.request.Request(
                f"http://127.0.0.1:{config['harness_port']}/message-agent/health",
                headers={'Authorization':'Bearer '+health_token})
            with opener.open(request,timeout=2) as response:
                if json.load(response).get('ready') is True:
                    break
        except Exception:
            if time.time() >= deadline:
                raise RuntimeError('Harness message plugin did not become ready')
            time.sleep(.25)
    # Worker 不继承主进程的 Runtime token 与模型凭据。
    # 也不需要给任何微信密钥 —— 它读的是一个**已解锁目录**（配置项 unlocked_root），
    # 解锁是外部工具的事。缺产物时 worker 会如实报告，由界面提示用户去解锁。
    worker_env = dict(os.environ)
    worker_env['MESSAGE_AGENT_CONFIG'] = str(config_path)
    worker_env['MESSAGE_AGENT_ROOT'] = str(ROOT)
    worker_env['MESSAGE_AGENT_CREDENTIALS'] = str(credentials)
    worker = subprocess.Popen([sys.executable,'-m','agent_worker','--config',str(config_path)],cwd=ROOT,
                              env=worker_env, stdout=log, stderr=log, creationflags=NO_WINDOW)
    try:
        while host.poll() is None and worker.poll() is None:
            time.sleep(1)
        raise RuntimeError('Message Agent child exited; inspect harness.log')
    finally:
        host.terminate()
        worker.terminate()

if __name__ == '__main__':
    _attach_stderr()
    try:
        main()
    except BaseException:
        # main() 正常路径本来就是"跑到子进程退出再抛"，所以这里不改退出码，
        # 只保证 traceback 一定落到文件里（pythonw 下 sys.stderr 可能仍是 None）。
        import traceback
        _text = traceback.format_exc()
        if sys.stderr is not None:
            sys.stderr.write(_text)
            sys.stderr.flush()
        else:
            try:
                with open(_launcher_log_path(), 'a', encoding='utf-8') as _fallback:
                    _fallback.write(_text)
            except OSError:
                pass
        raise


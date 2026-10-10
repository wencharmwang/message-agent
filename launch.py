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

# 非 Windows 上没有这个常量：直接写 `subprocess.CREATE_NO_WINDOW` 会在 macOS 上报
# AttributeError，而这是启动路径上第一行 Popen —— 等于一开就死。
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)

# 注：这里**不再有任何微信密钥的处理**。本项目不接触密钥与解密 —— 解锁由外部完成，
# 产物是一个"已解锁目录"（协议见 docs/unlocked-db-protocol.md），本项目只读它。
# 因此原来那套"把密钥解到运行目录喂给 watcher / 用标记文件控制是否允许扫内存"的机制
# 整体删除：既然不再解锁，也就没有"要不要允许扫内存"这个问题。


def main():
    config_path = ROOT / 'config.json'
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
    settings = json.loads(Path(config['runtime_settings_file']).read_text(encoding='utf-8-sig'))
    env['MESSAGE_RUNTIME_TOKEN'] = settings['token']
    env['MESSAGE_WORKER_TOKEN'] = Path(config['worker_token_file']).read_text().strip()
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
    command = [config['node_executable'],'--import',(ROOT/'node-bootstrap.mjs').as_uri(),'--import','tsx/esm',str(Path(config['harness_root'])/'apps/cli/src/bin.ts'),
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
    main()


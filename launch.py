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

# 宿主（产品）侧的约定，和 wechat-db-lab 的 vault.memory_scan_allowed() 对应。
NO_SCAN_ENV = 'WECHAT_DB_LAB_NO_SCAN'
# "用户已经授权扫一次"的标记文件：由 packaging/读取微信密钥.ps1 在一次授权动作里写入，
# 用完就删（见 allow_memory_scan）。不是一个长期开关 —— 长期开着等于自动扫。
SCAN_GRANT_FILE = 'wechat-scan-grant'


def allow_memory_scan(credentials: Path) -> bool:
    """本次启动是否允许 watcher 去读微信进程内存。

    只有"用户刚点过授权"（授权标记还在）才允许。标记由授权脚本写入并**在启动后被消费掉**，
    这样即使脚本中途失败，也不会留下一个"以后都自动扫"的状态。
    """
    grant = credentials / SCAN_GRANT_FILE
    try:
        if not grant.exists():
            return False
        grant.unlink()
        return True
    except OSError:
        return False


def write_wechat_key_cache(run_dir: Path, account: str, keys: dict) -> Path:
    """把密钥写成 wechat-db-lab 认识的样子：`<运行目录>/keys/<账号>.json`。

    它的 `cache_dirs()` 支持用 `WECHAT_DB_LAB_KEYS_DIR` 覆盖缓存目录，启动器就是靠这个
    把"解密出来的运行时副本"喂给它，磁盘上不再需要那份长期存在的明文缓存。
    """
    directory = run_dir / 'keys'
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / (account + '.json')
    target.write_text(json.dumps(keys, ensure_ascii=False), encoding='utf-8')
    return target

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
    # Worker never inherits the main interactive Runtime token or model credential.
    # 但微信密钥要给它：worker 会拉起 watcher，watcher 需要密钥目录才能解锁。
    # 所以只挑这两项传过去，其余（模型 key、Runtime token）一律不给。
    worker_env = dict(os.environ)
    worker_env['MESSAGE_AGENT_CONFIG'] = str(config_path)
    worker_env['MESSAGE_AGENT_ROOT'] = str(ROOT)
    worker_env['MESSAGE_AGENT_CREDENTIALS'] = str(credentials)
    # 默认**不允许**自动读微信进程内存：把 DPAPI 里保存的密钥解到一个本次运行专用的目录，
    # 让 watcher 只用缓存。缓存凑不齐时它会如实报告缺哪些密钥，由界面提示用户点一次授权
    # （那一次走 packaging/读取微信密钥.ps1，会显式开放扫描）。
    stored = secrets_store.load_wechat_keys(credentials / secrets_store.WECHAT_KEYS_FILE)
    if stored:
        account, stored_keys, _saved_at = stored
        write_wechat_key_cache(Path(config.get('run_dir') or (credentials / 'run')), account, stored_keys)
        worker_env['WECHAT_DB_LAB_KEYS_DIR'] = str(Path(config.get('run_dir') or (credentials / 'run')) / 'keys')
    else:
        worker_env.pop('WECHAT_DB_LAB_KEYS_DIR', None)
    if not allow_memory_scan(credentials):
        worker_env[NO_SCAN_ENV] = '1'
    # 保险：启动时清掉 wechat-db-lab 默认目录里的明文密钥缓存。
    # 我们的密钥只存在于 DPAPI 存储 + 本次运行的临时副本里；上游工具历史上会在
    # %LOCALAPPDATA%\wechat-db-lab\keys 留一份（新版本已经不在那儿写了，见 cache_dirs 的注释），
    # 但用户机器上可能有旧版本留下的。
    for stale_dir in [Path(os.environ.get('LOCALAPPDATA', '')) / 'wechat-db-lab' / 'keys']:
        try:
            for stale in stale_dir.glob('*.json*'):
                stale.unlink()
        except OSError:
            pass
    worker = subprocess.Popen([sys.executable,'-m','agent_worker','--config',str(config_path)],cwd=ROOT,
                              env=worker_env, stdout=log, stderr=log, creationflags=NO_WINDOW)
    try:
        while host.poll() is None and worker.poll() is None:
            time.sleep(1)
        raise RuntimeError('Message Agent child exited; inspect harness.log')
    finally:
        host.terminate()
        worker.terminate()
        # 运行时那份解密出来的密钥缓存用完就删：它是明文，只该存在于进程存活期间。
        # （DPAPI 里的那份不受影响，下次启动重新解出来。）
        try:
            for leftover in (Path(config.get('run_dir') or (credentials / 'run')) / 'keys').glob('*.json'):
                leftover.unlink()
        except OSError:
            pass

if __name__ == '__main__':
    main()


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
        for name in ('DEEPSEEK_API_KEY', 'OLLAMA_LOCAL_API_KEY'):
            if stored.get(name):
                env[name] = stored[name]
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
    host = subprocess.Popen(command,cwd=config['harness_root'],env=env,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
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
    worker = subprocess.Popen([sys.executable,'-m','agent_worker','--config',str(config_path)],cwd=ROOT,
                              stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        while host.poll() is None and worker.poll() is None:
            time.sleep(1)
        raise RuntimeError('Message Agent child exited; inspect harness.log')
    finally:
        host.terminate()
        worker.terminate()

if __name__ == '__main__':
    main()


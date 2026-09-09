"""Supervise the message worker and the supported dsh Web profile together."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
from agent_worker import process_owner
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
    env.update(read_dotenv(Path(config['harness_root']) / '.env'))
    env['MESSAGE_AGENT_CONFIG'] = str(config_path)
    env['MESSAGE_AGENT_ROOT'] = str(ROOT)
    env['DSH_HOME'] = str(ROOT / '.harness')
    env['DSH_TELEMETRY_DISABLED'] = '1'
    settings = json.loads(Path(config['runtime_settings_file']).read_text(encoding='utf-8-sig'))
    env['MESSAGE_RUNTIME_TOKEN'] = settings['token']
    env['MESSAGE_WORKER_TOKEN'] = Path(config['worker_token_file']).read_text().strip()
    env['PATH'] = str(Path(config['node_executable']).parent) + os.pathsep + env.get('PATH', '')
    log = open(ROOT / 'harness.log', 'a', encoding='utf-8')
    command = [config['node_executable'],'--import','tsx/esm',str(Path(config['harness_root'])/'apps/cli/src/bin.ts'),
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


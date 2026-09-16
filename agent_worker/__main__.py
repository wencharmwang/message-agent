"""Run with python -m tools.auto_reply --config <file>; management stays on loopback."""
import argparse
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import threading
import time
import uuid
from .service import Worker, RuntimeToolError, is_system_entry, error_trace
from .harness import Harness


def load_config(path):
    config = json.loads(Path(path).read_text(encoding='utf-8-sig'))
    for name in ('database', 'runtime_settings_file', 'worker_token_file', 'control_token_file', 'harness_root', 'harness_home', 'node_executable', 'agent_workspace'):
        if not isinstance(config.get(name), str) or not Path(config[name]).is_absolute():
            raise ValueError(name + ' must be an absolute path')
    ranges = {'harness_port': (1024, 65535), 'poll_interval_seconds': (2, 300), 'settle_seconds': (0, 60), 'response_timeout_seconds': (10, 600),
              'job_ttl_seconds': (60, 3600), 'min_reply_interval_seconds': (0, 300), 'max_reply_chars': (1, 1000), 'control_port': (1024, 65535)}
    for name, (low, high) in ranges.items():
        value = config.get(name)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
            raise ValueError('Invalid ' + name)
    if not isinstance(config.get('model'), str) or not config['model']:
        raise ValueError('model is required')
    if config.get('auto_reasoning_effort', 'low') not in ('off', 'low', 'high', 'max'):
        raise ValueError('Invalid auto_reasoning_effort')
    return config


def handler(worker, token):
    def dev_diagnostics():
        """Developer switch: keep the raw failure and the call stack in the response.

        While the product is being built, "读取不到消息" is a dead end otherwise — the
        runtime hands back a short code, the product layer turns it into one friendly
        sentence, and whoever is debugging has nothing left to look at. Off at launch,
        this is only ever the switch that decides whether the raw text is attached.
        """
        return worker.store.setting('dev_diagnostics', '1') == '1'

    def dev_block(error, where):
        """The unvarnished failure: code, the runtime's own wording, and the trace.

        Returns an empty dict when the switch is off, so the payload cannot leak the
        stack to an end user by accident — the caller does not have to remember to gate it.
        """
        if not dev_diagnostics():
            return {}
        code = getattr(error, 'code', None) or type(error).__name__
        return {
            'code': code,
            'detail': str(getattr(error, 'detail', '') or ''),
            'message': str(error)[:500],
            'trace': error_trace(error),
            'where': where,
            'at': time.strftime('%Y-%m-%d %H:%M:%S'),
        }

    def current_settings():
        return {
            'auto_restore_window': worker.store.setting('auto_restore_window', '1') == '1',
            'auto_model': worker.store.setting('auto_model', worker.config['model']),
            'observe_enabled': worker.observe_enabled(),
            'dev_diagnostics': dev_diagnostics(),
        }

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def response(self, code, data):
            body = json.dumps(data, ensure_ascii=False).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(body)

        def allowed(self):
            expected_host = f"127.0.0.1:{worker.config['control_port']}"
            if self.headers.get('Host') != expected_host or self.headers.get('Origin', 'http://' + expected_host) != 'http://' + expected_host:
                self.response(403, {'error': 'Origin rejected'})
                return False
            if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
                self.response(401, {'error': 'Authentication required'})
                return False
            return True

        def do_GET(self):
            if self.path == '/':
                self.send_response(302)
                self.send_header('Location', f"http://127.0.0.1:{worker.config['harness_port']}/")
                self.end_headers()
                return
            if not self.allowed():
                return
            if self.path == '/api/status':
                rules = [{k: v for k, v in r.items() if k not in ('baseline', 'candidate')} for r in worker.store.rules()]
                self.response(200, {'rules': rules, 'jobs': worker.store.recent(), 'error': worker.last_error,
                                    'agent': 'DeepSeek Harness', 'model': current_settings()['auto_model'], 'started_at': worker.started_at})
            elif self.path == '/api/settings':
                self.response(200, {'settings': current_settings()})
            elif self.path == '/api/conversations':
                try:
                    page = worker.mcp.call('list_conversations', {'provider': 'wechat-main'})
                    # Keep the pickers clean too: 公众号/服务号/微信支付 are not contacts.
                    page['conversations'] = [c for c in page.get('conversations', [])
                                             if not is_system_entry(c.get('title') or '')]
                    self.response(200, page)
                except Exception as error:
                    self.response(503, {'error': '无法读取会话列表，请检查微信和 Runtime',
                                        'dev': dev_block(error, 'worker:conversations')})
            elif self.path == '/api/observe':
                # Cached discovery result: the product polls this often, and each call
                # here must not turn into another WeChat read.
                snapshot = worker.observation_snapshot()
                if not dev_diagnostics():
                    snapshot.pop('error_trace', None)
                self.response(200, snapshot)
            else:
                self.response(404, {'error': 'Not found'})

        def do_POST(self):
            if not self.allowed():
                return
            if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                self.response(415, {'error': 'JSON required'})
                return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 20000:
                    raise ValueError('Invalid request size')
                data = json.loads(self.rfile.read(length))
                if self.path == '/api/rules':
                    # Resolve from current provider output; do not trust a client-supplied display name.
                    choices = worker.mcp.call('list_conversations', {'provider': 'wechat-main'})['conversations']
                    matches = [c for c in choices if c['id'] == data.get('conversation_id')]
                    if not matches:
                        raise ValueError('微信当前显示的聊天列表里没有这个会话。请把它滚动到可见位置，'
                                         '点「重新读取微信」后再添加。')
                    if len(matches) > 1 or (matches[0].get('metadata') or {}).get('ambiguous') == 'true':
                        raise ValueError('微信里有多个同名会话，助手分不清是哪一个。请先给其中一个改名或加备注。')
                    # The visible list cannot tell a group from a one-to-one chat yet, so the
                    # client does not send a kind; default to direct instead of rejecting it.
                    kind = data.get('kind') if data.get('kind') in ('direct', 'group') else 'direct'
                    rule_id = worker.store.add('wechat-main', matches[0]['id'], matches[0]['title'], kind,
                                               data.get('prompt', ''))
                    self.response(201, {'id': rule_id})
                elif self.path in ('/api/enable', '/api/pause'):
                    worker.store.rule(data['id'])
                    worker.store.enable(data['id'], self.path == '/api/enable')
                    self.response(200, {'ok': True})
                elif self.path == '/api/edit':
                    worker.store.rule(data['id'])
                    worker.store.edit(data['id'], data['prompt'])
                    self.response(200, {'ok': True})
                elif self.path == '/api/delete':
                    worker.store.archive(data['id'])
                    self.response(200, {'ok': True})
                elif self.path == '/api/read':
                    # The one operation that opens a chat, so it only ever runs when the
                    # user asks for a specific conversation. Opening clears that chat's
                    # unread badge in WeChat, which is exactly why it is not automatic.
                    provider = data.get('provider') or 'wechat-main'
                    conversation = data.get('conversation_id')
                    if not isinstance(provider, str) or not isinstance(conversation, str) or not conversation:
                        raise ValueError('请指定要读取的会话')
                    limit = data.get('limit')
                    limit = max(5, min(limit, 60)) if isinstance(limit, int) and not isinstance(limit, bool) else 30
                    messages = worker.mcp.observe({'provider': provider, 'conversation': conversation}, limit)
                    self.response(200, {'provider': provider, 'conversation': conversation, 'messages': messages})
                elif self.path == '/api/send':
                    # The Host's trusted manual-send path. origin=user_request is the exact
                    # classification the runtime documents for "the user confirmed this draft",
                    # so in locally enabled user_directed mode it sends straight through.
                    provider = data.get('provider') or 'wechat-main'
                    conversation = data.get('conversation_id')
                    text = data.get('text')
                    request_id = data.get('request_id')
                    if not isinstance(conversation, str) or not conversation.strip():
                        raise ValueError('请确认要发给谁')
                    if not isinstance(text, str) or not text.strip():
                        raise ValueError('正文不能为空')
                    if len(text) > worker.config['max_reply_chars']:
                        raise ValueError('正文太长了，请精简后再发')
                    if not isinstance(request_id, str) or not request_id.strip():
                        request_id = str(uuid.uuid4())
                    try:
                        outcome = worker.mcp.call('send_message', {'provider': provider,
                            'conversation_id': conversation, 'text': text,
                            'request_id': request_id, 'origin': 'user_request'})
                    except RuntimeToolError as error:
                        # The runtime refused the send outright (e.g. the conversation is not
                        # visible); it never reached the UI, so its code is the honest answer.
                        self.response(200, {'status': 'not_sent', 'request_id': request_id,
                                            'code': error.code, 'detail': error.code})
                        return
                    except Exception:
                        # The call may have reached the UI. Querying is safe; resending is not.
                        try:
                            outcome = worker.mcp.call('get_send_status', {'request_id': request_id})
                        except Exception:
                            outcome = {'status': 'uncertain'}
                    self.response(200, {'status': outcome.get('status', 'uncertain'),
                                        'request_id': request_id,
                                        'detail': outcome.get('detail', '')})
                elif self.path == '/api/settings':
                    changed = False
                    if 'auto_restore_window' in data:
                        if not isinstance(data['auto_restore_window'], bool):
                            raise ValueError('Invalid auto_restore_window')
                        worker.store.set_setting('auto_restore_window', data['auto_restore_window'])
                        changed = True
                    if 'auto_model' in data:
                        model = data['auto_model']
                        if not isinstance(model, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}', model):
                            raise ValueError('Invalid auto_model')
                        worker.store.set_setting('auto_model', model)
                        changed = True
                    if 'observe_enabled' in data:
                        if not isinstance(data['observe_enabled'], bool):
                            raise ValueError('Invalid observe_enabled')
                        worker.store.set_setting('observe_enabled', data['observe_enabled'])
                        changed = True
                    if 'dev_diagnostics' in data:
                        if not isinstance(data['dev_diagnostics'], bool):
                            raise ValueError('Invalid dev_diagnostics')
                        worker.store.set_setting('dev_diagnostics', data['dev_diagnostics'])
                        changed = True
                    if not changed:
                        self.response(400, {'error': '设置值不正确'})
                    else:
                        self.response(200, {'settings': current_settings()})
                else:
                    self.response(404, {'error': 'Not found'})
            except RuntimeToolError as error:
                # The runtime's own code is what the product layer maps to a readable
                # sentence, so pass it through instead of flattening it to "操作失败".
                # `detail` carries the runtime's own explanation — without it the code
                # alone ("layout_unverified") says nothing about which sub-check failed.
                self.response(409, {'error': 'Runtime: ' + error.code, 'code': error.code,
                                    'detail': error.detail, 'dev': dev_block(error, 'worker:read')})
            except ValueError as error:
                # These messages are written for the user; surfacing them is the whole point.
                self.response(400, {'error': str(error), 'dev': dev_block(error, 'worker')})
            except (KeyError, TypeError) as error:
                self.response(400, {'error': '请求内容不完整，请刷新页面后重试',
                                    'dev': dev_block(error, 'worker')})
            except Exception as error:
                # The point of the developer view: the generic sentence stays for the user,
                # and the actual exception travels alongside it instead of vanishing.
                self.response(400, {'error': '操作失败：请检查填写的内容是否完整',
                                    'dev': dev_block(error, 'worker')})
    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--check-harness', action='store_true')
    args = parser.parse_args()
    config = load_config(args.config)
    # Reuse the existing supervisor's process-tree ownership for scheduled runs.
    if os.name == 'nt':
        from . import process_owner as supervisor
        supervisor.SUPERVISOR_JOB = supervisor.create_supervisor_job()
        class OwnProcess:
            pid = os.getpid()
        supervisor.supervise_child(OwnProcess())
    if args.check_harness:
        harness = Harness(config)
        import uuid
        job = {'id': 'check-' + str(uuid.uuid4()), 'event_id': 'local-check', 'provider': 'simulation', 'conversation': 'connection-check',
               'context': json.dumps({'messages': [], 'incoming': [{'direction': 'incoming', 'content': '你好'}]})}
        try:
            result = harness.run({'title': '本地测试', 'kind': 'direct', 'prompt': '这只是连接测试，请回复：连接成功。'}, job)
            print(json.dumps({'ok': True, 'decision': result, 'sent_to_wechat': False}, ensure_ascii=False))
        finally:
            harness.close()
        return
    # Hold a process-lifetime lock before recovery; a second launch must not disturb active jobs.
    lock = open(config['database'] + '.worker.lock', 'a+b')
    if os.name == 'nt':
        import msvcrt
        lock.seek(0)
        lock.write(b'0')
        lock.flush()
        lock.seek(0)
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    worker = Worker(config)
    token = Path(config['control_token_file']).read_text().strip()
    if len(token) < 32:
        raise ValueError('Management token must contain at least 32 characters')
    server = ThreadingHTTPServer(('127.0.0.1', config['control_port']), handler(worker, token))
    thread = threading.Thread(target=worker.run, daemon=True)
    thread.start()
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        worker.stop.set()
        server.server_close()
        worker.harness.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        from .service import safe_error
        log = Path(__file__).resolve().parents[2] / '.runtime-data' / 'auto-reply-worker.log'
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open('a', encoding='utf-8') as stream:
            stream.write(time.strftime('%Y-%m-%d %H:%M:%S') + ' ' + safe_error(error) + '\n')
        raise

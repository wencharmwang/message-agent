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
from .service import Worker, RuntimeToolError, is_system_entry, error_trace, names_match, name_key, strip_ocr_noise
from .harness import Harness
from .send_outcome import normalize_send_outcome
from . import wechat_keys
from . import secrets_store
from . import model_providers


def credentials_dir(worker) -> Path:
    """密钥的落脚点（数据目录下的 credentials）。"""
    config = worker.config
    data_dir = Path(config['control_token_file']).parent
    return Path(config.get('credentials_dir') or (data_dir / 'credentials'))


def settings_path(worker) -> Path:
    """引擎的 settings.yaml —— 供应商就写在这里。"""
    home = worker.config.get('harness_home')
    return Path(home or '.harness') / 'settings.yaml'


# 同一时刻只允许一次"读取微信密钥"（会读进程内存）。连点两下只能跑一次。
scan_guard = threading.Lock()


def keys_context(worker):
    """把 Worker 的配置翻成密钥模块需要的路径。

    credentials_dir 是密钥的落脚点（DPAPI 存储）。老配置里没有这个键时，
    退回到"数据目录下的 credentials"，与安装器生成的布局一致。
    """
    config = worker.config
    data_dir = Path(config['control_token_file']).parent
    credentials = credentials_dir(worker)
    src = config.get('watcher_src')
    workspace = config.get('watcher_workspace')
    run_dir = config.get('run_dir')
    return wechat_keys.Context(
        credentials_dir=credentials,
        db_lab_src=Path(src) if isinstance(src, str) and src else None,
        workspace=Path(workspace) if isinstance(workspace, str) and workspace else None,
        run_dir=Path(run_dir) if isinstance(run_dir, str) and run_dir else (data_dir / 'run'),
    )


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
            'auto_reply_paused': worker.auto_reply_paused(),
            'auto_model': worker.store.setting('auto_model', worker.config['model']),
            # 模型和提供方是两件事：本地模型（Ollama 等）挂在别的 provider 下，只记 model
            # 的话后台任务仍会拿官方 provider 去请求（实测就是"设置里选不到本地模型"）。
            'auto_provider': worker.store.setting('auto_provider', 'deepseek-official'),
            # 「整理消息」是**另一个任务**：它要归纳、要判断轻重，和"像人一样回一句话"的
            # 需求不一样，所以单独一份配置。缺省跟自动回复一致（都是官方默认模型）。
            'organize_model': worker.store.setting('organize_model', worker.config['model']),
            'assistant_provider': worker.store.setting('assistant_provider', 'deepseek-official'),
            'assistant_model': worker.store.setting('assistant_model', ''),
            'organize_provider': worker.store.setting('organize_provider', 'deepseek-official'),
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
                                    'agent': '消息助手', 'model': current_settings()['auto_model'], 'started_at': worker.started_at})
            elif self.path == '/api/settings':
                self.response(200, {'settings': current_settings()})
            elif self.path == '/api/conversations':
                try:
                    # 读 DB 会话列表（username + display），不再 OCR 读可见列表。
                    self.response(200, {'conversations': worker.db_sessions()})
                except Exception as error:
                    self.response(503, {'error': '无法读取会话列表，请检查微信和 Runtime',
                                        'dev': dev_block(error, 'worker:conversations')})
            elif self.path == '/api/wechat-keys':
                # 只读状态：有没有可用密钥、上次什么时候读的、明文残留清没清。
                # 永不返回密钥内容。
                self.response(200, {'keys': wechat_keys.status(keys_context(worker))})
            elif self.path == '/api/model-providers':
                # 可选的模型供应商目录 + 哪些已经配过。只读，不含任何密钥。
                self.response(200, {'providers': model_providers.describe(),
                                    'configured': sorted(model_providers.configured_providers(settings_path(worker)))})
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
                if self.path == '/api/wechat-keys/scan':
                    # **用户点过授权**才会走到这里。这是整套流程里唯一会去读微信进程内存的
                    # 入口：日常启动只看 DPAPI 里存好的密钥（launch.py 那条路）。
                    # 加锁：连点两下不该同时跑两次内存扫描。
                    if not scan_guard.acquire(blocking=False):
                        self.response(409, {'error': '正在读取中，请稍等'})
                    else:
                        try:
                            result = wechat_keys.scan(keys_context(worker), force=bool(data.get('force')))
                            self.response(200 if result.get('ok') else 503, result)
                        except Exception as error:
                            self.response(500, {'error': '读取密钥失败',
                                                'dev': dev_block(error, 'worker:wechat-keys/scan')})
                        finally:
                            scan_guard.release()
                elif self.path == '/api/model-provider':
                    # 用户从下拉里选一家供应商、贴上 key（用户要求：不能只支持一家，
                    # 要给选择的机会）。这里做两件事：把 provider 写进引擎配置（只增不删），
                    # 把 key 交给 Windows 密钥保护。生效由 Host 那边设 process.env 完成。
                    provider = model_providers.resolve(str(data.get('provider') or ''))
                    if provider is None:
                        raise ValueError('不认识这个供应商')
                    key = data.get('key')
                    key = key.strip() if isinstance(key, str) else ''
                    base_url = data.get('baseUrl') if isinstance(data.get('baseUrl'), str) else ''
                    model = data.get('model') if isinstance(data.get('model'), str) else ''
                    if provider.id == 'custom' and not base_url.strip():
                        raise ValueError('选「其它」时要填服务地址')
                    if provider.needs_key and not provider.builtin and len(key) < 8:
                        raise ValueError('请把 API key 贴进来（太短了）')

                    message = '引擎内置这家，只需要 key'
                    if not provider.builtin:
                        message = model_providers.apply_provider(
                            settings_path(worker), provider, base_url=base_url.strip(), model=model.strip())

                    if key:
                        store = credentials_dir(worker) / 'model-cloud.dat'
                        store.parent.mkdir(parents=True, exist_ok=True)
                        current = secrets_store.read_secret(store) or {}
                        current[provider.key_env] = key
                        current['saved_by'] = 'ui'
                        secrets_store.write_secret(store, current)

                    # keyEnv 告诉 Host 该设哪个环境变量 —— 只有它能让配置立刻生效
                    self.response(200, {'ok': True, 'provider': provider.id, 'name': provider.name,
                                        'keyEnv': provider.key_env, 'key': key, 'message': message})
                elif self.path == '/api/model-key':
                    # 界面里粘贴的云端 API key。存进 Windows 密钥保护（和安装程序同一个文件），
                    # 磁盘上不留明文。**合并写入**：不能把已经配好的本地模型 key 一起抹掉。
                    key = data.get('key')
                    if not isinstance(key, str) or len(key.strip()) < 12 or any(c.isspace() for c in key.strip()):
                        raise ValueError('这串 key 看起来不对（太短或含空格）')
                    store = Path(worker.config.get('credentials_dir')
                                 or (Path(worker.config['control_token_file']).parent / 'credentials'))
                    store.mkdir(parents=True, exist_ok=True)
                    target = store / 'model-cloud.dat'
                    current = secrets_store.read_secret(target) or {}
                    current['DEEPSEEK_API_KEY'] = key.strip()
                    current['saved_by'] = 'ui'
                    secrets_store.write_secret(target, current)
                    self.response(200, {'ok': True, 'provider': 'deepseek-official'})
                elif self.path == '/api/db_messages':
                    # 读 DB 会话消息（username 定位），供「分析说话方式」等使用，不再 OCR 打开会话。
                    username = data.get('username')
                    if not isinstance(username, str) or not username:
                        raise ValueError('请指定要分析的会话')
                    limit = data.get('limit')
                    # 默认 500：读本地库很便宜，样本大一点分析更准（用户要求「多分析一点」）。
                    limit = max(5, min(limit, 800)) if isinstance(limit, int) and not isinstance(limit, bool) else 500
                    self.response(200, worker.db_messages(username, limit))
                elif self.path == '/api/db_recent':
                    # 首页与消息整理：一次取回最近有动静的若干会话 + 各自最近消息。
                    # 纯 DB 读取，不开微信窗口、不动前台。
                    size = data.get('sessions')
                    size = max(1, min(size, 30)) if isinstance(size, int) and not isinstance(size, bool) else 12
                    per = data.get('per_session')
                    per = max(3, min(per, 80)) if isinstance(per, int) and not isinstance(per, bool) else 20
                    self.response(200, worker.db_recent(sessions=size, per_session=per))
                elif self.path == '/api/search_contacts':
                    # 本地搜索联系人（remark/nick_name/username），无需 OCR 也无需微信前台。
                    self.response(200, {'conversations': worker.db_search_contacts(data.get('keyword'))})
                elif self.path == '/api/rules':
                    # 从 DB 会话列表解析，身份是 username；不再依赖 OCR 可见列表。
                    sessions = worker.db_sessions()
                    matches = [c for c in sessions if c['id'] == data.get('conversation_id')]
                    if not matches:
                        raise ValueError('会话列表里没有这个会话，请刷新后再添加。')
                    # username 原生唯一，无同名歧义；群聊由会话 type 决定，客户端显式给了
                    # kind 就以客户端为准（那是人改过的判断），没给才用 DB 里的类型 ——
                    # 原来没给就一律当直接聊天，群聊会被静默注册成单聊。
                    kind = data.get('kind') if data.get('kind') in ('direct', 'group') else matches[0].get('kind', 'direct')
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
                    background_only = data.get('background_only', False)
                    if not isinstance(background_only, bool):
                        raise ValueError('读取方式不正确')
                    limit = data.get('limit')
                    limit = max(5, min(limit, 60)) if isinstance(limit, int) and not isinstance(limit, bool) else 30
                    # A `wechat:*` id identifies the row selected from the current visible list.
                    # Keep that id all the way into Runtime so the normal non-activating backend
                    # path gets the first chance to read it. Converting the id to OCR text here
                    # used to force a global contact search; one bad character in the OCR label
                    # then made a perfectly readable conversation look as if it did not exist.
                    #
                    # The cleaned label remains a last-resort fallback for older Runtime builds
                    # or a row whose id changed between scans. It is never the primary locator.
                    read_target = conversation
                    fallback_target = None
                    if provider == 'wechat-main' and conversation.startswith('wechat:'):
                        choices = worker.mcp.call('list_conversations', {'provider': provider})['conversations']
                        matches = [c for c in choices if c.get('id') == conversation]
                        # OCR cleanup can improve a visible name between discovery and the click
                        # (for example 树袋熊.. -> 树袋熊), which necessarily changes its
                        # display-name-derived runtime id. The Host supplies the title stored on
                        # the server-side message-centre row; use it only to recover a unique
                        # current visible row, never as an unchecked target.
                        if not matches:
                            stored_title = data.get('conversation_title')
                            if isinstance(stored_title, str) and stored_title.strip():
                                # An exact key match wins: names_match accepts "the shorter name
                                # is a piece of the longer one", so a stored 树袋熊 would also
                                # collect 树袋熊电竞 and turn a good read into 没有唯一匹配的会话.
                                wanted = name_key(stored_title)
                                exact = [c for c in choices if name_key(c.get('title') or '') == wanted]
                                matches = exact or [c for c in choices
                                                    if names_match(stored_title, c.get('title') or '')]
                        if len(matches) != 1:
                            raise ValueError('微信当前显示的聊天列表里没有唯一匹配的会话，请重新整理后再试。')
                        if (matches[0].get('metadata') or {}).get('ambiguous') == 'true':
                            raise ValueError('微信里有多个同名会话，助手分不清是哪一个。请先给其中一个改名或加备注。')
                        read_target = matches[0].get('id') or conversation
                        fallback_target = strip_ocr_noise(matches[0].get('title') or '')
                        if not fallback_target:
                            raise ValueError('这个会话的名称没有读完，请重新整理后再试。')
                    try:
                        messages = worker.mcp.observe(
                            {'provider': provider, 'conversation': read_target}, limit)
                    except RuntimeToolError as error:
                        # Only selection failures justify trying the OCR title. Layout, access,
                        # and message-extraction errors must retain their real diagnostics.
                        selection_failures = {
                            'conversation_not_found', 'conversation_not_visible',
                            'conversation_unavailable', 'conversation_unverified'
                        }
                        if background_only or not fallback_target or error.code not in selection_failures:
                            raise
                        messages = worker.mcp.observe(
                            {'provider': provider, 'conversation': fallback_target}, limit)
                    self.response(200, {'provider': provider, 'conversation': conversation, 'messages': messages})
                elif self.path == '/api/observe/refresh':
                    # A visible-list read is now a user action. It never opens a chat, but
                    # it must not be smuggled back into the worker's five-second loop.
                    worker.discover(force=True)
                    snapshot = worker.observation_snapshot()
                    if not dev_diagnostics():
                        snapshot.pop('error_trace', None)
                    self.response(200, snapshot)
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
                    # 发送前先把微信窗口从托盘/最小化拉回来。
                    # 运行时的 restore_window 说明里写明 "never happens implicitly" ——
                    # 它故意不隐式恢复窗口，得调用方自己做。自动回复那条链路一直是这么干的
                    # （service.py），手工发送漏了这一步，于是微信缩到托盘时就报
                    # provider_unavailable。拉不起来也照样往下走：真正的错误让 send_message 报。
                    try:
                        worker.mcp.call('restore_window', {'provider': provider})
                    except Exception:
                        pass
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
                    outcome = normalize_send_outcome(outcome)
                    self.response(200, {'status': outcome['status'], 'code': outcome['code'],
                                        'request_id': request_id,
                                        'detail': outcome.get('detail', '')})
                elif self.path == '/api/settings':
                    changed = False
                    if 'auto_reply_paused' in data:
                        if not isinstance(data['auto_reply_paused'], bool):
                            raise ValueError('Invalid auto_reply_paused')
                        worker.store.set_setting('auto_reply_paused', data['auto_reply_paused'])
                        changed = True
                    if 'auto_model' in data:
                        model = data['auto_model']
                        if not isinstance(model, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}', model):
                            raise ValueError('Invalid auto_model')
                        worker.store.set_setting('auto_model', model)
                        changed = True
                    if 'auto_provider' in data:
                        provider = data['auto_provider']
                        if not isinstance(provider, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,99}', provider):
                            raise ValueError('Invalid auto_provider')
                        worker.store.set_setting('auto_provider', provider)
                        changed = True
                    if 'organize_model' in data:
                        model = data['organize_model']
                        if not isinstance(model, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}', model):
                            raise ValueError('Invalid organize_model')
                        worker.store.set_setting('organize_model', model)
                    if 'assistant_provider' in data:
                        provider = data['assistant_provider']
                        if not isinstance(provider, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,99}', provider):
                            raise ValueError('Invalid assistant_provider')
                        worker.store.set_setting('assistant_provider', provider)
                    if 'assistant_model' in data:
                        model = data['assistant_model']
                        if not isinstance(model, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}', model):
                            raise ValueError('Invalid assistant_model')
                        worker.store.set_setting('assistant_model', model)
                        changed = True
                    if 'organize_provider' in data:
                        provider = data['organize_provider']
                        if not isinstance(provider, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,99}', provider):
                            raise ValueError('Invalid organize_provider')
                        worker.store.set_setting('organize_provider', provider)
                        changed = True
                    if 'observe_enabled' in data:
                        if not isinstance(data['observe_enabled'], bool):
                            raise ValueError('Invalid observe_enabled')
                        # Kept as a compatible no-op for older clients. Inbox observation
                        # is manual; automatic-reply scanning is controlled by rule enablement.
                        worker.store.set_setting('observe_enabled', False)
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

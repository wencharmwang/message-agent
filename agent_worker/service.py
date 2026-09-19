"""Observe authorized conversations and dispatch durable jobs through a single worker.

数据源（2026-09-19 起）：微信本地数据库（wechat-db-lab），不再用 OCR 打开会话读气泡。
- 读走 DB：身份是原生 username(wxid)、正文明文、零 UI 干扰 —— 识别不准/乱切换/抢焦点
  三个问题在读路径上消失。
- 发走 UI：个人微信无官方 API，发送仍走 messaging-runtime 的 OCR 后台点行+后台发送。
- 决策复用 harness：规则/状态机/DeepSeek 决策不变。
"""
import json
from pathlib import Path
import threading
import time
import traceback
import unicodedata
import urllib.request
import re
import difflib
from .database import Store
from .harness import Harness


class RuntimeToolError(RuntimeError):
    """A tool call the runtime refused, carrying the runtime's own failure code."""

    def __init__(self, code, message=None, detail=''):
        super().__init__(message or ('Runtime: ' + code))
        self.code = code
        self.detail = detail or ''


class Mcp:
    """Minimal runtime client. Only sending and status-query remain on the OCR path."""

    def __init__(self, settings_file, token_file):
        settings = json.loads(Path(settings_file).read_text(encoding='utf-8-sig'))
        self.url = f"http://127.0.0.1:{settings['port']}/mcp"
        self.token = Path(token_file).read_text().strip()
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(self, name, arguments):
        body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                           'params': {'name': name, 'arguments': arguments}}, ensure_ascii=False).encode('utf-8')
        request = urllib.request.Request(self.url, body, headers={'Authorization': 'Bearer ' + self.token,
                        'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'})
        with self.opener.open(request, timeout=90) as response:
            envelope = json.load(response)
        if 'error' in envelope:
            raise RuntimeError('MCP protocol error')
        result = envelope['result']
        data = json.loads(result['content'][0]['text'])
        if result.get('isError'):
            raise RuntimeToolError(data.get('code', 'tool_failed'),
                                   'Runtime: ' + data.get('code', 'tool_failed'),
                                   data.get('error', ''))
        return data

    def observe(self, rule, limit=30):
        """手动读消息（用户点名路径，仍走 OCR）—— 仅整理器/消息中心使用，自动回复不用。"""
        page = self.call('observe_latest', {'provider': rule['provider'], 'conversation_id': rule['conversation'], 'limit': limit})
        return canonical_messages(page['messages'])


# ---------------------------------------------------------------------------
# 以下 name_key / strip_ocr_noise / names_match / is_system_entry 等函数仍保留，
# 仅服务 __main__.py 里"创建规则 / 手动读列表"的用户点名 OCR 路径；自动回复循环
# 不再使用它们（读走 DB，身份是 username，无需 OCR 名字匹配）。
# ---------------------------------------------------------------------------

TIMESTAMP_NOISE = re.compile(r'^(?:(?:星期[一二三四五六日天]|\d{1,2}月\d{1,2}日|\d{4}年\d{1,2}月\d{1,2}日|\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}|昨天|前天|今天)\s*(?:\d{1,2}:\d{2})?|\d{1,2}:\d{2})$')


def name_key(text):
    return ''.join(ch for ch in str(text or '') if ch.isalnum()).lower()


SYSTEM_ENTRY_NAMES = frozenset({
    name_key('公众号'), name_key('服务号'), name_key('微信支付'), name_key('订阅号'),
    name_key('文件传输助手'), name_key('服务通知'), name_key('腾讯新闻'), name_key('微信团队'),
    name_key('企业微信'), name_key('视频号'), name_key('群发助手')
})


def is_system_entry(name):
    return name_key(name) in SYSTEM_ENTRY_NAMES


def strip_ocr_noise(name):
    text = str(name or '').strip()
    if not text:
        return ''
    text = text.rstrip('。')
    stem = text.rstrip('.．·…').rstrip()
    if stem and stem != text and len(name_key(stem)) <= 8:
        text = stem
    return text.rstrip('?？\ufffd\u25a1').strip() or str(name or '').strip()


def one_character_added(left, right):
    if len(left) < 3 or len(right) < 3 or abs(len(left) - len(right)) != 1:
        return False
    shorter, longer = (left, right) if len(left) < len(right) else (right, left)
    i = j = 0
    skipped = False
    while i < len(shorter) and j < len(longer):
        if shorter[i] == longer[j]:
            i, j = i + 1, j + 1
        elif skipped:
            return False
        else:
            skipped, j = True, j + 1
    return True


def names_match(stored, current):
    left, right = name_key(stored), name_key(current)
    if not left or not right:
        return False
    if left == right:
        return True
    shorter, longer = (left, right) if len(left) <= len(right) else (right, left)
    if len(shorter) >= 3 and shorter in longer:
        return True
    return one_character_added(left, right)


def without_ui_noise(messages):
    return [m for m in messages if not TIMESTAMP_NOISE.fullmatch(m['content'].strip())]


def canonical_messages(messages):
    result = []
    for m in messages:
        if m.get('direction') not in ('incoming', 'outgoing') or not isinstance(m.get('content'), str):
            raise ValueError('Message direction or content is unknown')
        result.append({'direction': m['direction'], 'content': unicodedata.normalize('NFC', m['content']).strip(),
                       'sender': m.get('sender'), 'type': m.get('type', 'unknown')})
    return without_ui_noise(result)


def latest_incoming_text(messages):
    if not messages:
        return []
    latest = messages[-1]
    if (latest.get('direction') != 'incoming' or latest.get('type') != 'text'
            or not isinstance(latest.get('content'), str) or not latest['content'].strip()):
        return []
    return [latest]


def new_messages(previous, current):
    """Align an unambiguous exact tail. An OCR edit is uncertainty, not a new event."""
    previous, current = without_ui_noise(previous), without_ui_noise(current)
    if current == previous:
        return []
    if not previous:
        return current
    if not current:
        raise ValueError('Conversation became empty; cannot establish continuity')
    minimum = min(2, len(previous))
    for length in range(min(len(previous), len(current)), minimum - 1, -1):
        tail = previous[-length:]
        matches = [i for i in range(len(current) - length + 1) if current[i:i+length] == tail]
        if len(matches) > 1:
            raise ValueError('Repeated messages make the snapshot alignment ambiguous')
        if len(matches) == 1:
            return current[matches[0] + length:]
    matcher = difflib.SequenceMatcher(None,
        [(m['direction'],m['content']) for m in previous],
        [(m['direction'],m['content']) for m in current], autojunk=False)
    old_keys = [(m['direction'],m['content']) for m in previous]
    new_keys = [(m['direction'],m['content']) for m in current]
    def reliable_block(block):
        if block.size >= minimum:
            return True
        if block.size != 1:
            return False
        key = old_keys[block.a]
        return key[0] == 'incoming' and old_keys.count(key) == 1 and new_keys.count(key) == 1
    blocks = [b for b in matcher.get_matching_blocks() if reliable_block(b)]
    if blocks:
        anchor = blocks[-1]
        old_tail, new_tail = previous[anchor.a+anchor.size:], current[anchor.b+anchor.size:]
        if old_tail and all(m['direction']=='outgoing' for m in old_tail):
            split = 0
            while split < len(new_tail) and new_tail[split]['direction']=='outgoing': split += 1
            rewritten, appended = new_tail[:split], new_tail[split:]
            if rewritten and all(m['direction']=='incoming' for m in appended):
                expected = ''.join(m['content'] for m in old_tail)
                observed = ''.join(m['content'] for m in rewritten)
                similarity = difflib.SequenceMatcher(None, expected, observed).ratio()
                if similarity >= .75:
                    return appended
    old_incoming = [(i, (m['direction'], m['content'])) for i, m in enumerate(previous)
                    if m['direction'] == 'incoming']
    new_incoming = [(i, (m['direction'], m['content'])) for i, m in enumerate(current)
                    if m['direction'] == 'incoming']
    for length in range(min(len(old_incoming), len(new_incoming)), 1, -1):
        tail = [key for _, key in old_incoming[-length:]]
        matches = [i for i in range(len(new_incoming) - length + 1)
                   if [key for _, key in new_incoming[i:i + length]] == tail]
        if len(matches) != 1:
            continue
        old_anchor = old_incoming[-1][0]
        new_anchor = new_incoming[matches[0] + length - 1][0]
        old_tail = previous[old_anchor + 1:]
        new_tail = current[new_anchor + 1:]
        split = 0
        while split < len(new_tail) and new_tail[split]['direction'] == 'outgoing':
            split += 1
        rewritten, appended = new_tail[:split], new_tail[split:]
        if (old_tail and all(m['direction'] == 'outgoing' for m in old_tail)
                and len(rewritten) == len(old_tail)
                and appended and all(m['direction'] == 'incoming' for m in appended)):
            return appended
    raise ValueError('OCR changed or history shifted without sufficient context')


HISTORY_LIMIT = 60  # 每个会话在内存里保留的上下文条数


class Worker:
    def __init__(self, config, mcp=None, harness=None):
        self.config = config
        self.store = Store(config['database'])
        self.mcp = mcp or Mcp(config['runtime_settings_file'], config['worker_token_file'])
        self.harness = harness or Harness(config)
        self.stop = threading.Event()
        self.last_error = ''
        self.started_at = time.time()
        self.watcher = None          # WatcherSource，懒加载
        self._watcher_lock = threading.Lock()
        self._history = {}           # username -> [canonical message]
        self._history_seq = {}       # username -> 最新 incoming 的 sort_seq（int）
        self._observation = {'scanned_at': 0.0, 'providers': {}}  # 整理器手动发现缓存
        self._observation_error = ''
        self.store.recover()

    # ---- 整理器/消息中心的手动发现（用户点名，仍走 OCR；自动回复不用） ----
    def observe_enabled(self):
        return False

    def observation_snapshot(self):
        return {'scanned_at': self._observation.get('scanned_at', 0.0),
                'providers': self._observation.get('providers', {}),
                'error': self._observation_error,
                'level': 'manual'}

    def discover(self, force=False):
        if not force:
            return self._observation.get('providers', {})
        try:
            page = self.mcp.call('list_conversations', {'provider': 'wechat-main'})
            self._observation = {'scanned_at': time.time(), 'providers': {
                'wechat-main': {c.get('id'): c for c in page.get('conversations', []) if c.get('id')}}}
            self._observation_error = ''
        except Exception as error:
            self._observation_error = safe_error(error)
        return self._observation.get('providers', {})

    def db_sessions(self, limit=500):
        """读 DB 会话列表（id=username, title=display），供创建规则/消息中心使用。

        直接读 watcher 子进程解锁出的明文 session.db + contact.db（标准 sqlite3，
        无需 cryptography），身份是原生 username —— 创建规则与监听用同一把钥匙。
        """
        import sqlite3
        watcher = self._watcher()
        if not watcher.ready(timeout=30):
            return []
        workspace = watcher.workspace()
        if not workspace:
            return []
        plain = Path(workspace) / 'plain'
        display = {}
        contact_db = plain / 'contact' / 'contact.db'
        if contact_db.exists():
            try:
                conn = sqlite3.connect(f'file:{contact_db.as_posix()}?mode=ro&immutable=1', uri=True)
                try:
                    for row in conn.execute('SELECT username, remark, nick_name FROM contact'):
                        if row[0]:
                            display[row[0]] = row[1] or row[2] or row[0]
                finally:
                    conn.close()
            except sqlite3.Error:
                pass
        sessions = []
        session_db = plain / 'session' / 'session.db'
        if session_db.exists():
            try:
                conn = sqlite3.connect(f'file:{session_db.as_posix()}?mode=ro&immutable=1', uri=True)
                try:
                    rows = conn.execute(
                        'SELECT username FROM SessionTable WHERE is_hidden=0 '
                        'ORDER BY sort_timestamp DESC LIMIT ?', (limit,)).fetchall()
                    for row in rows:
                        username = row[0]
                        title = display.get(username, username)
                        if not username or is_system_entry(title) or is_system_entry(username):
                            continue
                        sessions.append({'id': username, 'title': title})
                finally:
                    conn.close()
            except sqlite3.Error:
                pass
        return sessions

    # ---- watcher 子进程 ----
    def _watcher(self):
        # 自愈 + 线程安全：watcher 子进程崩溃后（进程退出），下次 tick 重新拉起；
        # 加锁防止 tick 线程与 HTTP 请求线程（db_sessions）并发 spawn 出两个 watcher
        # （subprocess.Popen 会释放 GIL，不加锁会竞态重复实例化）。
        with self._watcher_lock:
            if self.watcher is not None and not self.watcher.alive():
                self.watcher.close()
                self.watcher = None
            if self.watcher is None:
                from .watcher_source import WatcherSource
                self.watcher = WatcherSource(
                    self.config['watcher_python'],
                    self.config['watcher_src'],
                    workspace=self.config.get('watcher_workspace'),
                    account=self.config.get('watcher_account'),
                    interval=self.config.get('watcher_interval_seconds', 3.0),
                    overlap=self.config.get('watcher_overlap_seconds', 10),
                )
            return self.watcher

    def close(self):
        if self.watcher is not None:
            self.watcher.close()
            self.watcher = None

    # ---- 事件 → 历史 ----
    @staticmethod
    def _canonical(event):
        local_type = event.get('local_type')
        return {
            'direction': event.get('direction'),
            'content': event.get('text') or '',
            'sender': event.get('sender'),
            'type': 'text' if local_type == 1 else (event.get('type') or 'unknown'),
        }

    def _ingest(self, event):
        """把一条事件记入内存历史；返回 (是否触发回复, canonical 消息)。"""
        username = event.get('username') or ''
        message = self._canonical(event)
        history = self._history.setdefault(username, [])
        history.append(message)
        if len(history) > HISTORY_LIMIT:
            del history[:-HISTORY_LIMIT]
        seq = event.get('sort_seq')
        if event.get('direction') == 'incoming' and seq is not None:
            try:
                seq_int = int(seq)
            except (TypeError, ValueError):
                seq_int = 0
            if seq_int > self._history_seq.get(username, 0):
                self._history_seq[username] = seq_int
        should_reply = (event.get('direction') == 'incoming'
                        and event.get('local_type') == 1
                        and bool(event.get('text')))
        return should_reply, message

    def _rules_by_username(self):
        out = {}
        for rule in self.store.rules():
            if rule['enabled'] and rule['status'] != 'blocked':
                out.setdefault(rule['conversation'], []).append(rule)
        return out

    def _handle_event(self, event, rules_by_username):
        should_reply, message = self._ingest(event)
        if not should_reply:
            return
        username = event.get('username') or ''
        for rule in rules_by_username.get(username, []):
            if rule['status'] in ('queued', 'generating', 'ready', 'sending'):
                continue
            history = self._history.get(username, [])
            incoming = [message]
            fingerprint = str(event.get('sort_seq') or event.get('local_id') or '')
            self.store.enqueue(rule, history, incoming, self.config['job_ttl_seconds'], fingerprint)

    def check_rule(self, rule):
        current = self.store.rule(rule['id'])
        return current['enabled'] and current['revision'] == rule['revision'] and current['status'] != 'blocked'

    def process(self, job):
        rule = self.store.rule(job['rule_id'])
        if not self.check_rule(rule) or rule['revision'] != job['rule_revision']:
            self.store.finish(job, 'cancelled', 'Rule disabled or changed')
            return
        if job['expires_at'] <= time.time():
            self.store.finish(job, 'expired', 'Reply task expired')
            return
        if time.time() - rule['last_sent'] < self.config['min_reply_interval_seconds']:
            return
        if not self.store.transition(job['id'], 'queued', 'generating'):
            return
        self.store.status(rule['id'], rule['revision'], 'generating', 'DeepSeek Harness 正在处理新消息')
        try:
            try:
                decision = self.harness.run(rule, job)
            finally:
                self.harness.close()
            if not self.check_rule(rule):
                self.store.finish(job, 'cancelled', 'Rule changed during generation')
                return
            if decision['action'] != 'reply':
                reason = decision.get('reason', '')
                self.store.transition(job['id'], 'generating', 'generating', decision=json.dumps(decision, ensure_ascii=False))
                self.store.finish(job, decision['action'], reason)
                self.store.status(rule['id'], rule['revision'], 'listening',
                                  ('本条需人工处理：' + (reason or '请查看任务')) if decision['action'] == 'needs_user' else '')
                return
            # pre-send 复查：生成期间该会话是否又来了更新的 incoming。
            # DB 方案下 sort_seq 是毫秒时间戳、全局单调，比较它即可判断"又有新消息"，
            # 不需要像 OCR 那样重新打开会话读气泡。依赖事件流的实时性：watcher 子进程
            # 独立轮询，滞后一个轮询周期（秒级），对自动回复足够。
            stored = json.loads(job['context'])
            trigger_seq = stored.get('fingerprint') or ''
            try:
                trigger_int = int(trigger_seq)
            except (TypeError, ValueError):
                trigger_int = 0
            if trigger_int and self._history_seq.get(job['conversation'], 0) > trigger_int:
                self.store.finish(job, 'superseded', 'Conversation changed while Agent was responding')
                self.store.status(rule['id'], rule['revision'], 'listening', '生成期间会话又有变化，等待下一条新消息')
                return
            if not self.store.transition(job['id'], 'generating', 'ready', text=decision['text'], decision=json.dumps(decision, ensure_ascii=False)):
                return
            if not self.store.claim_send(job):
                self.store.finish(job, 'cancelled', 'Rule changed or task expired before submission')
                return
            self.store.status(rule['id'], rule['revision'], 'sending', '正在后台发送并验证')
            # 发送定位用 display（rule.title = remark/nick_name），不是 username：
            # runtime 对非 wechat: 前缀的 id 走"可见列表行点击 + 全局搜索兜底"，
            # 而微信里显示的是备注，不是 wxid。
            try:
                outcome = self.mcp.call('send_message', {'provider': job['provider'],
                         'conversation_id': rule['title'], 'text': decision['text'],
                         'request_id': job['request_id'], 'origin': 'agent_proposed'})
            except Exception:
                try:
                    outcome = self.mcp.call('get_send_status', {'request_id': job['request_id']})
                except Exception:
                    outcome = {'status': 'uncertain'}
            state = outcome.get('status', 'uncertain')
            if state != 'sent':
                self.store.finish(job, state, 'Sending stopped; inspect Runtime receipt before retrying')
                self.store.status(rule['id'], rule['revision'], 'listening',
                                  '上一条回复没有确认发出；不会自动重发，已继续监听新消息')
                return
            self.store.finish(job, 'sent', 'UI submission verified; recipient delivery not verified')
            own = {'direction': 'outgoing', 'content': unicodedata.normalize('NFC', decision['text']).strip(), 'sender': None, 'type': 'text'}
            history = self._history.setdefault(job['conversation'], [])
            history.append(own)
            if len(history) > HISTORY_LIMIT:
                del history[:-HISTORY_LIMIT]
            self.store.replace_baseline(rule, history)
            self.store.status(rule['id'], rule['revision'], 'listening', '已提交回复，继续监听')
        except Exception as error:
            self.harness.close()
            current = self.store.job(job['id'])
            if current['state'] not in ('cancelled', 'sent'):
                detail = safe_error(error)
                if current['state'] in ('generating', 'queued'):
                    self.store.finish(job, 'failed', detail)
                    self.store.status(rule['id'], rule['revision'], 'listening',
                                      '本条处理失败：' + detail + '；已继续监听新消息')
                else:
                    self.store.finish(job, 'uncertain', detail)
                    self.store.status(rule['id'], rule['revision'], 'listening',
                                      '上一条回复的结果无法确认；不会自动重发，已继续监听新消息')

    def auto_reply_paused(self):
        """用户在网页上暂停了自动回复时返回 True。"""
        return self.store.setting('auto_reply_paused', '0') == '1'

    def tick(self):
        # 暂停时完全跳过事件处理与 job 生成：既不读新消息、也不生成/发送回复。
        if self.auto_reply_paused():
            return
        rules_by_username = self._rules_by_username()
        try:
            events = self._watcher().poll()
        except Exception as error:
            self.last_error = safe_error(error)
            events = []
        for event in events:
            if self.stop.is_set():
                return
            self._handle_event(event, rules_by_username)
        for job in self.store.pending():
            if self.stop.is_set():
                return
            self.process(job)

    def run(self):
        try:
            while not self.stop.is_set():
                try:
                    self.tick()
                    self.last_error = ''
                except Exception as error:
                    self.last_error = safe_error(error)
                self.stop.wait(self.config['poll_interval_seconds'])
        finally:
            self.harness.close()
            self.close()


def safe_error(error):
    if isinstance(error, (ValueError, RuntimeError, TimeoutError)):
        message = str(error)
        if 'sk-' not in message and len(message) <= 300:
            return message
    return type(error).__name__ + ': 操作失败，请检查连接、配置或执行日志'


def error_trace(error, limit=8):
    if error is None:
        return ''
    text = ''.join(traceback.format_exception(type(error), error, error.__traceback__))
    text = '\n'.join(line.rstrip() for line in text.strip().splitlines()[-limit:])
    if 'sk-' in text:
        return '(含疑似凭据，已省略调用栈)'
    return text[:4000]

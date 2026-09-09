"""Observe authorized conversations and dispatch durable jobs through a single worker."""
import json
from pathlib import Path
import threading
import time
import unicodedata
import urllib.request
import re
import difflib
from .database import Store
from .harness import Harness


class Mcp:
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
            raise RuntimeError('Runtime: ' + data.get('code', 'tool_failed'))
        return data

    def observe(self, rule):
        page = self.call('observe_latest', {'provider': rule['provider'], 'conversation_id': rule['conversation'], 'limit': 30})
        return canonical_messages(page['messages'])

    def scan(self, provider):
        page = self.call('list_conversations', {'provider': provider})
        # This is a single read of the visible conversation list. It must not
        # open any chat; observe_latest below is the only operation that does.
        return {item['id']: (item.get('metadata') or {}).get('activity_fingerprint', '')
                for item in page['conversations']}


TIMESTAMP_NOISE = re.compile(r'^(?:(?:星期[一二三四五六日天]|\d{1,2}月\d{1,2}日|\d{4}年\d{1,2}月\d{1,2}日|\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}|昨天|前天|今天)\s*(?:\d{1,2}:\d{2})?|\d{1,2}:\d{2})$')


def without_ui_noise(messages):
    return [m for m in messages if not TIMESTAMP_NOISE.fullmatch(m['content'].strip())]


def canonical_messages(messages):
    result = []
    for m in messages:
        if m.get('direction') not in ('incoming', 'outgoing') or not isinstance(m.get('content'), str):
            raise ValueError('Message direction or content is unknown')
        # Observation IDs/timestamps vary between OCR snapshots and cannot identify events.
        result.append({'direction': m['direction'], 'content': unicodedata.normalize('NFC', m['content']).strip(),
                       'sender': m.get('sender'), 'type': m.get('type', 'unknown')})
    return without_ui_noise(result)


def latest_incoming_text(messages):
    """Return exactly one reply trigger, only when the real latest bubble is received text."""
    if not messages:
        return []
    latest = messages[-1]
    if (latest.get('direction') != 'incoming' or latest.get('type') != 'text'
            or not isinstance(latest.get('content'), str) or not latest['content'].strip()):
        return []
    return [latest]


def new_messages(previous, current):
    """Align an unambiguous exact tail. An OCR edit is uncertainty, not a new event."""
    # Older persisted baselines may predate the latest-observation noise filter.
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
    # The latest outgoing bubble can be split into several OCR fragments after
    # the window is redrawn. Anchor on an earlier exact run, then verify that the
    # unmatched outgoing prefix is still the same sent text before ignoring it.
    matcher = difflib.SequenceMatcher(None,
        [(m['direction'],m['content']) for m in previous],
        [(m['direction'],m['content']) for m in current], autojunk=False)
    old_keys = [(m['direction'],m['content']) for m in previous]
    new_keys = [(m['direction'],m['content']) for m in current]
    def reliable_block(block):
        if block.size >= minimum:
            return True
        # Long replies are often rewritten by OCR while the surrounding incoming
        # bubbles remain exact. One unique incoming bubble is a safe anchor for
        # checking whether the outgoing tail is merely a visual rewrite.
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
    # When several outgoing bubbles are redrawn at once, their text may provide no
    # useful anchor. Align the exact sequence of received messages instead. Require
    # at least two exact incoming anchors in the same order and the same count of
    # intervening outgoing bubbles before accepting only the trailing incoming data.
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


class Worker:
    def __init__(self, config, mcp=None, harness=None):
        self.config = config
        self.store = Store(config['database'])
        self.mcp = mcp or Mcp(config['runtime_settings_file'], config['worker_token_file'])
        self.harness = harness or Harness(config)
        self.stop = threading.Event()
        self.last_error = ''
        self.started_at = time.time()
        self.store.recover()

    def check_rule(self, rule):
        current = self.store.rule(rule['id'])
        return current['enabled'] and current['revision'] == rule['revision'] and current['status'] not in ('blocked', 'needs_user')

    def settle_delay(self, rule):
        """Inspect the first list change after our send immediately.

        That change is usually WeChat repainting the preview with our outgoing
        text, but it may already include a fast incoming reply. Reading the chat
        tail distinguishes those cases without blindly consuming either event.
        """
        age = time.time() - rule['last_sent']
        fast_path_window = max(15, self.config['poll_interval_seconds'] * 3)
        return 0 if 0 <= age <= fast_path_window else self.config['settle_seconds']

    def poll(self, rule):
        messages = self.mcp.observe(rule)
        if not messages:
            self.store.status(rule['id'], rule['revision'], 'listening', '')
            return True
        # The visible-list preview/time fingerprint is the event trigger. The
        # opened chat is used only to read the real latest bubble and its direction.
        incoming = latest_incoming_text(messages)
        if not incoming:
            self.store.replace_baseline(rule, messages)
            self.store.status(rule['id'], rule['revision'], 'listening', '')
            return True
        self.store.enqueue(rule, messages, incoming, self.config['job_ttl_seconds'])
        return True

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
                # A single message requiring a personal decision must not disable
                # unattended handling of later independent messages from this contact.
                self.store.status(rule['id'], rule['revision'], 'listening',
                                  ('本条需人工处理：' + (reason or '请查看任务')) if decision['action'] == 'needs_user' else '')
                return
            # Reobserve before creating outbox: do not send a response to stale conversation state.
            observed = self.mcp.observe(rule)
            before = json.loads(job['context'])['messages']
            if not observed or not before or observed[-1] != before[-1]:
                self.store.finish(job, 'superseded', 'Conversation changed while Agent was responding')
                self.store.status(rule['id'], rule['revision'], 'listening', '生成期间会话又有变化，等待聊天列表下一次扫描')
                return
            if not self.store.transition(job['id'], 'generating', 'ready', text=decision['text'], decision=json.dumps(decision, ensure_ascii=False)):
                return
            if not self.store.claim_send(job):
                self.store.finish(job, 'cancelled', 'Rule changed or task expired before submission')
                return
            self.store.status(rule['id'], rule['revision'], 'sending', '正在后台发送并验证')
            try:
                outcome = self.mcp.call('send_message', {'provider': job['provider'], 'conversation_id': job['conversation'],
                         'text': decision['text'], 'request_id': job['request_id'], 'origin': 'agent_proposed'})
            except Exception:
                # The call may have reached the UI. Querying status is safe; resending is not.
                try:
                    outcome = self.mcp.call('get_send_status', {'request_id': job['request_id']})
                except Exception:
                    outcome = {'status': 'uncertain'}
            state = outcome.get('status', 'uncertain')
            if state != 'sent':
                self.store.finish(job, state, 'Sending stopped; inspect Runtime receipt before retrying')
                self.store.status(rule['id'], rule['revision'], 'blocked', '发送未确认：' + state + '；不会自动重发')
                return
            self.store.finish(job, 'sent', 'UI submission verified; recipient delivery not verified')
            # Exact expected append preserves any later incoming messages for the next observation.
            own = {'direction': 'outgoing', 'content': unicodedata.normalize('NFC', decision['text']).strip(), 'sender': None, 'type': 'text'}
            self.store.replace_baseline(rule, observed + [own])
            self.store.status(rule['id'], rule['revision'], 'listening', '已提交回复，继续监听')
        except Exception as error:
            self.harness.close()
            current = self.store.job(job['id'])
            if current['state'] not in ('cancelled', 'sent'):
                detail = safe_error(error)
                if current['state'] in ('generating', 'queued'):
                    # Nothing reached the sending boundary. Record this message as
                    # failed, but keep the contact live for future independent input.
                    self.store.finish(job, 'failed', detail)
                    self.store.status(rule['id'], rule['revision'], 'listening',
                                      '本条处理失败：' + detail + '；已继续监听新消息')
                else:
                    # Once ready/sending was reached, preserve the conservative
                    # stop: external submission may be ambiguous.
                    self.store.finish(job, 'needs_user', detail)
                    self.store.status(rule['id'], rule['revision'], 'blocked', detail)

    def tick(self):
        rules = [rule for rule in self.store.rules()
                 if rule['enabled'] and rule['status'] not in ('blocked', 'needs_user')]
        scans = {}
        for provider in dict.fromkeys(rule['provider'] for rule in rules):
            try:
                scans[provider] = self.mcp.scan(provider)
            except Exception as error:
                for rule in rules:
                    if rule['provider'] == provider:
                        self.store.status(rule['id'], rule['revision'], 'waiting_connection',
                                          '微信窗口暂不可捕获，系统每5秒自动重试；请保持微信主窗口可见。' + safe_error(error))
        for rule in rules:
            if self.stop.is_set():
                return
            if rule['provider'] not in scans:
                continue
            fingerprint = scans[rule['provider']].get(rule['conversation'])
            if fingerprint is None:
                self.store.status(rule['id'], rule['revision'], 'waiting_visible', '当前微信可见会话列表中未找到；第一版不会翻页或搜索')
                continue
            if rule['status'] in ('queued', 'generating', 'ready', 'sending'):
                continue
            try:
                activity = self.store.activity(rule, fingerprint, self.settle_delay(rule))
                if activity == 'settling':
                    self.store.status(rule['id'], rule['revision'], 'settling', '发现可见会话摘要变化，等待稳定')
                elif activity == 'changed':
                    if self.poll(rule):
                        self.store.commit_activity(rule, fingerprint)
                elif activity == 'initialized':
                    self.store.status(rule['id'], rule['revision'], 'listening', '')
                else:
                    self.store.status(rule['id'], rule['revision'], 'listening', '')
            except ValueError as error:
                self.store.status(rule['id'], rule['revision'], 'resyncing', safe_error(error))
            except KeyError as error:
                self.store.status(rule['id'], rule['revision'], 'blocked', safe_error(error))
            except Exception as error:
                self.store.status(rule['id'], rule['revision'], 'waiting_connection',
                                  '微信窗口暂不可捕获，系统每5秒自动重试；请保持微信主窗口可见。' + safe_error(error))
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


def safe_error(error):
    if isinstance(error, (ValueError, RuntimeError, TimeoutError)):
        # Do not expose arbitrary wire bodies, API credentials, or model output in status.
        message = str(error)
        if 'sk-' not in message and len(message) <= 300:
            return message
    return type(error).__name__ + ': 操作失败，请检查连接、配置或执行日志'

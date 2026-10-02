"""Observe authorized conversations and dispatch durable jobs through a single worker.

数据源（2026-09-19 起）：微信本地数据库（wechat-db-lab），不再用 OCR 打开会话读气泡。
- 读走 DB：身份是原生 username(wxid)、正文明文、零 UI 干扰 —— 识别不准/乱切换/抢焦点
  三个问题在读路径上消失。
- 发走 UI：个人微信无官方 API，发送仍走 messaging-runtime 的 OCR 后台点行+后台发送。
- 决策复用 harness：规则/状态机/DeepSeek 决策不变。
"""
import base64
import json
from pathlib import Path
import threading
import time
import traceback
import unicodedata
import urllib.request
import queue
import re
import difflib
from .database import Store
from .harness import Harness
from .send_outcome import normalize_send_outcome
from . import voice


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


def session_kind(username):
    """这个会话是群聊还是单聊。

    微信的 username 编码了这个事实：群聊一律以 `@chatroom` 结尾。它就在本地会话表里，
    所以"是不是群"不用再问用户一遍（客户端原来摆一个「这是一个群聊」勾选框，是在问
    数据已经回答的问题）。真遇到不符合约定的情况，客户端仍可显式指定 kind 覆盖。
    """
    return 'group' if str(username or '').endswith('@chatroom') else 'direct'


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


# 真 XML 元素的起点。`<3 爱你` 这种聊天里的表情不算。
_MARKUP_RE = re.compile(r'^<[?!/]?[A-Za-z_][\w.:-]*[\s/>]')
# 群消息的正形是「发送者:」+ 换行 + XML，markup 不在行首。前缀是一段不含换行和冒号的短 token。
_PREFIXED_MARKUP_RE = re.compile(r'^[^\n<:]{1,90}:[ \t\n]*<[?!/]?[A-Za-z_][\w.:-]*[\s/>]')


def looks_like_markup(text):
    """正文是不是一段 XML/blob 卡片，而不是人话。

    图片/视频/位置这些消息的 ``message_content`` 是一整段**可打印 XML**
    （``<?xml version="1.0"?><msg><img hdlength="…"/></msg>``）。它 UTF-8 解码必然成功，
    所以"解出来非空就当正文"的判断会把整段卡片交给界面和模型 —— 界面显示一堆 XML，
    模型只能从 ``hdlength`` 反推"这是张照片"，还白白吃掉上下文预算。

    也要认「发送者:\\n<XML>」这种带前缀的形态 —— 群里每条消息都长这样，只看行首会全漏。
    """
    head = (text or '').lstrip()[:400]
    return bool(_MARKUP_RE.match(head) or _PREFIXED_MARKUP_RE.match(head))


def looks_like_noise(text):
    """是不是二进制残渣，而不是人话。

    有些 ``message_content`` 解出来是一串控制字符 —— ``b"\\x00\\x01\\x02\\x03"`` 恰好是
    合法 UTF-8，所以"解码成功"并不代表可读。判定门槛与 wechat-db-lab 的
    ``_looks_like_text`` 保持一致：可打印占比 < 0.7，或控制/未分配类占比 > 0.1。
    """
    if not text:
        return False
    printable = 0
    bad = 0
    for char in text:
        if char in '\n\r\t':
            printable += 1
        elif unicodedata.category(char) in ('Cc', 'Co', 'Cs', 'Cn'):
            bad += 1
        else:
            printable += 1
    return printable / len(text) < 0.7 or bad / len(text) > 0.1


def display_body(text, label):
    """界面与模型看到的正文。

    文本原样返回（``label`` 为 ``None``/``'text'``）。非文本消息的正文要么是 XML 卡片、
    要么是二进制残渣，两者都不是给人看的，一律退回 ``[label]`` —— 绝不把原始 XML 当正文。
    """
    body = text or ''
    if not label or label in ('text', '文本'):
        return body
    if body and not looks_like_markup(body) and not looks_like_noise(body):
        return body
    return '[' + label + ']'


# 微信 4.x local_type -> 给界面/模型看的类型名。
# 49 是"app 消息"，真正的子类型编码在**高 32 位**：local_type = (子类型 << 32) | 49。
# 实测群里 21474836529 / 201863462961 / 244813135921 / 270582939697 解压后的 XML 里
# <type> 正好是 5 / 47 / 57 / 63 —— 只看整数值会全部掉进"认不出"。
MESSAGE_TYPE_LABELS = {
    3: '图片', 34: '语音', 43: '视频', 47: '表情', 48: '位置', 49: '链接或文件',
    50: '通话', 10000: '系统消息', 11000: '表情', 8594229559345: '红包',
}

# 认不出类型时的中性标签。**不写类型号**：``类型244813135921`` 这种东西不该出现在界面上
# （真要看数字还有 ``type`` 字段）。想查具体类型就在日志/DB 里看 local_type。
UNKNOWN_MESSAGE_LABEL = '其他消息'


def message_type_label(local_type):
    """``local_type`` -> 给界面/模型看的类型名；文本消息返回 ``None``。

    先查原值，再查低 32 位（app 消息的复合类型），都不认识就给中性的「其他消息」。
    """
    try:
        value = int(local_type)
    except (TypeError, ValueError):
        return None
    if value == 1:
        return None
    return (MESSAGE_TYPE_LABELS.get(value)
            or MESSAGE_TYPE_LABELS.get(value & 0xFFFFFFFF)
            or UNKNOWN_MESSAGE_LABEL)


def split_sender_prefix(text, username):
    """切掉群消息正文前面的「发送者: 」前缀。

    微信在群消息的 ``message_content`` 里把发送者名字也写在正文开头
    （``wxid_xxx:\\n不是``）。发送者已经由 ``sender`` 单独给了，留在正文里只会让同一句话
    既当发送者又出现在内容里 —— 界面上就成了 ``wxid_xxx:不是``。

    只在**前缀正好等于发送者自己的 username** 时才切，所以"注意：\\n…"这类正常正文
    不会被吃掉。不匹配时原样返回。
    """
    if not text or not username or not text.startswith(username):
        return text
    rest = text[len(username):]
    if not rest.startswith(':'):
        return text
    body = rest[1:]
    if body.startswith('\n'):
        return body[1:]
    return body.lstrip(' \t')


def canonical_messages(messages):
    result = []
    for m in messages:
        if m.get('direction') not in ('incoming', 'outgoing') or not isinstance(m.get('content'), str):
            raise ValueError('Message direction or content is unknown')
        # **at 必须留着**：模型要靠它判断"这是什么时候说的"。
        # 少了它，几天前的一句"准备回家"和刚说的话看起来一样新（实测踩过）。
        result.append({'direction': m['direction'], 'content': unicodedata.normalize('NFC', m['content']).strip(),
                       'sender': m.get('sender'), 'type': m.get('type', 'unknown'),
                       'at': int(m.get('at') or m.get('sort_seq') or 0)})
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
        # 语音：一条后台线程 + 一个常驻识别进程。
        # 读消息**绝不能**在这里等转写（一条 1-2 秒，一次读十几条就是十几秒，页面直接卡住）。
        # 所以读的时候只看缓存；缺的丢进队列，后台慢慢转，下次读就有了。
        self._voice_queue = queue.Queue()
        self._voice_pending = set()
        self._voice_failed = set()
        self._voice_daemon = None
        self._voice_stop = threading.Event()
        # 转写能力状态（开关 + 识别装没装）的短缓存：见 _voice_ready。
        self._voice_ready_cache = None
        self._voice_thread = threading.Thread(target=self._voice_worker, daemon=True,
                                              name='voice-transcribe')
        self._voice_thread.start()
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

    # ---- 本地解密数据库（wechat-db-lab 明文产物）的读取 --------------------------
    #
    # 这一组方法**只读**：不打开微信窗口、不动前台、不清未读。解密产物在
    # `<vault>/<account>/plain/`，由常驻的 watcher 子进程负责解锁与保活。
    #
    # 旧版每个方法都自己拼一遍 name2id / display / account，重复且容易读串；这里抽成
    # 几个纯函数，db_sessions / db_messages / db_recent / db_search_contacts 共用同一份上下文。

    def _plain(self, timeout=30):
        """watcher 解锁出的明文目录；未就绪或不存在时返回 None。"""
        watcher = self._watcher()
        if not watcher.ready(timeout=timeout):
            return None
        workspace = watcher.workspace()
        if not workspace:
            return None
        plain = Path(workspace) / 'plain'
        return plain if plain.exists() else None

    @staticmethod
    def _open_ro(path):
        import sqlite3
        return sqlite3.connect(f'file:{Path(path).as_posix()}?mode=ro&immutable=1', uri=True)

    @staticmethod
    def _tables(conn):
        return [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")]

    @staticmethod
    def _msg_shards(plain):
        """消息分片（跳过 FTS 与 resource 库）。"""
        msg_dir = plain / 'message'
        if not msg_dir.exists():
            return []
        return [f for f in sorted(msg_dir.glob('message_*.db'))
                if not f.name.endswith('_fts.db') and not f.name.endswith('_resource.db')]

    @staticmethod
    def _display_map(plain):
        """username -> 显示名（备注 > 昵称 > username）。"""
        display = {}
        contact_db = plain / 'contact' / 'contact.db'
        if not contact_db.exists():
            return display
        try:
            conn = Worker._open_ro(contact_db)
            try:
                for row in conn.execute('SELECT username, remark, nick_name FROM contact'):
                    if row[0]:
                        display[row[0]] = row[1] or row[2] or row[0]
            finally:
                conn.close()
        except Exception:
            pass
        return display

    @staticmethod
    def _sender_index(plain):
        """sender rowid -> username。

        Name2Id（分片内，权威）先建，SenderName2Id（resource 库，覆盖群成员）后补；
        用 setdefault 保住分片内的映射，避免被 resource 库的低 rowid 覆盖。
        """
        index = {}
        for db_file in Worker._msg_shards(plain):
            try:
                conn = Worker._open_ro(db_file)
                try:
                    name2id = next((t for t in Worker._tables(conn)
                                    if t.lower() == 'name2id'), None)
                    if not name2id:
                        continue
                    cols = [r[1] for r in conn.execute(f'PRAGMA table_info("{name2id}")')]
                    col = 'user_name' if 'user_name' in cols else 'username'
                    for row in conn.execute(f'SELECT rowid, "{col}" FROM "{name2id}"'):
                        if row[1]:
                            index.setdefault(int(row[0]), row[1])
                finally:
                    conn.close()
            except Exception:
                continue
        resource = plain / 'message' / 'message_resource.db'
        if resource.exists():
            try:
                conn = Worker._open_ro(resource)
                try:
                    sendername = next((t for t in Worker._tables(conn)
                                       if t.lower() == 'sendername2id'), None)
                    if sendername:
                        cols = [r[1] for r in conn.execute(f'PRAGMA table_info("{sendername}")')]
                        col = 'user_name' if 'user_name' in cols else cols[0]
                        for row in conn.execute(f'SELECT rowid, "{col}" FROM "{sendername}"'):
                            if row[1]:
                                index.setdefault(int(row[0]), row[1])
                finally:
                    conn.close()
            except Exception:
                pass
        return index

    @staticmethod
    def _account_names(plain):
        """自己是谁：manifest 里的账号目录名（去尾缀）。"""
        account = ''
        try:
            account = json.loads((plain.parent / 'manifest.json').read_text(encoding='utf-8')).get('account', '')
        except Exception:
            pass
        if not account:
            return set()
        return {account, account.rsplit('_', 1)[0]}

    @staticmethod
    def _decode_message(content):
        """message_content -> 纯文本。

        只做 UTF-8 / 容器头解码（不做 zstd 解压）：长文本会退化成空串，日常短文本够用。
        """
        if content is None:
            return ''
        if isinstance(content, str):
            return content.strip()
        raw = bytes(content)
        if not raw:
            return ''
        try:
            return raw.decode('utf-8').strip()
        except UnicodeDecodeError:
            pass
        for offset in (10, 0):
            chunk = raw[offset:]
            if b'\x01\x00' in chunk:
                chunk = chunk.split(b'\x01\x00')[0]
            try:
                text = chunk.decode('utf-8').strip()
                if text:
                    return text
            except UnicodeDecodeError:
                continue
        return ''

    def _message_row(self, row, sender_index, self_names, display=None):
        """一行消息记录 -> canonical 消息。row 顺序：
        local_id, local_type, sort_seq, real_sender_id, create_time, message_content

        ``display`` 是 username -> 显示名（备注 > 昵称 > username）的映射。群消息的
        ``real_sender_id`` 只解得出 wxid，界面上就是一串 ``wxid_peer0001``，
        所以这里换成显示名。
        """
        sender_id = row[3]
        sender_user = sender_index.get(int(sender_id), '') if sender_id is not None else ''
        mine = bool(sender_user) and sender_user in self_names
        local_type = row[1]
        text = self._decode_message(row[5])
        kind = 'text' if local_type == 1 else str(local_type)
        # 语音：能转成文字就把文字当正文（整理、会话详情、首页都用得上），
        # 转不出来仍旧退回 [语音] 占位。有缓存，同一条只转一次。
        pending_voice = False
        if local_type == 34:
            spoken = voice.cached_only(self._data_dir(), row[0])
            if spoken:
                text = spoken
                kind = 'text'
            elif self._voice_ready() and self._voice_key(row[0]) not in self._voice_failed:
                # 还没转过：**不等**，标一下让界面显示"转写中"，同时排进后台队列。
                #
                # 这个条件不能省：识别没装、开关没开、或这条已经转失败过，界面就不该再说
                # "正在这台电脑上转成文字…" —— 那是**永远**不会发生的，用户会以为服务没启动
                # （实测就是这么以为的）。这种情况老老实实显示 [语音]。
                pending_voice = True
                self._queue_voice(row[0])
        # 群消息正文自己带着「发送者: 」前缀 —— 切掉。发送者单独给，同一句话不该既当
        # 发送者又出现在正文里（界面上就是 ``wxid_peer0001:不是``）。
        text = split_sender_prefix(text, sender_user)
        if kind != 'text':
            # 图片/视频/文件的正文是一整段 XML 卡片或二进制残渣，别当正文用。旧逻辑漏在这：
            # 那段 XML 是合法可打印 UTF-8，所以"解出来非空就当正文"永远成立。
            text = display_body(text, message_type_label(local_type))
        return {
            'direction': 'outgoing' if mine else 'incoming',
            'content': text,
            # 认不出显示名时退回 username 兜底（比空着强，但正常情况下 contact 表都有）。
            'sender': (display or {}).get(sender_user) or sender_user or '',
            'type': kind,
            'at': row[4] or 0,
            'sort_seq': row[2] or 0,
            'pending_voice': pending_voice,
        }

    def db_sessions(self, limit=500):
        """读 DB 会话列表（id=username, title=display），供创建规则/消息中心使用。

        直接读 watcher 子进程解锁出的明文 session.db + contact.db（标准 sqlite3，
        无需 cryptography），身份是原生 username —— 创建规则与监听用同一把钥匙。
        """
        plain = self._plain()
        if plain is None:
            return []
        display = self._display_map(plain)
        sessions = []
        session_db = plain / 'session' / 'session.db'
        if session_db.exists():
            try:
                conn = self._open_ro(session_db)
                try:
                    rows = conn.execute(
                        'SELECT username FROM SessionTable WHERE is_hidden=0 '
                        'ORDER BY sort_timestamp DESC LIMIT ?', (limit,)).fetchall()
                    for row in rows:
                        username = row[0]
                        title = display.get(username, username)
                        if not username or is_system_entry(title) or is_system_entry(username):
                            continue
                        sessions.append({'id': username, 'title': title, 'kind': session_kind(username)})
                finally:
                    conn.close()
            except Exception:
                pass
        return sessions

    def db_messages(self, username, limit=500):
        """读 DB 里某个会话的最近消息（username 定位），返回 canonical 格式。

        供「分析说话方式」等用户点名功能使用：直接读明文 message_N.db，不再 OCR
        打开会话。消息正文只做纯 UTF-8 / 容器头解码，对"分析日常短文本说话习惯"足够。
        """
        import hashlib

        empty = {'username': username, 'display': username, 'messages': []}
        plain = self._plain()
        if not username or plain is None:
            return empty
        index = self._sender_index(plain)
        self_names = self._account_names(plain)
        display_map = self._display_map(plain)
        display = display_map.get(username, username)
        table = 'Msg_' + hashlib.md5(username.encode('utf-8')).hexdigest()
        messages = []
        for db_file in self._msg_shards(plain):
            try:
                conn = self._open_ro(db_file)
                try:
                    rows = conn.execute(
                        f'SELECT local_id, local_type, sort_seq, real_sender_id, create_time, message_content '
                        f'FROM "{table}" ORDER BY sort_seq DESC LIMIT ?', (limit,)).fetchall()
                    for row in rows:
                        messages.append(self._message_row(row, index, self_names, display_map))
                finally:
                    conn.close()
            except Exception:
                continue
        messages.sort(key=lambda m: m['sort_seq'])
        return {'username': username, 'display': display, 'messages': messages[-limit:]}

    def db_recent(self, sessions=12, per_session=20):
        """一次调用取回「最近有动静的若干会话 + 各自的最近消息」。

        这是首页与整理的数据底座。旧做法是每个会话调一次 db_messages，而每次都要重扫
        全部分片的 name2id 与 contact 表；这里上下文只建一次、分片也只遍历一次，成本从
        O(会话数 × 分片数) 降到 O(分片数 + 目标表数)。
        """
        result = {'sessions': [], 'account': '', 'scanned_at': int(time.time())}
        plain = self._plain()
        if plain is None:
            return result
        names = self._account_names(plain)
        result['account'] = sorted(names)[-1] if names else ''
        display = self._display_map(plain)
        index = self._sender_index(plain)

        session_db = plain / 'session' / 'session.db'
        if not session_db.exists():
            return result
        try:
            conn = self._open_ro(session_db)
            try:
                rows = conn.execute(
                    'SELECT username, unread_count, summary, sort_timestamp, last_timestamp '
                    'FROM SessionTable WHERE is_hidden=0 ORDER BY sort_timestamp DESC LIMIT ?',
                    (max(sessions * 4, 60),)).fetchall()
            finally:
                conn.close()
        except Exception:
            return result

        wanted = []
        for row in rows:
            username = row[0]
            title = display.get(username, username)
            if not username or is_system_entry(title) or is_system_entry(username):
                continue
            last_at = row[4] or row[3] or 0
            # 微信里存在一批"占位会话"：没有历史，时间戳停在 1970-01-01 08:00（=28800）。
            # 它们不是"最近有动静"，不该占首页名额，所以按 2000 年设下限。
            if last_at < 946684800:
                continue
            wanted.append({'username': username, 'title': title, 'unread': row[1] or 0,
                           'summary': row[2] or '', 'last_at': last_at})
            if len(wanted) >= sessions:
                break

        import hashlib
        table_of = {item['username']: 'Msg_' + hashlib.md5(item['username'].encode('utf-8')).hexdigest()
                    for item in wanted}
        collected = {item['username']: [] for item in wanted}
        for db_file in self._msg_shards(plain):
            try:
                conn = self._open_ro(db_file)
            except Exception:
                continue
            try:
                present = set(self._tables(conn))
                for username, table in table_of.items():
                    if table not in present:
                        continue
                    try:
                        rows2 = conn.execute(
                            f'SELECT local_id, local_type, sort_seq, real_sender_id, create_time, message_content '
                            f'FROM "{table}" ORDER BY sort_seq DESC LIMIT ?', (per_session,)).fetchall()
                    except Exception:
                        continue
                    for row in rows2:
                        collected[username].append(self._message_row(row, index, names, display))
            finally:
                conn.close()

        for item in wanted:
            messages = sorted(collected[item['username']], key=lambda m: m['sort_seq'])[-per_session:]
            last_in = next((m['at'] for m in reversed(messages) if m['direction'] == 'incoming'), 0)
            last_out = next((m['at'] for m in reversed(messages) if m['direction'] == 'outgoing'), 0)
            result['sessions'].append({
                'username': item['username'],
                'title': item['title'],
                'kind': 'group' if item['username'].endswith('@chatroom') else 'direct',
                'unread': item['unread'],
                'summary': item['summary'],
                'last_at': item['last_at'],
                'last_incoming_at': last_in,
                'last_outgoing_at': last_out,
                'messages': messages,
            })
        return result

    def db_search_contacts(self, keyword, limit=50):
        """本地搜索联系人（remark / nick_name / username 模糊匹配），供说话方式分析等使用。

        联系人数据就在本地 DB，无需 OCR、无需微信前台，直接 LIKE 检索。

        搜完联系人表**再搜一遍会话表**：群聊、公众号这些不在 contact 表里，只搜联系人
        会漏掉它们 —— 而"给某个群自动回复"正是最需要搜索的场景之一。
        """
        keyword = (keyword or '').strip()
        if not keyword:
            return []
        plain = self._plain()
        if plain is None:
            return []
        contact_db = plain / 'contact' / 'contact.db'
        results = []
        seen = set()
        if contact_db.exists():
            try:
                conn = self._open_ro(contact_db)
                try:
                    like = f'%{keyword}%'
                    rows = conn.execute(
                        'SELECT username, remark, nick_name FROM contact '
                        'WHERE (remark LIKE ? OR nick_name LIKE ? OR username LIKE ?) LIMIT ?',
                        (like, like, like, limit)).fetchall()
                    for row in rows:
                        username = row[0]
                        title = row[1] or row[2] or row[0]
                        if not username or is_system_entry(title) or is_system_entry(username):
                            continue
                        results.append({'id': username, 'title': title, 'kind': session_kind(username)})
                        seen.add(username)
                finally:
                    conn.close()
            except Exception:
                pass
        # 会话表里的匹配（群聊、公众号…）。去重：同一个人可能在两处都命中。
        lowered = keyword.lower()
        for session in self.db_sessions(limit=2000):
            if session['id'] in seen:
                continue
            if lowered in session['title'].lower() or lowered in session['id'].lower():
                results.append(session)
                seen.add(session['id'])
            if len(results) >= limit:
                break
        return results

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
        # 别把常驻的识别进程留成孤儿：Worker 退出时一起收掉。
        try:
            self.close_voice()
        except Exception:
            pass
        if self.watcher is not None:
            self.watcher.close()
            self.watcher = None

    # ---- 事件 → 历史 ----
    @staticmethod
    def _canonical(event):
        local_type = event.get('local_type')
        kind = 'text' if local_type == 1 else (event.get('type') or 'unknown')
        return {
            'direction': event.get('direction'),
            # 非文本事件的 text 是 XML 卡片时换成 [类型] 占位（见 display_body）。
            'content': display_body(event.get('text'), message_type_label(local_type)),
            'sender': event.get('sender'),
            'type': kind,
            'at': int(event.get('create_time') or event.get('at') or 0),
        }

    def _ingest(self, event):
        """把一条事件记入内存历史；返回 (是否触发回复, canonical 消息)。"""
        username = event.get('username') or ''
        message = self._canonical(event)
        # 语音先试着转成文字。用户开了这个开关、并且自己装好了识别环境，才走这条路；
        # 转不出来（没装/太短/不是 SILK）就保持原样，由 _note_unhandled 说明情况。
        transcript = self._transcribe(event)
        if transcript:
            message = {**message, 'content': transcript, 'type': 'text'}
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
                        and bool(message.get('content'))
                        and (event.get('local_type') == 1 or bool(transcript)))
        return should_reply, message

    def _data_dir(self) -> Path:
        return Path(self.config['control_token_file']).parent

    def _voice_blob(self, local_id):
        """按 local_id 从库里取语音的 SILK 音频。

        **关键**：watcher 事件里只有 local_id，**没有音频**（事件结构里就没有 voice_data 字段），
        音频在 message/media_*.db 的 VoiceInfo 表里。第一版就是直接读 event['voice_data']，
        结果永远为空、语音永远读不到 —— 实测报的就是这个。
        """
        if local_id in (None, ''):
            return b''
        try:
            key = int(local_id)
        except (TypeError, ValueError):
            return b''
        plain = self._plain()
        if plain is None:
            return b''
        media_dir = plain / 'message'
        if not media_dir.exists():
            return b''
        for db_file in sorted(media_dir.glob('media_*.db')):
            try:
                conn = self._open_ro(db_file)
            except Exception:
                continue
            try:
                row = conn.execute(
                    'SELECT voice_data FROM VoiceInfo WHERE local_id = ? '
                    'ORDER BY create_time DESC LIMIT 1', (key,)).fetchone()
            except Exception:
                row = None
            finally:
                conn.close()
            if row and row[0]:
                return bytes(row[0])
        return b''

    def voice_text(self, local_id) -> str:
        """语音 -> 文字（带缓存）。没开开关、没装识别、或转不出来都返回空串。"""
        try:
            prefs = voice.load_prefs(self._data_dir())
        except Exception as error:
            # 不留痕的话，一个 NameError 会变成"语音永远读不到"而毫无线索（今天就是这么踩的）
            self.last_voice_error = str(error)[:200]
            return ''
        if not prefs.get('enabled'):
            return ''
        runtime = voice.voice_python(self._data_dir())
        if runtime is None:
            return ''
        python_exe, lib_dir = runtime
        app_root = self.config.get('app_root') or Path(__file__).resolve().parent.parent

        def produce():
            blob = self._voice_blob(local_id)
            if not blob:
                raise voice.VoiceError('库里没有这段语音的音频')
            wav = self._data_dir() / 'voice' / ('v%s.wav' % local_id)
            voice.silk_to_wav(blob, wav, app_root)
            # 优先用常驻服务：模型已经载好了，一条只要 1~2 秒；
            # 它起不来才退回"每次起进程"的老路（慢，但至少能用）。
            daemon = self._voice_daemon_instance()
            if daemon is not None:
                return daemon.transcribe(wav, local_id)
            return voice.transcribe(wav, str(python_exe),
                                    prefs.get('model') or voice.DEFAULT_MODEL, lib_dir=lib_dir)

        try:
            text = voice.cached_transcript(self._data_dir(), local_id, produce)
            self.last_voice_error = ''
            return text
        except Exception as error:
            self.last_voice_error = str(error)[:200]
            return ''

    def _transcribe(self, event) -> str:
        """事件里的语音消息 -> 文字。

        这条路径**可以等**：它在自动回复的异步流程里，不像读界面那样会卡住用户。
        """
        if event.get('direction') != 'incoming' or event.get('local_type') != 34:
            return ''
        return self.voice_text(event.get('local_id'))

    @staticmethod
    def _voice_key(local_id):
        """消息号 -> 转写缓存的键；不是数字就返回 None。"""
        try:
            return int(local_id)
        except (TypeError, ValueError):
            return None

    def _voice_ready(self):
        """这台电脑现在能不能转语音（开关开着 **且** 识别真的装好了）。

        ``pending_voice`` 必须挂这个判断 —— 否则识别坏了也一直显示"正在转写"，
        看起来就像服务没启动。结果按要求缓存 5 秒：一条会话要过几百条消息，
        不该每条都去 stat 一遍那几个路径。
        """
        now = time.time()
        if self._voice_ready_cache is not None and now - self._voice_ready_cache[0] < 5:
            return self._voice_ready_cache[1]
        ready = False
        try:
            prefs = voice.load_prefs(self._data_dir())
            app_root = self.config.get('app_root') or Path(__file__).resolve().parent.parent
            ready = (prefs.get('enabled') is True
                     and voice.available(self._data_dir(), app_root)['transcriber'])
        except Exception:
            ready = False
        self._voice_ready_cache = (now, ready)
        return ready

    def _queue_voice(self, local_id):
        """把一条待转写的语音排进后台队列。

        去重 + 上限：一次读十几条语音、或者用户反复刷新，都不该堆成一座山；
        失败过的也不再排（省得一直重试烧 CPU）。
        """
        key = self._voice_key(local_id)
        if key is None:
            return
        if key in self._voice_pending or key in self._voice_failed:
            return
        if self._voice_queue.qsize() >= 50:
            return
        self._voice_pending.add(key)
        self._voice_queue.put(key)

    def _voice_worker(self):
        """后台转写线程：界面不等它，转完写进缓存，下次读就有文字了。"""
        while not self._voice_stop.is_set():
            try:
                key = self._voice_queue.get(timeout=1.0)
            except queue.Empty:
                continue
            try:
                if not self.voice_text(key):
                    self._voice_failed.add(key)
            except Exception:
                self._voice_failed.add(key)
            finally:
                self._voice_pending.discard(key)

    def _voice_daemon_instance(self):
        """常驻识别进程（懒启动，模型只载一次）。不可用时返回 None。"""
        if self._voice_daemon is not None:
            return self._voice_daemon
        runtime = voice.voice_python(self._data_dir())
        if runtime is None:
            return None
        python_exe, lib_dir = runtime
        prefs = voice.load_prefs(self._data_dir())
        self._voice_daemon = voice.Daemon(str(python_exe),
                                          prefs.get('model') or voice.DEFAULT_MODEL, lib_dir)
        return self._voice_daemon

    def close_voice(self):
        """停掉后台线程与常驻进程（进程退出时调用）。"""
        self._voice_stop.set()
        daemon, self._voice_daemon = self._voice_daemon, None
        if daemon is not None:
            try:
                daemon.close()
            except Exception:
                pass

    def _rules_by_username(self):
        out = {}
        for rule in self.store.rules():
            if rule['enabled'] and rule['status'] != 'blocked':
                out.setdefault(rule['conversation'], []).append(rule)
        return out

    def _handle_event(self, event, rules_by_username):
        should_reply, message = self._ingest(event)
        username = event.get('username') or ''
        if not should_reply:
            self._note_unhandled(event, rules_by_username, username)
            return
        for rule in rules_by_username.get(username, []):
            if rule['status'] in ('queued', 'generating', 'ready', 'sending'):
                continue
            history = self._history.get(username, [])
            incoming = [message]
            fingerprint = str(event.get('sort_seq') or event.get('local_id') or '')
            self.store.enqueue(rule, history, incoming, self.config['job_ttl_seconds'], fingerprint)

    #: 微信 4.x 的 local_type -> 给人看的名字。只列"我们知道但看不到内容"的那几种。
    _TYPE_NAMES = {3: '图片', 34: '语音', 43: '视频', 47: '表情', 49: '文件或链接'}

    def _note_unhandled(self, event, rules_by_username, username):
        """收到但不会回复的消息，在规则上留一句说明。

        为什么要有这个：非文本消息（语音/图片/视频/文件）**不会**触发回复 —— 内容根本读不到。
        但"什么都不说"是最糟的：用户看到对方发了三条语音、助手毫无反应，只会以为它坏了
        （用户实测报的就是这个）。所以这里把"发生了什么、为什么没动"写在规则上，
        界面就有东西可以显示，而不是一片沉默。
        """
        if event.get('direction') != 'incoming':
            return
        local_type = event.get('local_type')
        if local_type in (None, 1):
            return
        label = self._TYPE_NAMES.get(local_type)
        if not label:
            return
        tail = '需要你自己听一遍。' if local_type == 34 else '需要你自己看一下。'
        detail = f'对方发来的是一条{label}，我读不到里面的内容；{tail}'
        # 语音在"开了转文字但没成功"时，多给一句为什么 —— 否则用户看着开关是开的、
        # 却还是"读不到"，会以为坏了。
        if local_type == 34 and getattr(self, 'last_voice_error', ''):
            detail = f'对方发来的是一条语音，这次没能转成文字（{self.last_voice_error}）；需要你自己听一遍。'
        for rule in rules_by_username.get(username, []):
            if rule['status'] in ('queued', 'generating', 'ready', 'sending'):
                continue
            self.store.status(rule['id'], rule['revision'], 'listening', detail)

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
        # 这句会直接显示在界面上，所以只说「消息助手」—— 用户不需要知道底层是谁在跑。
        self.store.status(rule['id'], rule['revision'], 'generating', '消息助手正在处理新消息')
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
            # 发送走 UI，需要微信窗口可用（DB 读不碰窗口）。窗口最小化/收到托盘时先恢复；
            # 窗口本就可用的场景 restore 会快速返回，无副作用。
            try:
                self.mcp.call('restore_window', {'provider': job['provider']})
            except Exception:
                pass
            try:
                outcome = self.mcp.call('send_message', {'provider': job['provider'],
                         'conversation_id': rule['title'], 'text': decision['text'],
                         'request_id': job['request_id'], 'origin': 'agent_proposed'})
            except Exception:
                try:
                    outcome = self.mcp.call('get_send_status', {'request_id': job['request_id']})
                except Exception:
                    outcome = {'status': 'uncertain'}
            outcome = normalize_send_outcome(outcome)
            state = outcome['status']
            if state != 'sent':
                self.store.finish(job, state, 'Runtime: ' + outcome['code'])
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
            # 发出去之后**不留在规则上写"已提交回复"**：那是一句话的状态，挂在界面上会一直
            # 显示成"当前正在做的事"，让人以为卡住了（用户实测报的就是这个）。真正的结果在
            # 最近处理记录里，那里才是"留存、有事可查"的地方。
            self.store.status(rule['id'], rule['revision'], 'listening', '')
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

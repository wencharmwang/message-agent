import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

/**
 * The message centre: "what happened, and does it need me".
 *
 * It is deliberately not the automatic-reply view. Automatic reply answers "is the
 * assistant doing its job"; this answers "who wrote to me and what do I owe them".
 * The two views list overlapping conversations on purpose — same contact, different
 * question — and neither borrows the other's status.
 *
 * Facts about the message platform that shaped this schema (all verified in
 * messaging-runtime, see docs/message-center-product-design.md §2):
 *  - the runtime exposes a per-conversation activity fingerprint but NO preview text,
 *    so "what did they say" is unknowable until the chat is actually read;
 *  - opening a chat clears that chat's unread badge, so reading is never automatic
 *    unless the user asked for it;
 *  - therefore a message count is recorded only once the conversation HAS been read.
 *    Until then it stays null and the UI must say "有新消息 · 还没读" instead of a number.
 */

export const SCOPES = ['attention', 'new', 'all'];
export const ORDERS = ['priority', 'recent'];
export const CLASSIFICATIONS = ['reply', 'action', 'fyi', 'unknown'];
export const ACTIONS = ['reply', 'draft', 'todo', 'followup', 'defer', 'mark_seen', 'ignore', 'complete'];
/** Classes that mean "a human still has to decide something". */
const ATTENTION_CLASSES = new Set(['reply', 'action', 'unknown']);
/** Sort ranks: the assistant's "needs a decision" classes come first. */
const PRIORITY = {reply: 0, action: 1, unknown: 2, fyi: 3};

/**
 * WeChat's own service folders appear in the chat list as if they were conversations
 * (公众号/服务号/微信支付/订阅号/文件传输助手). They are not: their preview is pushed by
 * the platform and changes without any human sending anything, and "opening" one switches
 * views instead of opening a chat. They are dropped before ever being recorded, so the
 * queue stops churning and duplicating on them.
 */
const SYSTEM_ENTRY_KEYS = new Set([
  '公众号', '服务号', '微信支付', '订阅号', '文件传输助手',
  '服务通知', '腾讯新闻', '微信团队', '企业微信', '视频号', '群发助手'
]);
function nameKey(name) {
  // NFKC folds ①→1 and full-width forms, then keep letters/digits/Han only.
  return [...String(name ?? '').normalize('NFKC')].filter(ch => /\p{L}|\p{N}/u.test(ch)).join('').toLowerCase();
}
export function isSystemEntry(name) {
  return SYSTEM_ENTRY_KEYS.has(nameKey(name));
}

/**
 * A conversation id is a hash of the display name, so an OCR re-read of the same contact
 * under a slightly different name detaches it into a duplicate row. The noise is always on
 * the tail: "长江证.@长江..．昨天1111", "树袋熊?天", "周二轮滑1班（16..1302" — the relative time
 * ("昨天"/"13:02"), a truncated "天/昨", ellipsis, or stray punctuation. canonicalName strips
 * exactly that, so duplicates merge while two genuinely different names never do.
 */
const SUFFIX_NOISE = /(?:…|\.\.\.|\.\.|·+|昨天|今天|前天|星期[一二三四五六日天]|周[一二三四五六日天]|[天昨今]|[\d:：.]+)+$/;
function canonicalName(name) {
  let s = String(name ?? '').normalize('NFKC');
  for (let i = 0; i < 4; i += 1) {
    const next = s.replace(SUFFIX_NOISE, '');
    if (next === s) break;
    s = next;
  }
  return nameKey(s);
}

// SHA-256(empty string), shortened by messaging-runtime. An empty preview is not
// evidence of activity: treating it as a real signal made rows with unreadable OCR
// oscillate between "new" and "seen".
const EMPTY_PREVIEW_HASH = 'E3B0C44298FC1C14';
function usablePreviewHash(value) {
  const hash = typeof value === 'string' ? value : '';
  return hash && hash !== EMPTY_PREVIEW_HASH ? hash : '';
}

function commonPrefixLength(a, b) {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  return index;
}

/**
 * Conservative OCR identity recovery. Exact canonical names always match. Otherwise
 * require the same non-empty preview plus a long shared name prefix/containment: preview
 * equality alone is unsafe because many chats end with the same short sentence.
 */
function sameConversation(leftName, rightName, leftPreview, rightPreview) {
  const left = canonicalName(leftName);
  const right = canonicalName(rightName);
  if (!left || !right) return false;
  if (left === right) return true;
  const preview = usablePreviewHash(leftPreview);
  if (!preview || preview !== usablePreviewHash(rightPreview)) return false;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  if (shorter.length >= 4 && longer.includes(shorter)) return true;
  const prefix = commonPrefixLength(left, right);
  return prefix >= 5 && prefix / Math.min(left.length, right.length) >= 0.7;
}

function displayNameScore(value) {
  const raw = String(value ?? '');
  const canonical = canonicalName(raw);
  let score = canonical.length * 10;
  if (/[.…?？]$/.test(raw)) score -= 15;
  if (/(?:星期|昨天|今天|前天|\d{1,2}[/:-]\d{1,2}|[QOＲＯ]{1,2})$/i.test(raw)) score -= 20;
  return score;
}

function preferredDisplayName(current, observed) {
  return displayNameScore(observed) > displayNameScore(current) ? observed : current;
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(col => col.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversation_activity (
  conversation_key TEXT PRIMARY KEY,
  provider         TEXT NOT NULL,
  conversation     TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'direct',
  fingerprint      TEXT,
  previous_fingerprint TEXT,
  preview_hash     TEXT,
  candidate        TEXT,
  candidate_since  REAL,
  candidate_hits   INTEGER NOT NULL DEFAULT 0,
  last_activity_at REAL,
  last_seen_at     REAL,
  last_processed_at REAL,
  observed_at      REAL NOT NULL,
  unread_hint      INTEGER,
  new_message_count INTEGER,
  observation_state TEXT NOT NULL DEFAULT 'seen',
  following        INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS message_batch (
  id                     TEXT PRIMARY KEY,
  conversation_key       TEXT NOT NULL,
  first_message_at       REAL NOT NULL,
  last_message_at        REAL NOT NULL,
  message_count          INTEGER,
  source_message_refs    TEXT NOT NULL DEFAULT '',
  summary                TEXT NOT NULL DEFAULT '',
  classification         TEXT NOT NULL DEFAULT 'unknown',
  classification_reason  TEXT NOT NULL DEFAULT '',
  classification_version INTEGER NOT NULL DEFAULT 0,
  classified_at          REAL,
  read_at                REAL,
  state                  TEXT NOT NULL DEFAULT 'open',
  created_at             REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS message_batch_conversation ON message_batch(conversation_key, created_at);
CREATE INDEX IF NOT EXISTS message_batch_state ON message_batch(state);
CREATE TABLE IF NOT EXISTS message_action (
  id               TEXT PRIMARY KEY,
  batch_id         TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  action_type      TEXT NOT NULL,
  action_state     TEXT NOT NULL DEFAULT 'done',
  linked_object_id TEXT,
  note             TEXT NOT NULL DEFAULT '',
  created_at       REAL NOT NULL,
  completed_at     REAL
);
CREATE INDEX IF NOT EXISTS message_action_batch ON message_action(batch_id);
-- "What did the user do with this conversation most recently" is asked once per row on the
-- queue and once per conversation on 「今天要做的」, so it should not be a table scan.
CREATE INDEX IF NOT EXISTS message_action_conversation ON message_action(conversation_key, created_at);
CREATE TABLE IF NOT EXISTS triage_feedback (
  id                TEXT PRIMARY KEY,
  batch_id          TEXT NOT NULL,
  conversation_key  TEXT NOT NULL,
  predicted_class   TEXT NOT NULL DEFAULT '',
  final_user_action TEXT NOT NULL DEFAULT '',
  reason            TEXT NOT NULL DEFAULT '',
  created_at        REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS message_snapshot (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_key TEXT NOT NULL,
  observed_at      REAL NOT NULL,
  messages_json    TEXT NOT NULL,
  message_count    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS message_snapshot_conversation ON message_snapshot(conversation_key, observed_at);
CREATE TABLE IF NOT EXISTS center_preference (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at REAL NOT NULL
);
`;

/**
 * How many messages in `current` were not in `previous`.
 *
 * Both are bounded windows of the same chat, so the new ones are whatever follows the
 * overlap. When nothing overlaps (the window scrolled away entirely) the honest answer
 * is "all of them are unfamiliar", which is what the caller turns into "还没读".
 */
export function newMessageCount(previous, current) {
  const key = message => `${message?.direction ?? ''}\u0000${message?.content ?? ''}`;
  const before = (previous ?? []).map(key);
  const after = (current ?? []).map(key);
  for (let size = Math.min(before.length, after.length); size > 0; size -= 1) {
    const tail = before.slice(before.length - size);
    const head = after.slice(0, size);
    if (tail.every((value, index) => value === head[index])) return after.length - size;
  }
  return after.length;
}

/** Rank used by the default ordering: what needs a decision first, chit-chat last. */
export function priorityRank(item) {
  if (item.automationProblem) return -1;
  if (item.pendingDrafts > 0) return 0;
  if (!item.classified) return PRIORITY.unknown;
  return PRIORITY[item.classification] ?? PRIORITY.unknown;
}

export function createMessageCenter({databasePath, identityKey, clock = () => Date.now() / 1000, settleSeconds = 12}) {
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  // Columns added after the first deploy; keep old databases working.
  ensureColumn(db, 'conversation_activity', 'preview_hash', 'TEXT');
  ensureColumn(db, 'conversation_activity', 'candidate', 'TEXT');
  ensureColumn(db, 'conversation_activity', 'candidate_since', 'REAL');
  ensureColumn(db, 'conversation_activity', 'candidate_hits', 'INTEGER NOT NULL DEFAULT 0');
  // Why the last classification attempt did not produce a label. Without it a row stuck at
  // 待判断 has no explanation anywhere: the caller's catch is silent by design (the batch
  // must stay visible rather than disappear), so the reason has to be stored here.
  ensureColumn(db, 'message_batch', 'classification_error', "TEXT NOT NULL DEFAULT ''");
  // 后台读正文失败后必须退避。一个**永远读不到**的会话（改了名、或不在可见列表里）否则会被
  // 每一轮轮询重试一次：驱动会反复去点它的会话行、移动用户的微信、把日志刷爆 —— 实测 11 分钟
  // 重试了 56 次。失败次数 + 递增冷却一起挡住它。
  ensureColumn(db, 'message_batch', 'read_attempts', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'message_batch', 'read_failed_at', 'REAL');
  const keyOf = (provider, conversation) => identityKey(provider, conversation);

  const activity = key => db.prepare('SELECT * FROM conversation_activity WHERE conversation_key = ?').get(key) ?? null;

  return {
  /**
   * Fold one discovery pass into the store.
   *
   * A conversation seen for the first time only establishes a baseline: the product
   * was not watching before, so it cannot say anything arrived. Everything after that
   * compares against the stored fingerprint — the same signal the automatic-reply
   * trigger already uses, which is why it costs no extra WeChat read.
   *
   * Consecutive changes stay in ONE batch until the user deals with it, so coming back
   * after a day shows one row per conversation rather than twenty.
   */
  sync({providers, at = clock()} = {}) {
    let changed = 0;
    let opened = 0;
    const rekeyed = [];
    const statement = {
      insert: db.prepare(`INSERT INTO conversation_activity
        (conversation_key, provider, conversation, display_name, fingerprint, preview_hash, observed_at, observation_state)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'seen')`),
      touch: db.prepare(`UPDATE conversation_activity
        SET conversation = ?, display_name = ?, observed_at = ?, fingerprint = ?, preview_hash = ?,
            candidate = ?, candidate_since = ?, candidate_hits = ?
        WHERE conversation_key = ?`),
      mark: db.prepare(`UPDATE conversation_activity
        SET last_activity_at = ?, observation_state = 'new' WHERE conversation_key = ?`)
    };
    for (const [provider, table] of Object.entries(providers ?? {})) {
      for (const [conversation, row] of Object.entries(table ?? {})) {
        const name = typeof row?.name === 'string' ? row.name.trim() : '';
        // A nameless row cannot be shown or matched against a rule, so it is not recorded.
        if (!name || isSystemEntry(name)) continue;
        const fingerprint = typeof row?.fingerprint === 'string' ? row.fingerprint : '';
        const previewHash = usablePreviewHash(row?.preview_hash);
        const rawKey = keyOf(provider, conversation);
        // The Runtime id is derived from OCR text, not a native WeChat id. Re-reading the
        // same display name differently must update the existing stable product row rather
        // than create/re-key a row on every scan.
        let current = activity(rawKey)
          ?? db.prepare('SELECT * FROM conversation_activity WHERE provider = ? AND conversation = ?').get(provider, conversation)
          ?? db.prepare('SELECT * FROM conversation_activity WHERE provider = ? ORDER BY observed_at DESC').all(provider)
            .find(entry => sameConversation(entry.display_name, name, entry.preview_hash, previewHash));
        let key = current?.conversation_key ?? rawKey;
        if (!current) {
          statement.insert.run(key, provider, conversation, name, fingerprint, previewHash, at);
          current = activity(key);
        }
        // Identity healing: fold stale OCR duplicates (same canonical name, old id gone)
        // into this row. Runs whether the id is new or already tracked, so a contact that
        // accumulated several name variants collapses even after its row is established.
        if (canonicalName(name)) {
          const duplicates = db.prepare('SELECT conversation_key, conversation, display_name, preview_hash FROM conversation_activity WHERE provider = ?')
            .all(provider)
            .filter(dup => dup.conversation_key !== key
              && sameConversation(dup.display_name, name, dup.preview_hash, previewHash));
          for (const dup of duplicates) {
            this.mergeInto(key, dup.conversation_key);
            rekeyed.push({oldKey: dup.conversation_key, newKey: key, provider, conversation,
              name: preferredDisplayName(current.display_name, name)});
          }
        }
        current = activity(key);
        // "New content" is preview_hash (hash of the preview text only); fingerprint mixes in
        // the relative display time and would churn on its own. The preview TEXT is still read
        // by OCR, which returns it differently between frames — so one differing read must not
        // open a batch. This mirrors the automatic-reply settle: a value only counts once it has
        // held still for `settleSeconds`, and a read that returns to the settled value clears the
        // pending one, so a per-frame flip can never be mistaken for news.
        // Never fall back to activity_fingerprint here: it includes the displayed relative
        // time, so it changes even when the message does not. Only a real, non-empty preview
        // hash may open a batch.
        const signal = previewHash;
        let baseline = current.preview_hash ?? null;
        let candidate = current.candidate ?? null;
        let candidateSince = current.candidate_since ?? null;
        let candidateHits = current.candidate_hits ?? 0;
        let moved = false;
        if (!signal) {
          // Nothing readable yet. Do not disturb a settled baseline with OCR absence.
        } else if (!baseline) {
          baseline = signal;
        } else if (signal === baseline) {
          candidate = null;
          candidateSince = null;
          candidateHits = 0;
        } else if (settleSeconds <= 0) {
          // Settling disabled (explicit opt-out; the tests use it): any difference counts now.
          moved = true;
          baseline = signal;
          candidate = null;
          candidateSince = null;
          candidateHits = 0;
        } else if (signal !== candidate) {
          candidate = signal;
          candidateSince = at;
          candidateHits = 1;
        } else {
          candidateHits += 1;
        }
        // Time alone was insufficient: one consistently wrong OCR frame could survive for
        // twelve seconds and become fake news. Require three agreeing scans as well.
        if (!moved && signal && signal !== baseline && signal === candidate
            && candidateHits >= 3 && candidateSince !== null && at - candidateSince >= settleSeconds) {
          moved = true;
          baseline = signal;
          candidate = null;
          candidateSince = null;
          candidateHits = 0;
        }
        statement.touch.run(conversation, preferredDisplayName(current.display_name, name), at,
          fingerprint || current.fingerprint, baseline, candidate, candidateSince, candidateHits, key);
        if (!moved) continue;
        changed += 1;
        const open = db.prepare(
          "SELECT id FROM message_batch WHERE conversation_key = ? AND state = 'open' ORDER BY created_at DESC LIMIT 1").get(key);
        if (open) {
          db.prepare('UPDATE message_batch SET last_message_at = ? WHERE id = ?').run(at, open.id);
        } else {
          // The batch covers everything since the last change we already showed.
          const from = current.last_activity_at ?? at;
          db.prepare(`INSERT INTO message_batch
            (id, conversation_key, first_message_at, last_message_at, state, created_at)
            VALUES (?, ?, ?, ?, 'open', ?)`).run(randomUUID(), key, from, at, at);
          opened += 1;
        }
        statement.mark.run(at, key);
      }
    }
    this.pruneSystemEntries();
    return {changed, opened, rekeyed};
  },

  /**
   * Fold a stale duplicate into the canonical row: move its history under the new key and
   * drop the old activity row. The new-key row must already exist (or be inserted first),
   * so this never collides on the primary key.
   */
  mergeInto(newKey, oldKey) {
    const target = activity(newKey);
    const source = activity(oldKey);
    if (!target || !source || newKey === oldKey) return;
    for (const table of ['message_batch', 'message_action', 'message_snapshot', 'triage_feedback']) {
      db.prepare(`UPDATE ${table} SET conversation_key = ? WHERE conversation_key = ?`).run(newKey, oldKey);
    }
    db.prepare(`UPDATE conversation_activity SET
      display_name = ?,
      last_activity_at = CASE
        WHEN last_activity_at IS NULL THEN ?
        WHEN ? IS NULL THEN last_activity_at
        ELSE MAX(last_activity_at, ?) END,
      last_seen_at = CASE
        WHEN last_seen_at IS NULL THEN ?
        WHEN ? IS NULL THEN last_seen_at
        ELSE MAX(last_seen_at, ?) END,
      observation_state = CASE WHEN observation_state = 'new' OR ? = 'new' THEN 'new' ELSE observation_state END,
      following = CASE WHEN following = 1 OR ? = 1 THEN 1 ELSE 0 END
      WHERE conversation_key = ?`).run(
        preferredDisplayName(target.display_name, source.display_name),
        source.last_activity_at, source.last_activity_at, source.last_activity_at,
        source.last_seen_at, source.last_seen_at, source.last_seen_at,
        source.observation_state, source.following, newKey);
    db.prepare('DELETE FROM conversation_activity WHERE conversation_key = ?').run(oldKey);
  },

  /** Remove system folders that were recorded before the filter existed. */
  pruneSystemEntries() {
    for (const row of db.prepare('SELECT conversation_key, display_name FROM conversation_activity').all()) {
      if (isSystemEntry(row.display_name)) this.forget(row.conversation_key);
    }
  },

  decorate(extra) {
    const rules = extra?.rules ?? [];
    const openTodos = extra?.openTodos ?? new Map();
    const pendingDrafts = extra?.pendingDrafts ?? new Map();
    return {rules, openTodos, pendingDrafts};
  },

  /** Newest batch for a conversation, whatever its state — "all" scope shows history too. */
  latestBatch(key) {
    return db.prepare('SELECT * FROM message_batch WHERE conversation_key = ? ORDER BY created_at DESC LIMIT 1').get(key) ?? null;
  },

  actionsFor(batchId) {
    if (!batchId) return [];
    return db.prepare('SELECT * FROM message_action WHERE batch_id = ? ORDER BY created_at DESC').all(batchId);
  },

  /**
   * The most recent thing the user did with this conversation.
   *
   * `rowid` breaks ties: several actions land in the same second when the user clicks quickly
   * (their own log shows three mark_seen within one second), and `ORDER BY created_at` alone
   * then returns an arbitrary one — so "what did they do last" was not deterministic.
   *
   * 「今天要做的」 reads this: 稍后处理 puts a conversation on that list, and ANY later action
   * — 标为已看, 处理完成 — is the user saying they are done with it, which takes it off the
   * list again. Keeping it as one shared lookup is what stops the queue's row state and the
   * today list from disagreeing about the same conversation.
   */
  latestAction(key) {
    return db.prepare(`SELECT action_type FROM message_action WHERE conversation_key = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(key) ?? null;
  },

  /** Project one conversation into the row the queue renders. Pure given its inputs. */
  compose(row, {rules, openTodos, pendingDrafts}) {
    const batch = this.latestBatch(row.conversation_key);
    const rule = rules.find(entry => entry.provider === row.provider && entry.conversation === row.conversation) ?? null;
    const todos = openTodos.get(row.conversation_key) ?? 0;
    const drafts = pendingDrafts.get(row.conversation_key) ?? 0;
    const classification = batch?.classification ?? 'unknown';
    const classified = (batch?.classification_version ?? 0) > 0;
    const automationState = !rule ? 'off'
      : rule.status === 'blocked' || rule.status === 'waiting_connection' ? 'problem'
        : rule.enabled ? 'active' : 'paused';
    let actionState = 'none';
    if (drafts > 0) actionState = 'draft_pending';
    else if (todos > 0) actionState = 'todo_open';
    // Same lookup 「今天要做的」 uses. Scanning the batch's actions instead kept saying
    // "deferred" after the user had already marked it seen, so the row and the today list
    // disagreed about the same conversation.
    else if (this.latestAction(row.conversation_key)?.action_type === 'defer') actionState = 'deferred';
    else if (batch && batch.state === 'reviewed') actionState = 'done';
    const automationProblem = automationState === 'problem';
    // The queue group a row is displayed under. Computed here (not in the browser) so it is
    // testable and so an unclassified row has exactly one group instead of matching every
    // group's predicate and rendering once per group.
    const group = classified ? classification : 'unknown';
    const item = {
      key: row.conversation_key,
      batchId: batch?.id ?? null,
      identity: {provider: row.provider, conversation: row.conversation, title: row.display_name, kind: row.kind},
      firstMessageAt: batch?.first_message_at ?? null,
      lastActivityAt: batch?.last_message_at ?? row.last_activity_at ?? null,
      observedAt: row.observed_at,
      // null means "not read yet". The UI must not turn that into a number.
      newCount: batch?.message_count ?? null,
      read: !!batch?.read_at,
      reading: row.observation_state,
      classified,
      classification,
      group,
      classificationReason: batch?.classification_reason ?? '',
      // Empty on the happy path. Non-empty means the last attempt failed and the batch is
      // still pending — the developer view renders it, the queue just keeps showing 待判断.
      classificationError: parseClassificationError(batch?.classification_error),
      summary: parseSummary(batch?.summary),
      batchState: batch?.state ?? null,
      actionState,
      automationState,
      automationProblem,
      automationDetail: rule ? (rule.detail ?? '') : '',
      openTodos: todos,
      pendingDrafts: drafts,
      following: !!row.following
    };
    item.attention = !!batch && (
      (batch.state === 'open' && (ATTENTION_CLASSES.has(classification) || !classified))
      || drafts > 0
    ) || automationProblem;
    return item;
  },

  /**
   * The queue. `scope` is the page-level choice (待我处理 / 新消息 / 全部); `order`
   * switches between the AI-suggested priority order and plain recency.
   */
  list({scope = 'attention', order = 'priority', limit = 30, cursor, extra} = {}) {
    if (!SCOPES.includes(scope)) throw Object.assign(new Error('未知的范围：' + scope), {code: 'CONTEXT_INVALID'});
    if (!ORDERS.includes(order)) throw Object.assign(new Error('未知的排序：' + order), {code: 'CONTEXT_INVALID'});
    const context = this.decorate(extra);
    let items = db.prepare('SELECT * FROM conversation_activity ORDER BY observed_at DESC').all()
      .map(row => this.compose(row, context));
    // Ignored conversations (following=false) stay out of the active queues; 「全部」 still
    // shows them so the user can restore one.
    const following = items.filter(item => item.following);
    const counts = {
      attention: following.filter(item => item.attention).length,
      unread: following.filter(item => item.reading === 'new').length,
      reply: following.filter(item => item.classified && item.classification === 'reply').length,
      action: following.filter(item => item.classified && item.classification === 'action').length,
      undecided: following.filter(item => !item.classified && item.reading === 'new').length,
      ignored: items.length - following.length
    };
    if (scope === 'attention') items = following.filter(item => item.attention);
    else if (scope === 'new') items = following.filter(item => item.reading === 'new');
    if (order === 'priority') {
      items.sort((a, b) => priorityRank(a) - priorityRank(b)
        || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.key.localeCompare(b.key));
    } else {
      items.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
        || a.key.localeCompare(b.key));
    }
    // observedAt changes on every harmless list scan. It must not affect ordering or
    // cursors, otherwise the browser sees a different list every five seconds.
    const signature = item => `${item.lastActivityAt ?? 0}:${item.key}`;
    let start = 0;
    if (cursor) {
      const index = items.findIndex(item => signature(item) === cursor);
      if (index === -1) throw Object.assign(new Error('分页位置已失效，请刷新列表'), {code: 'INBOX_CURSOR_STALE'});
      start = index + 1;
    }
    const page = items.slice(start, start + limit);
    const last = page.at(-1);
    return {
      items: page,
      counts,
      nextCursor: start + limit < items.length && last ? signature(last) : null
    };
  },

  detail(key) {
    const row = activity(key);
    if (!row) throw Object.assign(new Error('还没有关注这个会话'), {code: 'CONVERSATION_NOT_FOUND'});
    const batches = db.prepare('SELECT * FROM message_batch WHERE conversation_key = ? ORDER BY created_at DESC LIMIT 10').all(key);
    const snapshot = db.prepare('SELECT * FROM message_snapshot WHERE conversation_key = ? ORDER BY observed_at DESC LIMIT 1').get(key) ?? null;
    return {
      activity: row,
      batches: batches.map(batch => ({...batch, summary: parseSummary(batch.summary)})),
      actions: batches.flatMap(batch => this.actionsFor(batch.id).map(entry => ({...entry, batchId: batch.id}))),
      messages: snapshot ? JSON.parse(snapshot.messages_json) : [],
      messagesReadAt: snapshot?.observed_at ?? null
    };
  },

  openBatch(key) {
    return db.prepare("SELECT * FROM message_batch WHERE conversation_key = ? AND state = 'open' ORDER BY created_at DESC LIMIT 1").get(key) ?? null;
  },

  recordAction(key, type, {batchId, linkedObjectId, note = ''} = {}, at = clock()) {
    const batch = batchId ? {id: batchId} : (this.openBatch(key) ?? this.latestBatch(key));
    db.prepare(`INSERT INTO message_action
      (id, batch_id, conversation_key, action_type, action_state, linked_object_id, note, created_at, completed_at)
      VALUES (?, ?, ?, ?, 'done', ?, ?, ?, ?)`)
      .run(randomUUID(), batch?.id ?? '', key, type, linkedObjectId ?? null, String(note).slice(0, 500), at, at);
    return batch?.id ?? null;
  },

  /** "I looked at it." Only the reading state moves; open work stays open (doc §6.2). */
  markSeen(key, at = clock()) {
    const batch = this.openBatch(key);
    if (batch) db.prepare("UPDATE message_batch SET state = 'reviewed' WHERE id = ?").run(batch.id);
    db.prepare("UPDATE conversation_activity SET observation_state = 'seen', last_seen_at = ? WHERE conversation_key = ?").run(at, key);
    this.recordAction(key, 'mark_seen', {batchId: batch?.id}, at);
    return true;
  },

  defer(key, {note = ''} = {}, at = clock()) {
    const batch = this.openBatch(key);
    if (batch) db.prepare("UPDATE message_batch SET state = 'reviewed' WHERE id = ?").run(batch.id);
    db.prepare("UPDATE conversation_activity SET observation_state = 'seen' WHERE conversation_key = ?").run(key);
    this.recordAction(key, 'defer', {batchId: batch?.id, note}, at);
    return true;
  },

  complete(key, {note = ''} = {}, at = clock()) {
    const batch = this.openBatch(key);
    if (batch) db.prepare("UPDATE message_batch SET state = 'reviewed' WHERE id = ?").run(batch.id);
    db.prepare("UPDATE conversation_activity SET observation_state = 'seen', last_processed_at = ? WHERE conversation_key = ?").run(at, key);
    this.recordAction(key, 'complete', {batchId: batch?.id, note}, at);
    return true;
  },

  /** A durable record of "I already turned this into a to-do / follow-up / draft". */
  linkAction(key, type, {linkedObjectId, note = ''} = {}, at = clock()) {
    if (!ACTIONS.includes(type)) throw Object.assign(new Error('未知的处理方式'), {code: 'CONTEXT_INVALID'});
    return this.recordAction(key, type, {linkedObjectId, note}, at);
  },

  /**
   * The user disagreed with the assistant. Recorded as a correction, never as a silent
   * rewrite of any global rule (doc §10.4) — the row is what a future personalisation
   * pass would read, and today it just stops the same wrong suggestion coming back.
   */
  reclassify(key, {classification, reason = ''}, at = clock()) {
    if (!CLASSIFICATIONS.includes(classification)) throw Object.assign(new Error('未知的分类'), {code: 'CONTEXT_INVALID'});
    const batch = this.openBatch(key) ?? this.latestBatch(key);
    if (!batch) throw Object.assign(new Error('这个会话还没有新的消息动态'), {code: 'CONVERSATION_NOT_FOUND'});
    db.prepare('UPDATE message_batch SET classification = ?, classification_reason = ?, classification_version = ?, classified_at = ? WHERE id = ?')
      .run(classification, String(reason).slice(0, 300), batch.classification_version + 1, at, batch.id);
    db.prepare(`INSERT INTO triage_feedback (id, batch_id, conversation_key, predicted_class, final_user_action, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), batch.id, key, batch.classification, classification, String(reason).slice(0, 300), at);
    return this.latestBatch(key);
  },

  /**
   * Store a real Runtime snapshot and derive how much of it is new.
   *
   * Called only after an actual read of the chat, so this is the single place a message
   * count becomes known. The messages themselves are the authority for "what did they
   * say" — never a model's memory of the session.
   */
  attachSnapshot(key, messages, at = clock()) {
    const list = Array.isArray(messages) ? messages.filter(m => m && typeof m.content === 'string').slice(-60) : [];
    const previous = db.prepare('SELECT * FROM message_snapshot WHERE conversation_key = ? ORDER BY observed_at DESC LIMIT 1').get(key);
    const before = previous ? JSON.parse(previous.messages_json) : [];
    const count = newMessageCount(before, list);
    db.prepare('INSERT INTO message_snapshot (conversation_key, observed_at, messages_json, message_count) VALUES (?, ?, ?, ?)')
      .run(key, at, JSON.stringify(list), count);
    const batch = this.openBatch(key) ?? this.latestBatch(key);
    // A read that actually happened clears the backoff, so one bad patch cannot leave the
    // conversation permanently deprioritised.
    if (batch) db.prepare(`UPDATE message_batch SET message_count = ?, read_at = ?, source_message_refs = ?,
      read_attempts = 0, read_failed_at = NULL WHERE id = ?`)
      .run(count, at, `snapshot:${at}`, batch.id);
    db.prepare("UPDATE conversation_activity SET new_message_count = ?, observation_state = 'seen', last_seen_at = ? WHERE conversation_key = ?")
      .run(count, at, key);
    return {count, messages: list};
  },

  /** Attach the AI summary and the four-way classification to a batch. */
  applyClassification(key, result, at = clock()) {
    const batch = this.openBatch(key) ?? this.latestBatch(key);
    if (!batch) throw Object.assign(new Error('这个会话还没有新的消息动态'), {code: 'CONVERSATION_NOT_FOUND'});
    const classification = CLASSIFICATIONS.includes(result?.classification) ? result.classification : 'unknown';
    const summary = (Array.isArray(result?.summary) ? result.summary : [])
      .filter(point => typeof point === 'string' && point.trim()).slice(0, 4)
      .map(point => point.trim().slice(0, 200));
    db.prepare(`UPDATE message_batch SET summary = ?, classification = ?, classification_reason = ?,
      classification_version = ?, classified_at = ?, classification_error = '' WHERE id = ?`)
      .run(JSON.stringify(summary), classification, String(result?.reason ?? '').slice(0, 300),
        batch.classification_version + 1, at, batch.id);
    return {...this.latestBatch(key), summary};
  },

  /**
   * Remember why a classification attempt produced nothing.
   *
   * classification_version is deliberately NOT bumped: an attempt that failed is not a
   * classification, so the batch stays pending and the next poll retries it. What is stored
   * is the reason, so the row can explain itself instead of sitting at 待判断 silently.
   */
  markClassificationFailed(key, {code = 'TRIAGE_FAILED', detail = '', message = ''} = {}, at = clock()) {
    const batch = this.openBatch(key) ?? this.latestBatch(key);
    if (!batch) return null;
    db.prepare('UPDATE message_batch SET classification_error = ? WHERE id = ?')
      .run(JSON.stringify({code, detail: String(detail).slice(0, 1000), message: String(message).slice(0, 500), at}),
        batch.id);
    return this.latestBatch(key);
  },

  /** Batches with real content that have not been classified yet, oldest first. */
  pendingClassification(limit = 2) {
    return db.prepare(`SELECT b.conversation_key FROM message_batch b
      JOIN conversation_activity a ON a.conversation_key = b.conversation_key
      WHERE b.classification_version = 0 AND b.read_at IS NOT NULL
      ORDER BY b.last_message_at ASC LIMIT ?`).all(Math.max(1, Math.min(limit, 10)))
      .map(row => row.conversation_key);
  },

  /**
   * Conversations showing new content whose body we have never read.
   *
   * This is the only thing that could justify opening a chat without the user asking, so it
   * must never be consulted on its own: opening a chat moves whatever they are looking at
   * and clears that chat's unread badge in WeChat. The caller has to check
   * `readBodiesEnabled()` first — that is the preference the settings page shows as
   * 「消息正文按需读取」. With it off (the default) bodies are read only when the user
   * opens a conversation, asks a question, or asks for a draft.
   *
   * "Never read" is judged on the newest batch: once a burst has been read, that
   * conversation stops being a candidate until something new opens a fresh batch.
   */
  pendingBackgroundRead(limit = 3) {
    // Failed attempts back off: 2 min, then 4, 8, 16, 32 (capped). Without it a conversation
    // that can never be read stays a candidate forever and the driver clicks its row on every
    // poll. Any later success clears the count (see `attachSnapshot`).
    return db.prepare(`SELECT a.conversation_key, a.provider, a.conversation FROM conversation_activity a
      JOIN message_batch b ON b.id = (SELECT id FROM message_batch
        WHERE conversation_key = a.conversation_key ORDER BY created_at DESC LIMIT 1)
      WHERE a.observation_state = 'new' AND a.following = 1 AND b.read_at IS NULL
        AND (b.read_failed_at IS NULL OR ? >= b.read_failed_at + 60 * (1 << MIN(b.read_attempts, 5)))
      ORDER BY a.last_activity_at ASC LIMIT ?`).all(clock(), Math.max(1, Math.min(limit, 10)));
  },

  /**
   * A background body read that did not happen.
   *
   * Recorded so the next poll does not immediately try again. `conversation_not_found` (the
   * conversation was renamed, or it is not in the visible list) never succeeds on its own, so
   * without this the same failing click repeats every five seconds indefinitely.
   */
  markReadFailed(key, at = clock()) {
    const batch = this.openBatch(key) ?? this.latestBatch(key);
    if (!batch) return null;
    db.prepare('UPDATE message_batch SET read_attempts = read_attempts + 1, read_failed_at = ? WHERE id = ?')
      .run(at, batch.id);
    return this.latestBatch(key);
  },

  /** Follow or stop following one conversation (doc §17). Unfollowed chats are not read. */
  setFollowing(key, following) {
    db.prepare('UPDATE conversation_activity SET following = ? WHERE conversation_key = ?').run(following ? 1 : 0, key);
    return activity(key);
  },

  /**
   * Conversations the user pushed to "later". A deferred item leaves the queue but must
   * not vanish: 「今天要做的」 picks these up, and the conversation keeps its place in
   * the message history (doc §5.1).
   */
  deferred() {
    // "I'll deal with it later" only holds until the user does something else with it. Marking
    // it seen or finishing it is them saying they are done — otherwise a conversation they
    // already handled in 「消息」 sits on this list forever, which is exactly what the person
    // using it reported. One shared lookup (`latestAction`), so the queue's row state and this
    // list can never disagree about the same conversation.
    const out = [];
    for (const row of db.prepare('SELECT * FROM conversation_activity ORDER BY observed_at DESC').all()) {
      if (this.latestAction(row.conversation_key)?.action_type !== 'defer') continue;
      const batch = this.latestBatch(row.conversation_key);
      out.push({
        key: row.conversation_key,
        identity: {provider: row.provider, conversation: row.conversation, title: row.display_name, kind: row.kind},
        since: batch?.first_message_at ?? row.last_activity_at,
        updatedAt: row.last_activity_at ?? row.observed_at,
        classification: batch?.classification ?? 'unknown',
        summary: parseSummary(batch?.summary)
      });
    }
    return out;
  },

  /** Give up on a conversation entirely: drop what we recorded about it. */
  forget(key) {
    db.prepare('DELETE FROM message_batch WHERE conversation_key = ?').run(key);
    db.prepare('DELETE FROM message_action WHERE conversation_key = ?').run(key);
    db.prepare('DELETE FROM message_snapshot WHERE conversation_key = ?').run(key);
    db.prepare('DELETE FROM triage_feedback WHERE conversation_key = ?').run(key);
    db.prepare('DELETE FROM conversation_activity WHERE conversation_key = ?').run(key);
    return true;
  },

  /**
   * Host-side policy for the message centre. `read_bodies` is the significant one:
   * opening a chat clears its unread badge in WeChat, so summarising content is a real,
   * visible cost the user has to opt into rather than something we spend on their behalf.
   */
  preference(name, fallback = null) {
    const row = db.prepare('SELECT value FROM center_preference WHERE key = ?').get(name);
    return row ? row.value : fallback;
  },

  setPreference(name, value, at = clock()) {
    db.prepare(`INSERT INTO center_preference (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(String(name).slice(0, 60), String(value).slice(0, 200), at);
    return this.preference(name);
  },

  readBodiesEnabled() {
    return this.preference('read_bodies', '0') === '1';
  },

  close() {
    db.close();
  }
  };
}

function parseSummary(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Stored failure record → object (or null). Never throws on a legacy/blank value. */
function parseClassificationError(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {message: String(value)};
  } catch {
    return {message: String(value)};
  }
}

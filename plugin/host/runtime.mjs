/**
 * Server-side adapter for the message stack (architecture §3 RuntimeAdapter).
 * It fronts the Worker's loopback control API, which owns the Runtime MCP connection.
 * The bearer token never leaves the Host: the browser only talks to the same-origin
 * product API, never to the Worker or Runtime directly.
 */
export class RuntimeAdapter {
  constructor({controlPort, token, timeoutMs = 95000}) {
    this.controlPort = controlPort;
    this.token = token;
    this.timeoutMs = timeoutMs;
  }
  async #call(method, path, data, timeoutMs = this.timeoutMs) {
    let upstream;
    try {
      upstream = await fetch(`http://127.0.0.1:${this.controlPort}${path}`, {
        method,
        headers: {Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json'},
        body: data === undefined ? undefined : JSON.stringify(data),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (cause) {
      // A refused connection is not the same as a slow one, and the caller used to lose
      // the distinction entirely: both became "消息监听服务不可用" with nothing attached.
      throw Object.assign(new Error('消息监听服务不可用'), {
        code: 'WORKER_UNAVAILABLE',
        dev: {code: 'WORKER_UNAVAILABLE', message: String(cause?.message ?? cause),
              where: 'host->worker:' + path, at: new Date().toISOString()},
        cause
      });
    }
    const result = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      // Keep the upstream code: the product layer maps runtime codes (conversation_unverified,
      // wechat_in_use, …) to a plain sentence. Flattening it to WORKER_ERROR lost that and
      // showed the user a raw code instead. `dev` carries the worker's own diagnostics
      // block through untouched — the developer view is the only consumer.
      //
      // `result.message` also counts as an upstream explanation: 有些接口（例如读取微信密钥）
      // 用的是 {ok:false, message} 这种形状，只认 `error` 会把它换成一句"消息服务请求失败"，
      // 用户就看不到"为什么没读到"。实测踩到。
      throw Object.assign(new Error(result.error || result.message || '消息服务请求失败'),
        {code: result.code || 'WORKER_ERROR', status: upstream.status,
         detail: result.detail ?? '', dev: result.dev ?? null});
    }
    return result;
  }
  /** Local control-plane state (rules, recent jobs). Never triggers a WeChat read. */
  status() {
    return this.#call('GET', '/api/status');
  }
  /**
   * 用户可改的运行时设置（各任务的模型选择、值守开关…）。
   * 纯本地状态，不碰微信；Host 侧要用这些配置时从这里读，不自己另存一份。
   */
  settings() {
    return this.#call('GET', '/api/settings');
  }
  /** Explicit visible-list read. Callers must treat this as a user-initiated sync only. */
  listConversations() {
    return this.#call('GET', '/api/conversations');
  }
  /**
   * Cached discovery result for the visible conversation list. The Worker refreshes it
   * once per poll cycle; calling this never turns into another WeChat read, which is why
   * the message centre can poll it freely.
   */
  observe() {
    return this.#call('GET', '/api/observe');
  }
  /** User-initiated visible-list refresh. Never called by page polling. */
  refreshObservation() {
    return this.#call('POST', '/api/observe/refresh', {});
  }
  /**
   * Read one conversation's latest messages. This DOES open the chat, so it is only ever
   * called for a conversation the user asked about (or when they explicitly allowed the
   * assistant to read bodies). In WeChat an opened chat loses its unread badge.
   */
  readConversation({provider, conversation, title, limit, backgroundOnly = false}) {
    return this.#call('POST', '/api/read', {provider, conversation_id: conversation,
      conversation_title: title, limit, background_only: backgroundOnly});
  }
  /**
   * Read one conversation's recent messages from the decrypted local DB (username 定位),
   * instead of OCR-opening the chat. Used by style analysis and other read-only features
   * that no longer need the UI. Never opens a chat, never touches the foreground.
   */
  readConversationFromDb({username, limit}) {
    return this.#call('POST', '/api/db_messages', {username, limit});
  }
  /** Local-DB contact search (remark/nick_name/username). No OCR, no WeChat foreground. */
  searchContacts(keyword) {
    return this.#call('POST', '/api/search_contacts', {keyword});
  }
  /**
   * 首页与整理的数据底座：一次拿回「最近有动静的若干会话 + 各自最近消息」。
   *
   * 纯数据库读取：不打开会话、不切前台、不清未读。整个首页的"关键信息"都建立在
   * 这一次调用上，所以它必须便宜 —— 也正是它取代了原来的 `refreshObservation()`
   * （那一次是 OCR 全窗截图 + 逐行识别）。
   */
  dbRecent({sessions = 12, perSession = 20} = {}) {
    return this.#call('POST', '/api/db_recent', {sessions, per_session: perSession});
  }
  /** Compatibility shim: continuous inbox discovery no longer exists. */
  setObserving(enabled) {
    return this.#call('POST', '/api/settings', {observe_enabled: !!enabled});
  }
  /**
   * Actually send a message through the trusted worker path. origin=user_request is the
   * honest classification here: the user just confirmed this exact draft. Returns the
   * Runtime receipt; the caller maps its status to a draft state and never resends on
   * "uncertain".
   */
  sendMessage({provider, conversation, text, requestId}) {
    return this.#call('POST', '/api/send', {provider, conversation_id: conversation, text, request_id: requestId});
  }
  /**
   * 微信数据库密钥的状态：有没有、上次什么时候读的、明文残留清没清。
   * 纯本地状态读取，不碰微信进程，也不返回密钥内容。
   */
  wechatKeys() {
    return this.#call('GET', '/api/wechat-keys');
  }
  /**
   * **用户点了授权按钮**才会调这里：读一次微信进程内存取出数据库密钥。
   * 这是整套流程里唯一读进程内存的入口，所以超时给得比别的调用长（要跑一次解锁）。
   */
  scanWechatKeys({force = false} = {}) {
    return this.#call('POST', '/api/wechat-keys/scan', {force}, 180000);
  }
}

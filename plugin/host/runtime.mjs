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
  async #call(method, path, data) {
    let upstream;
    try {
      upstream = await fetch(`http://127.0.0.1:${this.controlPort}${path}`, {
        method,
        headers: {Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json'},
        body: data === undefined ? undefined : JSON.stringify(data),
        signal: AbortSignal.timeout(this.timeoutMs)
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
      throw Object.assign(new Error(result.error || '消息服务请求失败'),
        {code: result.code || 'WORKER_ERROR', status: upstream.status,
         detail: result.detail ?? '', dev: result.dev ?? null});
    }
    return result;
  }
  /** Local control-plane state (rules, recent jobs). Never triggers a WeChat read. */
  status() {
    return this.#call('GET', '/api/status');
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
  readConversation({provider, conversation, title, limit}) {
    return this.#call('POST', '/api/read', {provider, conversation_id: conversation,
      conversation_title: title, limit});
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
}

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
    } catch {
      throw Object.assign(new Error('消息监听服务不可用'), {code: 'WORKER_UNAVAILABLE'});
    }
    const result = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      throw Object.assign(new Error(result.error || '消息服务请求失败'), {code: 'WORKER_ERROR', status: upstream.status});
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
}

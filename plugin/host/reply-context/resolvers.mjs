/**
 * Live data resolvers (spec §5.4). Order status, shipment, inventory, quote validity and
 * account balance must be queried from the business system at reply time, with an observed
 * and an expiry timestamp — they are never written as permanent knowledge entries.
 *
 * Only the Host-side resolver holds business-system credentials. A resolver receives its
 * identity from the server-side conversation binding, never from the model, so the model
 * cannot widen a query by inventing an order number or account id (spec §5.4).
 *
 * With no resolver configured for a kind, the answer is `unavailable` — the context builder
 * must then refuse to fabricate a status and route to a human instead of guessing from
 * history (spec §5.4, §21.4).
 */

export const LIVE_KINDS = ['order', 'shipment', 'inventory', 'quote', 'account'];

export function createResolverRegistry() {
  const resolvers = new Map();
  return {
    register(kind, fn) {
      if (typeof kind !== 'string' || typeof fn !== 'function') throw new Error('resolver must be a function');
      resolvers.set(kind, fn);
    },
    has(kind) {
      return resolvers.has(kind);
    },
    async resolve(request) {
      const kind = request?.kind;
      const fn = resolvers.get(kind);
      if (!fn) {
        return { status: 'unavailable', facts: [], safeSummary: null, errorCode: 'NO_RESOLVER' };
      }
      try {
        const result = await fn(request);
        return normalizeResolverResult(result);
      } catch (error) {
        return { status: 'unavailable', facts: [], safeSummary: null, errorCode: 'RESOLVER_FAILED', detail: error?.message };
      }
    }
  };
}

function normalizeResolverResult(result) {
  if (!result || typeof result !== 'object') return { status: 'unavailable', facts: [], safeSummary: null, errorCode: 'BAD_RESULT' };
  const status = ['resolved', 'not_found', 'ambiguous', 'unavailable'].includes(result.status) ? result.status : 'unavailable';
  const facts = Array.isArray(result.facts) ? result.facts : [];
  return {
    status,
    facts: facts.map(f => ({
      field: String(f.field ?? ''),
      value: f.value,
      observedAt: Number(f.observedAt ?? 0),
      expiresAt: f.expiresAt === undefined || f.expiresAt === null ? null : Number(f.expiresAt),
      sourceRef: String(f.sourceRef ?? '')
    })),
    safeSummary: typeof result.safeSummary === 'string' ? result.safeSummary : null,
    errorCode: result.errorCode ?? null
  };
}

/**
 * Structured trigger detection (spec §8 step 4). A conservative regex over the received
 * text finds order numbers and explicit live-data intents. The resolver is only consulted
 * when such a trigger fires; the identifiers come from the message text, but the query scope
 * is still the server-side conversation binding.
 */
export function detectLiveIntents(text) {
  const intents = [];
  if (/\b\d{6,}\b|订单|运单|快递|物流|发货/.test(text)) intents.push('shipment');
  if (/退款|退货|发票|售后|保修|退换/.test(text)) intents.push('order');
  if (/库存|有货|现货|缺货/.test(text)) intents.push('inventory');
  if (/报价|多少钱|价格|优惠|折扣/.test(text)) intents.push('quote');
  if (/余额|到账|付款|支付/.test(text)) intents.push('account');
  return [...new Set(intents)];
}

/** Extract candidate order/waybill identifiers from text (server-side scope only). */
export function extractIdentifiers(text) {
  const orders = (text.match(/\b\d{6,}\b/g) ?? []).slice(0, 5);
  return { orderNo: orders[0] ?? null, all: orders };
}

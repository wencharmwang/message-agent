/**
 * Evidence & Risk Gate (spec §10). Runs after the model submits a decision and before the
 * Host returns it to the Worker. It never calls a send tool and never silently rewrites the
 * reply's meaning — it can only route to needs_user (high risk / missing facts), reject
 * (format, credential leakage), or pass. Soft style preferences are never a blocking condition,
 * and a hard banned expression routes to a human rather than being string-replaced.
 *
 * The decision policy (§5.6) is independent of knowledge retrieval: hitting a knowledge item
 * does not lower a risk grade (spec §5.6, §6.1). For P0 this policy is a code-level default
 * with a single 'local' workspace; a per-workspace override table is a documented extension.
 */

export const RISK_GRADE = { L0: 0, L1: 1, L2: 2, L3: 3 };

/** Intent → risk grade (§5.6 table). */
export const INTENT_RISK = {
  social: 'L0', greeting: 'L0', acknowledge: 'L0',
  faq: 'L1', product_usage: 'L1',
  quote: 'L2', discount: 'L2', schedule: 'L2', commitment: 'L2', after_sale: 'L2',
  refund: 'L3', contract: 'L3', payment: 'L3', legal: 'L3', sensitive: 'L3'
};

/** Declared/derived risk tag → risk grade. A model cannot under-declare a high risk. */
export const RISK_TAG_LEVEL = {
  price: 'L2', discount: 'L2', commitment: 'L2', time: 'L2', after_sale: 'L2',
  refund: 'L3', contract: 'L3', account: 'L3', legal: 'L3', sensitive: 'L3'
};

export const DEFAULT_DECISION_POLICY = {
  workspaceId: 'local',
  // intents that may be answered unattended without specific evidence
  autoIntents: ['social', 'greeting', 'acknowledge'],
  // intents that may be answered only with a supporting evidence id
  evidenceIntents: ['faq', 'product_usage'],
  // intents that default to a draft or human decision
  draftIntents: ['quote', 'discount', 'schedule', 'commitment', 'after_sale'],
  // intents that must always be human
  humanIntents: ['refund', 'contract', 'payment', 'legal', 'sensitive'],
  // data sources the model is allowed to base a reply on
  allowedDataSources: ['static_knowledge', 'confirmed_memory', 'conversation'],
  allowQuote: false,
  allowSchedule: false,
  allowPromiseCallback: false,
  allowAfterSalePolicy: true
};

const INTENT_PATTERNS = [
  ['refund', /退款|退货|退钱|赔付|赔偿/],
  ['contract', /合同|协议|签约|盖章|法务/],
  ['payment', /付款|支付|转账|汇款|打款|账户|到账|收款/],
  ['legal', /法律责任|起诉|仲裁|律师函|违约|担责/],
  ['sensitive', /身份证|银行卡号|密码|验证码|住址|病历/],
  ['quote', /报价|多少钱|价格|单价|预算/],
  ['discount', /折扣|优惠|便宜|砍价|打折/],
  ['schedule', /预约|约定|安排时间|什么时候.{0,8}(见面|到达|交付|发货|出发)|几[号点].{0,8}(见|到|出发|交付)|约.{0,4}(见面|吃饭|时间)/],
  ['commitment', /保证|承诺|一定|肯定|包/],
  ['after_sale', /售后|保修|退换|发票|安装|维修/],
  ['product_usage', /怎么用|如何使用|说明书|操作|设置|教程/],
  // 「在问产品 / 在问事实」也算 faq：用户实测问「介绍产品形态」被判成 social（闲聊），
  // 于是模型可以随便聊 —— 而这类问题恰恰是知识库存在的意义。
  ['faq', /营业时间|地址|电话|流程|政策|规定|是否支持|能不能|产品|功能|服务|文档|资料|方案|介绍|是什么|有哪些|哪些|怎么样|好不好/],
  ['greeting', /^(你好|您好|hi|hello|在吗|早上好|晚上好|早安|晚安)/i],
  ['acknowledge', /^(好的|收到|ok|明白|了解|谢谢|感谢)/i],
  ['social', /.*/]
];

/** Classify a received message into an intent from the policy vocabulary (order matters). */
export function classifyIntent(text) {
  const value = String(text ?? '').trim();
  for (const [intent, re] of INTENT_PATTERNS) {
    if (re.test(value)) return intent;
  }
  return 'social';
}

/** Conservative, order-independent detection of high-risk signals in reply text. */
export function detectRiskTags(text) {
  const tags = new Set();
  const value = String(text ?? '');
  if (/[¥￥]\s*\d|元|块|报价|价格|单价|金额|折扣|优惠/.test(value)) tags.add('price');
  if (/折扣|优惠|便宜|打折|砍价/.test(value)) tags.add('discount');
  if (/保证|承诺|一定|肯定|今天.{0,6}发|马上.{0,4}到账|绝对/.test(value)) tags.add('commitment');
  // A calendar reference is not a promise: birthdays, weather and greetings
  // must not require evidence merely because they contain 今天/月/年.
  if (/预约|约定|安排时间|定在.{0,8}(今天|明天|周|点|号)/.test(value)
      || /(?:今天|明天|后天|下周|周[一二三四五六日天]|\d{1,2}[月号点]).{0,8}(?:我会|我来|我去|给你|帮你|陪你|接你|送你|发货|交付|到货|到账|完成)/.test(value)
      || /(?:我会|我来|我去|我答应|我保证|保证|承诺).{0,8}(?:今天|明天|后天|下周|周[一二三四五六日天]|\d{1,2}[月号点])/.test(value)) tags.add('time');
  if (/退款|退货|退钱|赔付/.test(value)) tags.add('refund');
  if (/合同|协议|签约/.test(value)) tags.add('contract');
  if (/付款|支付|转账|账户|到账|收款|汇款/.test(value)) tags.add('account');
  if (/法律|起诉|仲裁|担责|违约/.test(value)) tags.add('legal');
  if (/身份证|银行卡号|密码|验证码/.test(value)) tags.add('sensitive');
  if (/售后|保修|退换|发票/.test(value)) tags.add('after_sale');
  return [...tags];
}

export function maxRiskGrade(tags = []) {
  let grade = 'L0';
  for (const tag of tags) {
    const level = RISK_TAG_LEVEL[tag];
    if (level && RISK_GRADE[level] > RISK_GRADE[grade]) grade = level;
  }
  return grade;
}

function reject(code, userMessage) {
  return { outcome: 'reject', reasonCode: code, userMessage, finalDecision: null };
}
function needsUser(code, userMessage, finalDecision) {
  return { outcome: 'needs_user', reasonCode: code, userMessage, finalDecision };
}
function pass(finalDecision) {
  return { outcome: 'pass', reasonCode: '', userMessage: '', finalDecision };
}

/**
 * Gate a submitted decision against this run's context. `run` carries the evidence catalog,
 * resolved live facts, the selected profile, and the detected intent/risk — the gate does not
 * trust the model's own self-declaration alone.
 */
export function evaluateGate({decision, run, policy = DEFAULT_DECISION_POLICY, at = Date.now() / 1000}) {
  const catalogIds = new Set((run.evidenceCatalog ?? []).map(e => e.id));
  const declaredEvidence = Array.isArray(decision.evidence_ids) ? decision.evidence_ids : [];

  // Evidence ids must belong to this run's catalog (spec §9).
  for (const id of declaredEvidence) {
    if (!catalogIds.has(id)) return reject('EVIDENCE_UNKNOWN', '回复引用了本轮上下文中不存在的依据，已拦截');
  }

  // Credential leakage is a hard reject, reply or not.
  if (/\bsk-[A-Za-z0-9_-]{16,}\b/.test(decision.text ?? '')) {
    return reject('CREDENTIAL_LEAK', '回复中包含凭据，已拦截');
  }

  if (decision.action !== 'reply') return pass(decision);

  const profile = run.contextPack?.profile ?? {};
  // Hard banned expressions route to a human; never silently rewritten (§10).
  const banned = Array.isArray(profile.bannedExpressions) ? profile.bannedExpressions : [];
  const hit = banned.find(w => w && (decision.text ?? '').includes(w));
  if (hit) return needsUser('HARD_BANNED_WORD', '回复命中了你设定的禁用表达，需要你确认', toNeedsUser(decision));

  // Live facts must still be inside their validity window (§10).
  const liveFacts = run.liveFacts ?? [];
  if (liveFacts.some(f => f.expiresAt !== null && f.expiresAt !== undefined && f.expiresAt <= at)) {
    return needsUser('LIVE_DATA_EXPIRED', '这条回复用到的实时数据已经过期，需要你确认', toNeedsUser(decision));
  }

  const tags = [...new Set([...(decision.risk_tags ?? []), ...(run.detectedRiskTags ?? []),
    ...detectRiskTags(decision.text ?? '')])];
  const grade = maxRiskGrade(tags);
  const hasEvidence = declaredEvidence.length > 0;
  const intent = decision.intent ?? run.detectedIntent ?? classifyIntent(run.currentQuestion ?? '');

  // A live-data question (order/shipment/quote/…) that no resolver could answer must go to a
  // human — never guessed from static knowledge or old messages (spec §5.4, §21.4).
  const unresolvedLive = run.unresolvedLiveIntents ?? [];
  if (unresolvedLive.length && !declaredEvidence.some(id => catalogIds.has(id) && id.startsWith('ev_live_'))) {
    return needsUser('UNSUPPORTED_LIVE', '这条回复涉及订单、物流、报价等实时信息，但当前没有接入对应数据源，需要你确认', toNeedsUser(decision));
  }

  // L3 is always human (spec §5.6), knowledge hit or not.
  if (grade === 'L3' || policy.humanIntents.includes(intent)) {
    return needsUser('MUST_HUMAN', '这条回复涉及退款、合同、付款或敏感信息，需要你本人决定', toNeedsUser(decision));
  }

  // L2 needs a supporting evidence id; knowledge presence alone never lowers the grade.
  if (grade === 'L2' || policy.draftIntents.includes(intent)) {
    if (!hasEvidence) return needsUser('EVIDENCE_REQUIRED', '这条回复包含金额、时间或承诺，但没有可核验的依据，需要你确认', toNeedsUser(decision));
  }

  // Unauthorized commitments without evidence (spec §10.5).
  if (/一定|保证|今天.{0,6}发|马上.{0,4}到账|肯定.{0,4}到账|绝对/.test(decision.text ?? '') && !hasEvidence) {
    return needsUser('UNSUPPORTED_COMMITMENT', '回复里有未经证实的承诺，需要你确认', toNeedsUser(decision));
  }

  return pass(decision);
}

function toNeedsUser(decision) {
  return { ...decision, action: 'needs_user', text: '' };
}

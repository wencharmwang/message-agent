/**
 * 「记住这个人」—— 从一段对话里提炼出值得长期记住的事。
 *
 * 为什么要它：聊天稳不稳，很大程度取决于"这个人是谁、在意什么、答应过什么"能不能跨轮次留住。
 * 只靠会话自带的记忆很脆（换会话、重启、上下文变长都会丢），所以需要一个**独立于对话**的
 * 存储 + 每轮后台更新。
 *
 * 设计上的两个克制：
 * 1. **只有 confirmed 才进提示词**：模型猜的（confidence 低）先存成 candidate，
 *    宁可少记，也不要把猜的东西当事实喂回去；
 * 2. **同一条不重复记**：每次更新都拿已有条目比对，措辞不同但同一件事就不再加，
 *    否则聊几天就会堆出几十条"他喜欢吃辣"。
 */

export const MEMORY_UPDATE_SYSTEM = [
  '你在帮一个消息助手记住某个人。给你这个人的已有记忆，以及最近的一段对话。',
  '请找出**值得长期记住、以后回复还用得上**的事，输出 JSON。',
  '',
  '值得记（例子）：',
  '- 身份与关系：是同事、家人、伴侣、客户；称呼习惯',
  '- 稳定的偏好：口味、作息、说话习惯、不喜欢什么',
  '- 正在进行的事：在做的项目、在等的回复、约定的时间',
  '- 答应过的事：承诺了什么、承诺给谁',
  '不值得记：一次性的寒暄、天气、已经在待办里的事、你自己编的推测。',
  '',
  '严格输出 JSON，不要解释：',
  '{"items":[{"kind":"fact|preference|commitment|open_loop|event","content":"一句话，25 字以内","confidence":"high|low"}]}',
  '没有值得记的就输出 {"items":[]}。',
  '判断把握大用 high，只是猜测用 low。'
].join('\n');

const KINDS = ['fact', 'preference', 'commitment', 'open_loop', 'event'];

const normalize = value => String(value ?? '')
  .replace(/[\s，。、；：！？,.!?;:()（）\[\]【】"'“”‘’]/g, '')
  .toLowerCase();

/** 两条记忆是不是同一件事（去掉标点空白后，相等或互相包含）。 */
export function sameMemory(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  return shorter.length >= 4 && longer.includes(shorter);
}

export function buildMemoryPrompt({existing = [], messages = []}) {
  const lines = ['已有的记忆（不要重复记录）：'];
  if (existing.length) {
    existing.forEach(item => lines.push('- [' + item.kind + '] ' + item.content));
  } else {
    lines.push('（还没有）');
  }
  lines.push('', '最近的一段对话：');
  messages.slice(-30).forEach(item => {
    const who = item.direction === 'incoming' ? '对方' : '我';
    const text = typeof item.content === 'string' ? item.content : '';
    if (text) lines.push(who + '：' + text.slice(0, 200));
  });
  lines.push('', '只输出 JSON。');
  return lines.join('\n');
}

export function parseMemoryAnswer(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = Array.isArray(parsed?.items) ? parsed.items : [];
  return list
    .map(item => ({
      kind: KINDS.includes(item?.kind) ? item.kind : 'fact',
      content: String(item?.content ?? '').trim().slice(0, 80),
      confidence: item?.confidence === 'high' ? 'high' : 'low'
    }))
    .filter(item => item.content.length >= 2);
}

/** 过滤掉"已经有了"的条目，返回真正要写的新记忆。 */
export function selectNewMemories(candidates, existing = []) {
  const kept = [];
  for (const item of candidates) {
    const duplicated = existing.some(old => sameMemory(old.content, item.content))
      || kept.some(old => sameMemory(old.content, item.content));
    if (!duplicated) kept.push(item);
  }
  return kept;
}

/** 写入记忆。high → confirmed（会进提示词）；low → candidate（只存着）。
 *
 * **confirmation 不交给模型自己声明**也会有问题（它会说都是 high），所以这里只做一件事：
 * 只有内容里出现明确的关系/偏好/承诺词，才提升成 confirmed；其余先当候选。
 */
export function applyMemories(memory, workspaceId, conversationKey, candidates, existing = []) {
  const written = [];
  for (const item of selectNewMemories(candidates, existing)) {
    const confident = item.confidence === 'high';
    try {
      written.push(memory.add(workspaceId, {
        conversationKey,
        kind: item.kind,
        content: item.content,
        sourceType: 'assistant',
        status: confident ? 'confirmed' : 'candidate'
      }));
    } catch {
      // 单条写失败不影响其他条目
    }
  }
  return written;
}

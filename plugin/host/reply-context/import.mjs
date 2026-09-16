/**
 * 批量导入：把用户手上已有的资料切成知识条目。
 *
 * 产品与政策往往早就存在——脑子里的经验、写好的文档、在线文档、网站条款。
 * 要求用户一条条手敲不现实，所以这里做机械切分：快、可预期、不消耗模型额度。
 * 切分只负责「分条 + 取标题」，正文原样保留，导入后仍可逐条编辑。
 *
 * 切分天然主观——一份大纲文档该整篇一条还是一个章节一条，没有唯一正解。
 * 所以提供 mode 让用户自己定，默认 auto 取最保守的一档（宁可少切，不要切碎）。
 */

const CONTENT_MAX = 20000;
const TITLE_MAX = 200;
const MAX_ITEMS = 60;
const FETCH_TIMEOUT_MS = 20000;

export const IMPORT_LIMITS = { MAX_ITEMS, CONTENT_MAX, TITLE_MAX };
export const SPLIT_MODES = ['auto', 'item', 'block'];

class ImportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** 抓取网页正文。静态页够用；需要 JS 渲染的站点抓不到，会提示用户改为粘贴。 */
export async function fetchPageText(url) {
  const target = String(url ?? '').trim();
  if (!/^https?:\/\/\S+$/i.test(target)) throw new ImportError('IMPORT_BAD_URL', '请填写以 http 开头的完整网址');
  let response;
  try {
    response = await fetch(target, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; message-agent/1.0)', 'accept-language': 'zh-CN,zh;q=0.9' }
    });
  } catch {
    throw new ImportError('IMPORT_FETCH_FAILED', '打不开这个网址，请检查网络，或改为直接粘贴正文');
  }
  if (!response.ok) throw new ImportError('IMPORT_FETCH_FAILED', `这个网址返回了 ${response.status}，抓不到内容`);
  const type = response.headers.get('content-type') ?? '';
  if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) {
    throw new ImportError('IMPORT_UNSUPPORTED_TYPE', '这个链接不是网页（可能是文档或附件），请把正文复制过来');
  }
  const html = await response.text();
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim());
  return { title: title.slice(0, TITLE_MAX), text: htmlToText(html) };
}

/** 粗略去标签：保留段落与列表的换行结构，够喂给切分器。 */
export function htmlToText(html) {
  const stripped = String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|head|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote)\s*>/gi, '\n')
    .replace(/<\/(td|th)\s*>/gi, '\t')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(stripped)
    .split('\n')
    .map(line => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)));
}

const isHeadingLine = line => /^#{1,6}\s+\S/.test(line);
const isRuleLine = line => /^(?:[-*_]\s*){3,}$/.test(line);
const isFenceLine = line => /^```/.test(line);
const isBulletLine = line => /^\s*[-*·•]\s+\S/.test(line);
const isNumberedLine = line => /^\s*\d+[.、)）]\s+\S/.test(line);

/**
 * 切分成条目。
 *
 * mode:
 * - `auto`（默认，最保守）：Markdown 标题 → 标题作条目标题；`---` 显式分条；
 *   空行分段（短段落当小标题吸附下一段）；只有**无序列表**（`-`/`*`/`•`）且各项都有
 *   实质内容时才按项拆。有序列表（`1.` `2.`）**不拆**——它更常是文档大纲，拆开会把
 *   「1. 现状」「2. 目标」变成一堆失去上下文的碎片。
 * - `item`：有序、无序列表项都各成一条，适合「一批并列条目」。
 * - `block`：整篇作一条，适合一篇连贯文档。
 *
 * 无论哪种模式，围栏代码块（```）内部都原样保留、不参与结构判断——
 * 数据模型 / 字段清单被拆成一行一条毫无意义。
 */
export function splitKnowledge(raw, { maxItems = MAX_ITEMS, mode = 'auto' } = {}) {
  const source = String(raw ?? '').replace(/\r\n?/g, '\n').trim();
  if (!source) return [];
  const how = SPLIT_MODES.includes(mode) ? mode : 'auto';
  if (how === 'block') return [toItem('', source)];

  const chunks = [];
  let heading = '';
  let buffer = [];
  let sawHeading = false;
  let inFence = false;
  const flush = () => {
    const body = buffer.join('\n').trim();
    if (body) chunks.push({ heading: sawHeading ? heading : '', body });
    buffer = [];
  };
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (isFenceLine(trimmed)) {
      inFence = !inFence;
      buffer.push(line);
      continue;
    }
    if (inFence) {
      buffer.push(line);
      continue;
    }
    if (isHeadingLine(trimmed)) {
      flush();
      sawHeading = true;
      heading = trimmed.replace(/^#{1,6}\s+/, '').trim();
      continue;
    }
    if (isRuleLine(trimmed)) {
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();

  const blocks = sawHeading && chunks.length ? chunks : splitByParagraph(source, chunks);
  const items = [];
  for (const block of blocks) {
    const pieces = how === 'item' ? splitByAnyList(block.body) : explodeBullets(block.body);
    // 一块被拆成多条时，标题必须取各自首行——否则「# 常见问题」下会出来一串同名条目。
    const blockHeading = pieces.length > 1 ? '' : block.heading;
    for (const piece of pieces) {
      items.push(toItem(blockHeading, piece));
      if (items.length >= maxItems) return items;
    }
  }
  return items;
}

/** 没有 Markdown 标题时按空行分段；短段落（≤20 字、单行）作小标题吸附下一段。 */
function splitByParagraph(source, fallback) {
  const paragraphs = source.split(/\n{2,}/).map(part => part.trim()).filter(Boolean);
  if (paragraphs.length <= 1) return fallback.length ? fallback : [{ heading: '', body: source }];
  const blocks = [];
  for (let index = 0; index < paragraphs.length; index++) {
    const current = paragraphs[index];
    const next = paragraphs[index + 1];
    if (next && current.length <= 20 && !current.includes('\n')) {
      blocks.push({ heading: current, body: next });
      index++;
    } else {
      blocks.push({ heading: '', body: current });
    }
  }
  return blocks;
}

/**
 * 只有无序列表才值得拆，且要求大部分项都有实质内容。
 * 一份大纲（`1. 现状` `2. 目标` `3. 架构`）逐行拆开毫无意义，所以有序列表一律不拆。
 */
function explodeBullets(body) {
  const lines = body.split('\n');
  const bullets = lines.filter(line => isBulletLine(line));
  if (bullets.length < 3) return [body];
  const substantial = bullets.filter(line => line.trim().length >= 12).length;
  if (substantial < bullets.length * 0.6) return [body];
  return cutAt(lines, isBulletLine);
}

/** item 模式：有序、无序列表项都各成一条。 */
function splitByAnyList(body) {
  const lines = body.split('\n');
  const isItem = line => isBulletLine(line) || isNumberedLine(line);
  if (lines.filter(isItem).length < 2) return [body];
  return cutAt(lines, isItem);
}

/** 在每个"条目的第一行"处切开，前缀行（引导语）归到它后面那条。 */
function cutAt(lines, isItem) {
  const pieces = [];
  let current = [];
  for (const line of lines) {
    if (isItem(line) && current.length) {
      pieces.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) pieces.push(current.join('\n'));
  return pieces.map(piece => piece.trim()).filter(Boolean);
}

function toItem(heading, body) {
  const content = String(body ?? '').trim().slice(0, CONTENT_MAX);
  const firstLine = content.split('\n').map(line => line.trim()).find(Boolean) ?? '';
  // 只剥「- 」这类符号和「1. 」这种带空格的编号；`13.id` 这种不带空格的是内容，不能剥。
  const title = (heading || firstLine).replace(/^(?:[-*·•]\s*|\d+[.、)）]\s+)/, '').slice(0, TITLE_MAX) || '导入的条目';
  return { title, content };
}

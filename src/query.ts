import { applySgr, ANSI_SEQ_RE, splitAnsi, type SgrStyle } from "./ansi.ts";
import { msg, type MsgKey } from "./i18n.ts";
import type { PeekMsg, PeekSession } from "./sessions.ts";
import { stylePrefix, type PeekTheme } from "./theme.ts";

// 搜索框语法。空白分隔多个词，全部满足才算（AND）。每个词可以是：
//   foo            子串，大小写不敏感，在对话正文和会话名里找；不看工作目录（见 termHits）
//   "foo bar"      短语，引号里的一段空白匹配正文里任意一段空白（含换行）
//   a|b            任一命中（OR）；要搜字面的 | 就加引号
//   /re/           正则（JS 语法，自动带 i 和 m 标志，不能含空白，用 \s 代替）；写错了按普通文字搜
//   -foo           排除：命中的会话不显示。--foo 还是普通词，要搜以 - 开头的词就加引号
//   name:foo       只在会话名里找；cwd: / dir: 只看工作目录；user: / ai:（assistant:）只看对应角色的消息
//   @7d            只看最近 7 天活动过的会话，单位 h / d / w / m
// 前缀可以叠：-user:"foo bar"。引号是万能转义："-foo"、"a|b"、"name:x"、"/x/" 都按字面搜

export type Field = "any" | "name" | "cwd" | "user" | "assistant";

export interface Term {
  re: RegExp; // 带 g 和 i，直接在原文上匹配（不再把正文转小写：个别字符小写后长度会变，高亮位置就对不上）；用之前先把 lastIndex 归零
  negate: boolean;
  field: Field;
}

export interface ParsedQuery {
  terms: Term[];
  since: number; // 毫秒时间戳，0 表示不限
  sinceLabel: string;
}

const TIME_UNIT_MS: Record<string, number> = { h: 3600e3, d: 86400e3, w: 7 * 86400e3, m: 30 * 86400e3 };
const TIME_UNIT_LABEL: Record<string, MsgKey> = { h: "unitH", d: "unitD", w: "unitW", m: "unitM" };
const FIELD_ALIAS: Record<string, Field> = { name: "name", cwd: "cwd", dir: "cwd", user: "user", ai: "assistant", assistant: "assistant" };

// 按空白切分；带引号的词（前面可以有 - 和 name: 之类的前缀）里的空白不切，引号不闭合就一直到结尾。
// 引号只在词首算，foo"bar 是普通词
const TOKEN_RE = /-?(?:(?:name|cwd|dir|user|ai|assistant):)?"[^"]*"?|\S+/gi;
const FIELD_RE = /^(name|cwd|dir|user|ai|assistant):/i;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 单个词 → Term；空词（只剩前缀、空引号）返回 undefined。单个 - 是普通词
function parseTerm(raw: string): Term | undefined {
  let s = raw;
  let negate = false;
  if (s.length > 1 && s[0] === "-" && s[1] !== "-") {
    negate = true;
    s = s.slice(1);
  }
  let field: Field = "any";
  const f = FIELD_RE.exec(s);
  if (f) {
    field = FIELD_ALIAS[f[1].toLowerCase()];
    s = s.slice(f[0].length);
  }
  let re: RegExp;
  if (s.startsWith('"')) {
    const body = (s.length > 1 && s.endsWith('"') ? s.slice(1, -1) : s.slice(1)).trim();
    if (!body) return undefined;
    re = new RegExp(escapeRe(body.toLowerCase()).replace(/\s+/g, "\\s+"), "gi");
  } else if (s.length >= 3 && s.startsWith("/") && s.endsWith("/")) {
    try {
      re = new RegExp(s.slice(1, -1), "gim");
    } catch {
      re = new RegExp(escapeRe(s.toLowerCase()), "gi");
    }
  } else {
    // 长的放前面：a|ab 在同一位置时高亮取长的那个，和多个词的行为一致
    const parts = s.toLowerCase().split("|").filter(Boolean).sort((a, b) => b.length - a.length);
    if (!parts.length) return undefined;
    re = new RegExp(parts.map(escapeRe).join("|"), "gi");
  }
  return { re, negate, field };
}

// "foo bar @7d" → terms = [foo, bar]，since = 7 天前
export function parseQuery(q: string): ParsedQuery {
  const terms: Term[] = [];
  const seen = new Set<string>();
  let since = 0;
  let sinceLabel = "";
  for (const tok of q.match(TOKEN_RE) ?? []) {
    const m = /^@(\d+)([hdwm])$/i.exec(tok);
    if (m) {
      const n = Number(m[1]);
      const unit = m[2].toLowerCase();
      if (n > 0) {
        since = Date.now() - n * TIME_UNIT_MS[unit];
        sinceLabel = msg("since", { n, unit: msg(TIME_UNIT_LABEL[unit]) });
      }
      continue;
    }
    const t = parseTerm(tok);
    if (!t) continue;
    const key = `${t.negate ? "-" : "+"}${t.field}:${t.re.source}`; // 同一个词打两遍只算一次（普通词已转小写，正则原样）
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(t);
  }
  return { terms, since, sinceLabel };
}

// 从 from 起找第一个非空命中。g 标志的正则复用前要设 lastIndex，否则从上次命中的位置接着找；
// 空匹配（如 /a*/ 对上空串）跳过：既不算命中，也免得高亮循环原地打转
function execFrom(re: RegExp, s: string, from: number): RegExpExecArray | null {
  re.lastIndex = from;
  let m = re.exec(s);
  while (m && !m[0].length) {
    if (m.index >= s.length) return null;
    re.lastIndex = m.index + 1;
    m = re.exec(s);
  }
  return m;
}

function hit(re: RegExp, s: string): boolean {
  return execFrom(re, s, 0) !== null;
}

function termHits(s: PeekSession, t: Term): boolean {
  switch (t.field) {
    case "name":
      return hit(t.re, s.name);
    case "cwd":
      return hit(t.re, s.cwd);
    case "user":
    case "assistant":
      return s.msgs.some((m) => m.role === t.field && hit(t.re, m.text));
    default:
      // 普通词不看工作目录：当前目录树范围下所有会话的路径都带同一段前缀，路径里的词会命中全部会话。
      // 要搜路径用 dir:。pi 自带的选择器会把 cwd 拼进搜索文本，这里是有意不同
      return hit(t.re, s.name) || s.msgs.some((m) => hit(t.re, m.text));
  }
}

// 每个词都要满足：普通词在会话名或某条消息里出现，排除词则哪里都不出现；带前缀的只看对应的地方。
// 正文不预存小写副本，直接在原文上用不区分大小写的正则匹配
export function matchesSession(s: PeekSession, terms: Term[]): boolean {
  return terms.every((t) => termHits(s, t) !== t.negate);
}

// 单段文字用：命中任意一个词就算
export function anyMatch(text: string, terms: Term[]): boolean {
  return terms.some((t) => hit(t.re, text));
}

export interface RoleTerms {
  user: Term[];
  assistant: Term[];
}

// 正文里要高亮、计命中的词，按消息角色分开：排除词不算，name: / cwd: 不算，user: / ai: 只给对应角色
export function roleTerms(terms: Term[]): RoleTerms {
  const pick = (role: PeekMsg["role"]) => terms.filter((t) => !t.negate && (t.field === "any" || t.field === role));
  return { user: pick("user"), assistant: pick("assistant") };
}

// 从 from 起最早的命中 [位置, 长度]；同一位置取最长的
function nextMatch(text: string, terms: Term[], from: number): [number, number] {
  let best = -1;
  let len = 0;
  for (const t of terms) {
    const m = execFrom(t.re, text, from);
    if (!m) continue;
    if (best === -1 || m.index < best || (m.index === best && m[0].length > len)) {
      best = m.index;
      len = m[0].length;
    }
  }
  return [best, len];
}

// 渲染后的一行（可带 ANSI）里有没有命中，预览按行记命中用。和 highlight 用同一个正则去掉序列，两边才对得上
export function lineHasMatch(line: string, terms: Term[]): boolean {
  return terms.length > 0 && anyMatch(line.replace(ANSI_SEQ_RE, ""), terms);
}

// 在一行文字里高亮命中，返回带 ANSI 的字符串。
// 输入可以是已经渲染过、带样式的行：转义序列不参与匹配也不会被切断；高亮结束时把原来的
// 前景色 / 粗体 / 下划线恢复回去，所以放在标题、链接等样式里面也不会把后面的文字弄丢样式。
// 不用主题自带的 searchMatchBg：dark/light 主题里它和 selectedBg 同色，看不出来
export function highlight(line: string, terms: Term[], theme: PeekTheme): string {
  if (!terms.length || !line) return line;

  // 拆成可见文本和转义序列两类片段
  const segs = splitAnsi(line);

  let visible = "";
  for (const s of segs) if (!s.esc) visible += s.text;

  const ranges: [number, number][] = [];
  for (let i = 0; ; ) {
    const [j, len] = nextMatch(visible, terms, i);
    if (j === -1) break;
    ranges.push([j, j + len]);
    i = j + len;
  }
  if (!ranges.length) return line;

  const on = "\x1b[1m\x1b[4m" + stylePrefix((s) => theme.fg("warning", s));
  const st: SgrStyle = { fg: "", bold: false, dim: false, underline: false };
  const off = () =>
    (st.underline ? "" : "\x1b[24m") +
    (st.bold ? "" : "\x1b[22m" + (st.dim ? "\x1b[2m" : "")) +
    (st.fg || "\x1b[39m");

  let out = "";
  let pos = 0; // 当前片段在 visible 里的起点
  let r = 0; // 当前区间下标
  let inside = false;
  for (const seg of segs) {
    if (seg.esc) {
      applySgr(st, seg.text);
      out += seg.text;
      if (inside) out += on; // 序列可能重置了样式，补回来
      continue;
    }
    const end = pos + seg.text.length;
    let i = pos;
    while (i < end) {
      if (inside) {
        const stop = Math.min(ranges[r][1], end);
        out += visible.slice(i, stop);
        i = stop;
        if (stop === ranges[r][1]) {
          out += off();
          inside = false;
          r++;
        }
      } else {
        const start = r < ranges.length ? ranges[r][0] : end;
        const stop = Math.min(start, end);
        out += visible.slice(i, stop);
        i = stop;
        if (stop === start && stop < end) {
          out += on;
          inside = true;
        }
      }
    }
    pos = end;
  }
  return out;
}

export interface Snippet {
  text: string;
  role: PeekMsg["role"]; // 片段来自哪个角色的消息，高亮时用该角色的词
}

// 左栏用：第一个命中处前后截一段。没有消息命中时返回 undefined，调用方退回首条消息
export function snippet(msgs: PeekMsg[], rt: RoleTerms, width: number): Snippet | undefined {
  for (const m of msgs) {
    const terms = rt[m.role];
    if (!terms.length) continue;
    // 在原文上找命中，正则的 ^ / $ 才能和列表过滤时对得上；截出来的那段再把换行和连续空白压成一个空格
    const [j] = nextMatch(m.text, terms, 0);
    if (j === -1) continue;
    const start = Math.max(0, j - Math.floor(width / 3));
    const flat = m.text.slice(start, j + width).replace(/\s+/g, " ");
    return { text: (start > 0 ? "…" : "") + flat.slice(0, width), role: m.role };
  }
  return undefined;
}

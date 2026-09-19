import { msg, type MsgKey } from "./i18n.ts";
import type { PeekMsg } from "./sessions.ts";

// 搜索框语法：空格分隔多个词，都要命中；@7d / @24h / @2w / @1m 限定最近活动时间

export interface ParsedQuery {
  kws: string[];
  since: number; // 毫秒时间戳，0 表示不限
  sinceLabel: string;
}

const TIME_UNIT_MS: Record<string, number> = { h: 3600e3, d: 86400e3, w: 7 * 86400e3, m: 30 * 86400e3 };
const TIME_UNIT_LABEL: Record<string, MsgKey> = { h: "unitH", d: "unitD", w: "unitW", m: "unitM" };

// "foo bar @7d" → kws = [foo, bar]，since = 7 天前
export function parseQuery(q: string): ParsedQuery {
  const kws: string[] = [];
  let since = 0;
  let sinceLabel = "";
  for (const tok of q.toLowerCase().split(/\s+/)) {
    if (!tok) continue;
    const m = /^@(\d+)([hdwm])$/.exec(tok);
    if (m) {
      const n = Number(m[1]);
      if (n > 0) {
        since = Date.now() - n * TIME_UNIT_MS[m[2]];
        sinceLabel = msg("since", { n, unit: msg(TIME_UNIT_LABEL[m[2]]) });
      }
      continue;
    }
    if (!kws.includes(tok)) kws.push(tok);
  }
  return { kws, since, sinceLabel };
}

// 单条消息用：命中任意一个关键词就算
export function anyKw(lower: string, kws: string[]): boolean {
  for (const k of kws) if (lower.includes(k)) return true;
  return false;
}

// 最早出现的关键词；同一位置取最长的那个
function nextMatch(lower: string, kws: string[], i: number): [number, number] {
  let best = -1;
  let len = 0;
  for (const k of kws) {
    const j = lower.indexOf(k, i);
    if (j !== -1 && (best === -1 || j < best || (j === best && k.length > len))) {
      best = j;
      len = k.length;
    }
  }
  return [best, len];
}

// pi-tui 会产生的三类转义序列：CSI（颜色等）、OSC（超链接）、APC
const ESC_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b[\]_][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// 把样式函数拆出前缀，pi 的 Markdown 组件也是这么做的
function stylePrefix(fn: (s: string) => string): string {
  const s = fn(" ");
  const i = s.indexOf(" ");
  return i >= 0 ? s.slice(0, i) : "";
}

// 只跟踪高亮会碰到的几项：前景色、粗体 / 暗淡、下划线
interface Sgr {
  fg: string;
  bold: boolean;
  dim: boolean;
  underline: boolean;
}

function applySgr(st: Sgr, seq: string): void {
  const m = /^\x1b\[([0-9;]*)m$/.exec(seq);
  if (!m) return;
  const p = m[1] === "" ? [0] : m[1].split(";").map(Number);
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === 0) {
      st.fg = "";
      st.bold = st.dim = st.underline = false;
    } else if (c === 1) st.bold = true;
    else if (c === 2) st.dim = true;
    else if (c === 22) st.bold = st.dim = false;
    else if (c === 4) st.underline = true;
    else if (c === 24) st.underline = false;
    else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) st.fg = `\x1b[${c}m`;
    else if (c === 39) st.fg = "";
    else if (c === 38 || c === 48) {
      // 扩展色 38;5;n / 38;2;r;g;b；背景色（48）只需要跳过它的参数
      const n = p[i + 1] === 5 ? 2 : p[i + 1] === 2 ? 4 : 0;
      if (c === 38 && n) st.fg = `\x1b[${p.slice(i, i + n + 1).join(";")}m`;
      i += n;
    }
  }
}

// 渲染后的一行（可带 ANSI）里有没有关键词，预览按行记命中用
export function lineHasKw(line: string, kws: string[]): boolean {
  return kws.length > 0 && anyKw(line.replace(ESC_RE, "").toLowerCase(), kws);
}

// 在一行文字里高亮关键词，返回带 ANSI 的字符串。
// 输入可以是已经渲染过、带样式的行：转义序列不参与匹配也不会被切断；高亮结束时把原来的
// 前景色 / 粗体 / 下划线恢复回去，所以放在标题、链接等样式里面也不会把后面的文字弄丢样式。
// 不用主题自带的 searchMatchBg：dark/light 主题里它和 selectedBg 同色，看不出来
export function highlight(line: string, kws: string[], theme: any): string {
  if (!kws.length || !line) return line;

  // 拆成可见文本和转义序列两类片段
  const segs: { text: string; esc: boolean }[] = [];
  let last = 0;
  for (const m of line.matchAll(ESC_RE)) {
    if (m.index > last) segs.push({ text: line.slice(last, m.index), esc: false });
    segs.push({ text: m[0], esc: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) segs.push({ text: line.slice(last), esc: false });

  let visible = "";
  for (const s of segs) if (!s.esc) visible += s.text;
  const lower = visible.toLowerCase();
  if (lower.length !== visible.length) return line; // 个别字符小写后长度会变，位置对不上就不高亮

  const ranges: [number, number][] = [];
  for (let i = 0; ; ) {
    const [j, len] = nextMatch(lower, kws, i);
    if (j === -1) break;
    ranges.push([j, j + len]);
    i = j + len;
  }
  if (!ranges.length) return line;

  const on = "\x1b[1m\x1b[4m" + stylePrefix((s) => theme.fg("warning", s));
  const st: Sgr = { fg: "", bold: false, dim: false, underline: false };
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

// 左栏用：第一个命中处前后截一段。没有消息命中时返回 undefined，调用方退回首条消息
export function snippet(msgs: PeekMsg[], kws: string[], width: number): string | undefined {
  if (!kws.length) return undefined;
  for (const m of msgs) {
    const flat = m.text.replace(/\s+/g, " ");
    const [j] = nextMatch(flat.toLowerCase(), kws, 0);
    if (j === -1) continue;
    const start = Math.max(0, j - Math.floor(width / 3));
    return (start > 0 ? "…" : "") + flat.slice(start, start + width);
  }
  return undefined;
}

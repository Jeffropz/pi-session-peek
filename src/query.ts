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

// 在换行之前调用，返回带 ANSI 的字符串。
// 不用主题自带的 searchMatchBg：dark/light 主题里它和 selectedBg 同色，看不出来
export function highlight(text: string, kws: string[], theme: any): string {
  if (!kws.length) return text;
  const lower = text.toLowerCase();
  let out = "";
  let i = 0;
  for (;;) {
    const [j, len] = nextMatch(lower, kws, i);
    if (j === -1) {
      out += text.slice(i);
      break;
    }
    out +=
      text.slice(i, j) +
      "\x1b[4m" +
      theme.bold(theme.fg("warning", text.slice(j, j + len))) +
      "\x1b[24m";
    i = j + len;
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

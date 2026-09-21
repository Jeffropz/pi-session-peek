import { truncateToWidth } from "@earendil-works/pi-tui";
import { anyMatch, highlight, snippet, type RoleTerms } from "./query.ts";
import type { PeekSession } from "./sessions.ts";
import { fmtTime, padEndVisible } from "./text.ts";
import type { PeekTheme } from "./theme.ts";

// 左栏：每个会话两行，全是纯函数。滚动偏移由组件持有，这里只算"选中项要留在视口里时偏移该是多少"

// 主体 height 行能放下几个会话（每个两行）
export const visibleItems = (height: number): number => Math.max(1, Math.floor(height / 2));

// 选中项跑出视口时把偏移挪过去，其余情况不动
export function followSelection(selected: number, offset: number, visible: number): number {
  if (selected < offset) return selected;
  if (selected >= offset + visible) return selected - visible + 1;
  return offset;
}

// 一个会话的两行：时间 + 目录（有正文关键词时加命中数），首条消息或命中片段
export function listRows(s: PeekSession, sel: boolean, lw: number, rt: RoleTerms, hasBody: boolean, t: PeekTheme): [string, string] {
  const time = fmtTime(s.time);
  const cwdTail = s.cwd.replace(/\\/g, "/").split("/").slice(-2).join("/");
  const hitBadge = hasBody
    ? ` ·${s.msgs.reduce((n, m) => n + (anyMatch(m.text, rt[m.role]) ? 1 : 0), 0)}`
    : "";
  const l1 = `${sel ? "›" : " "} ${time} ${cwdTail}${hitBadge}`;
  const snip = hasBody ? snippet(s.msgs, rt, lw) : undefined;
  const l2 = snip !== undefined
    ? `  ${highlight(snip.text, rt[snip.role], t)}`
    : `  ${s.first}${s.name ? `  [${s.name}]` : ""}`;
  if (sel) {
    return [
      t.bg("selectedBg", padEndVisible(t.fg("accent", truncateToWidth(l1, lw)), lw)),
      t.bg("selectedBg", padEndVisible(truncateToWidth(l2, lw), lw)),
    ];
  }
  return [padEndVisible(l1, lw), padEndVisible(t.fg("dim", truncateToWidth(l2, lw)), lw)];
}

// 从 offset 起画满 height 行，每个会话两行，没会话的位置留空
export function buildList(
  filtered: PeekSession[],
  selected: number,
  offset: number,
  height: number,
  lw: number,
  rt: RoleTerms,
  hasBody: boolean,
  t: PeekTheme,
): string[] {
  const rows: string[] = [];
  for (let i = 0, n = visibleItems(height); i < n; i++) {
    const idx = offset + i;
    const s = filtered[idx];
    if (!s) {
      rows.push(" ".repeat(lw), " ".repeat(lw));
      continue;
    }
    rows.push(...listRows(s, idx === selected, lw, rt, hasBody, t));
  }
  // 每项两行，height 是奇数时会少一行，补空行，否则最后一行右栏会顶到左边
  while (rows.length < height) rows.push(" ".repeat(lw));
  return rows.slice(0, height);
}

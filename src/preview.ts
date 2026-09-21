import { Markdown, truncateToWidth, visibleWidth, type MarkdownTheme } from "@earendil-works/pi-tui";
import { msg } from "./i18n.ts";
import { anyMatch, highlight, lineHasMatch, type RoleTerms } from "./query.ts";
import type { PeekMsg, PeekSession } from "./sessions.ts";
import { padEndVisible } from "./text.ts";
import type { PeekTheme } from "./theme.ts";

// 右栏：把一个会话渲染成预览行，全是纯函数。滚动偏移和"要不要重建"的缓存键由组件持有

const MAX_MSGS = 500; // 超长会话只画最后这么多条，更早的命中仍计数并提示

/** 每条消息渲染好的行，按宽度缓存。键是消息对象本身，会话从缓存里掉了它也跟着掉 */
export type RenderCache = WeakMap<PeekMsg, { w: number; lines: string[] }>;

// 用 pi 自己的 Markdown 组件渲染一条消息，和主界面里的对话长得一样；参数照抄 pi 的
// user-message / assistant-message 组件。渲染比较贵，按消息和宽度缓存，换关键词时不用重来
export function renderMsg(m: PeekMsg, rw: number, t: PeekTheme, mdTheme: MarkdownTheme, cache: RenderCache): string[] {
  const hit = cache.get(m);
  if (hit && hit.w === rw) return hit.lines;
  const md =
    m.role === "user"
      ? new Markdown(
          m.text,
          1,
          0,
          mdTheme,
          { color: (s) => t.fg("userMessageText", s), bgColor: (s) => t.bg("userMessageBg", s) },
          { preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
        )
      : new Markdown(m.text, 1, 0, mdTheme);
  const lines = md.render(rw);
  cache.set(m, { w: rw, lines });
  return lines;
}

export interface Preview {
  lines: string[];
  matchLines: number[]; // 含关键词的行（升序），Ctrl+N / Ctrl+P 用
}

// 右栏内容。没有会话时只有一行提示
export function buildPreview(
  s: PeekSession | undefined,
  rt: RoleTerms,
  rw: number,
  showTools: boolean,
  t: PeekTheme,
  mdTheme: MarkdownTheme,
  cache: RenderCache,
): Preview {
  if (!s) return { lines: [t.fg("dim", msg("noMatch"))], matchLines: [] };

  const lines: string[] = [];
  const matchLines: number[] = [];
  // 消息数只算有文字的，纯工具轮次不计
  const textCount = s.msgs.reduce((n, m) => n + (m.text ? 1 : 0), 0);
  lines.push(
    truncateToWidth(
      t.fg("dim", `${s.cwd} • ${msg("msgCount", { n: textCount })}${s.name ? " • " + s.name : ""}`),
      rw,
    ),
  );
  lines.push("");

  const hasBody = rt.user.length > 0 || rt.assistant.length > 0;
  const truncated = s.msgs.length > MAX_MSGS;
  const msgs = truncated ? s.msgs.slice(-MAX_MSGS) : s.msgs;
  if (truncated) {
    lines.push(t.fg("dim", msg("truncated", { n: MAX_MSGS })));
    lines.push("");
  }
  if (hasBody && !msgs.some((m) => anyMatch(m.text, rt[m.role]))) {
    const inTruncated = truncated && s.msgs.some((m) => anyMatch(m.text, rt[m.role]));
    lines.push(
      t.fg(
        "warning",
        inTruncated ? msg("hitInTruncated") : msg("hitOnlyMeta"),
      ),
    );
    lines.push("");
  }

  // 用户消息整块背景色，AI 消息只有一条细线标签
  const fillLabel = (label: string): string => {
    const w = visibleWidth(label);
    return truncateToWidth(label + " " + "─".repeat(Math.max(2, rw - w - 1)), rw);
  };

  let prevRole: PeekMsg["role"] | undefined; // 上一条画出来的消息的角色
  for (const m of msgs) {
    const tools = showTools ? (m.tools ?? []) : [];
    if (!m.text && !tools.length) continue; // 工具隐藏时，只有工具调用的 AI 轮次整条跳过
    const terms = rt[m.role]; // user: 的词只在用户消息里高亮，ai: 的只在 AI 回复里
    const isMatch = terms.length > 0 && anyMatch(m.text, terms);
    // 紧跟在 AI 文字后面、只有工具调用的轮次不重复画标签，接在上一条正文下面，看起来是同一轮
    const continues = m.role === "assistant" && prevRole === "assistant" && !m.text;
    if (continues) {
      lines.pop();
    } else if (m.role === "user") {
      lines.push(
        t.bg("userMessageBg", padEndVisible(t.bold(t.fg("accent", fillLabel(msg("you")))), rw)),
      );
    } else {
      lines.push(t.fg("muted", fillLabel(msg("ai"))));
    }
    const head = lines.length - 1;
    // 先渲染再高亮：往 markdown 源码里插转义码会把链接、代码块的语法弄坏
    const before = matchLines.length;
    if (m.text) {
      for (const l of renderMsg(m, rw, t, mdTheme, cache)) {
        if (isMatch && lineHasMatch(l, terms)) matchLines.push(lines.length);
        lines.push(isMatch ? highlight(l, terms, t) : l);
      }
    }
    // 关键词被折行拆开时哪一行都找不到，退回到消息标题行，别把这条消息漏掉
    if (isMatch && matchLines.length === before) matchLines.push(head);
    for (const tool of tools) {
      lines.push(t.fg("dim", truncateToWidth(` ⚙ ${tool.name}${tool.summary ? "  " + tool.summary : ""}`, rw)));
    }
    lines.push("");
    prevRole = m.role;
  }

  return { lines, matchLines };
}

// 刚建好的预览该停在哪：有关键词时滚到第一个命中处（上面留两行），没有时滚到底部看最新消息
export function initialOffset(p: Preview, H: number): number {
  if (p.matchLines.length) return Math.max(0, p.matchLines[0] - 2);
  return Math.max(0, p.lines.length - H);
}

// Ctrl+N / Ctrl+P：当前视口 [top, bottom] 之外的下一个 / 上一个命中行，到头了回绕。同一屏里的多个命中算一处，
// 否则一段里连着几行都命中要按好几次才过得去。没有命中返回 undefined
export function nextMatchTarget(matchLines: number[], top: number, bottom: number, dir: 1 | -1): number | undefined {
  if (!matchLines.length) return undefined;
  if (dir === 1) return matchLines.find((l) => l > bottom) ?? matchLines[0];
  return [...matchLines].reverse().find((l) => l < top) ?? matchLines[matchLines.length - 1];
}

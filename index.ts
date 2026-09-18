/**
 * session-peek — 历史会话搜索 / 预览 / 进入
 *
 * 命令: /peek [关键词]
 *
 * 界面: 左右分栏
 *   左栏 = 会话列表（时间 + 目录 + 首条消息 + 命中数）
 *   右栏 = 选中会话的完整对话，可滚动，命中关键词高亮
 *
 * 按键:
 *   打字                实时过滤（对话正文 + 会话名 + 目录，大小写不敏感）
 *   Tab                 切换范围：当前目录 <-> 全局
 *   ↑ / ↓               选择会话
 *   PgUp / PgDn         滚动右侧预览（整页）
 *   Ctrl+U / Ctrl+D     滚动右侧预览（半页）
 *   Shift+↑ / Shift+↓   滚动右侧预览（3 行）
 *   Ctrl+N / Ctrl+P     跳到下一个 / 上一个关键词命中处
 *   Enter               进入选中的会话（pi --session 等效）
 *   Esc                 关闭
 *
 * 终端启动时直接打开:
 *   pi --peek                启动 pi 并打开搜索界面
 *   pi --peek=getHttpValue   启动并预填关键词
 *   pi --rp                  --peek 的别名
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// 数据层：扫描 + 解析会话 JSONL（按 mtime 缓存，二次打开秒开）
// ---------------------------------------------------------------------------

interface PeekMsg {
  role: "user" | "assistant";
  text: string;
}

interface PeekSession {
  path: string;
  cwd: string;
  time: string;
  name: string;
  first: string;
  msgs: PeekMsg[];
  searchText: string;
  mtime: number;
}

const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");
const sessionCache = new Map<string, PeekSession>();

function* walkJsonl(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(p);
    else if (e.name.endsWith(".jsonl")) yield p;
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("\n");
}

function parseSession(path: string, mtime: number): PeekSession | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let cwd = "";
  let time = "";
  let name = "";
  const msgs: PeekMsg[] = [];

  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      if (line.includes('"type":"session"')) {
        const o = JSON.parse(line);
        cwd = o.cwd ?? cwd;
        time = o.timestamp ?? time;
        continue;
      }
      if (line.includes('"type":"session_info"')) {
        const o = JSON.parse(line);
        if (typeof o.name === "string" && o.name) name = o.name;
        continue;
      }
      // 粗筛提速：只解析可能包含用户/助手消息的行
      if (!line.includes('"role":"user"') && !line.includes('"role":"assistant"')) continue;
      const o = JSON.parse(line);
      if (o.type !== "message") continue;
      const role = o.message?.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = extractText(o.message?.content).trim();
      if (text) msgs.push({ role, text });
    } catch {
      // 单行解析失败，跳过
    }
  }

  if (!msgs.length) return null;

  return {
    path,
    cwd,
    time,
    name,
    msgs,
    mtime,
    first: msgs[0].text.replace(/\s+/g, " ").slice(0, 80),
    // 只索引"对话正文 + 会话名 + 目录"，不索引工具输入输出（避免噪音命中）
    searchText: (msgs.map((m) => m.text).join(" ") + " " + name + " " + cwd).toLowerCase(),
  };
}

function scanSessions(): PeekSession[] {
  const seen = new Set<string>();
  const out: PeekSession[] = [];

  for (const file of walkJsonl(SESSIONS_DIR)) {
    seen.add(file);
    let mtime = 0;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    const hit = sessionCache.get(file);
    if (hit && hit.mtime === mtime) {
      out.push(hit);
      continue;
    }
    const parsed = parseSession(file, mtime);
    if (parsed) {
      sessionCache.set(file, parsed);
      out.push(parsed);
    }
  }

  // 清理已删除会话的缓存
  for (const key of [...sessionCache.keys()]) {
    if (!seen.has(key)) sessionCache.delete(key);
  }

  return out.sort((a, b) => b.mtime - a.mtime);
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

const normPath = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

function padEndVisible(s: string, w: number): string {
  const v = visibleWidth(s);
  return v >= w ? truncateToWidth(s, w) : s + " ".repeat(w - v);
}

/**
 * 纯文本关键词高亮（大小写不敏感），在 wrap 之前调用。
 * 不用主题的 searchMatchBg：dark/light 主题里它别名到 selectedBg，和左栏选中行同色，
 * 视觉上不明显。改为 warning 前景 + 粗体 + 下划线，任何主题都醒目。
 */
function highlight(text: string, kw: string, theme: any): string {
  if (!kw) return text;
  const lower = text.toLowerCase();
  let out = "";
  let i = 0;
  for (;;) {
    const j = lower.indexOf(kw, i);
    if (j === -1) {
      out += text.slice(i);
      break;
    }
    out +=
      text.slice(i, j) +
      "\x1b[4m" + // underline on
      theme.bold(theme.fg("warning", text.slice(j, j + kw.length))) +
      "\x1b[24m"; // underline off
    i = j + kw.length;
  }
  return out;
}

function wrapLines(text: string, width: number): string[] {
  const out: string[] = [];
  for (const part of text.split("\n")) {
    const wrapped = wrapTextWithAnsi(part, width);
    out.push(...(wrapped.length ? wrapped : [""]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 双栏组件
// ---------------------------------------------------------------------------

class PeekComponent implements Component, Focusable {
  private input: Input;
  private scope: "current" | "all";
  private filtered: PeekSession[] = [];
  private selected = 0;
  private listOffset = 0;
  private previewOffset = 0;
  private previewKey = "";
  private previewLines: string[] = [];
  private matchLines: number[] = []; // 预览中命中消息的行号（用于 Ctrl+N/P 跳转）
  private cachedWidth = -1;
  private cachedLines: string[] = [];
  private _focused = false;

  onResume?: (s: PeekSession) => void;
  onCancel?: () => void;

  constructor(
    private all: PeekSession[],
    private currentCwd: string,
    private theme: any,
    private termRows: number,
    initialQuery: string,
  ) {
    this.input = new Input({ placeholder: "输入关键词实时过滤（对话正文 / 会话名 / 目录）" });
    if (initialQuery) this.input.setValue(initialQuery);
    // 当前目录有会话时默认当前目录，否则全局
    const cur = normPath(currentCwd);
    this.scope = all.some((s) => normPath(s.cwd) === cur) ? "current" : "all";
    this.refilter();
  }

  // Focusable：把焦点传给内部 Input，保证中文/IME 输入光标位置正确
  get focused(): boolean {
    return this._focused;
  }
  set focused(v: boolean) {
    this._focused = v;
    this.input.focused = v;
  }

  getQuery(): string {
    return this.input.getValue().trim();
  }

  private kw(): string {
    return this.getQuery().toLowerCase();
  }

  private refilter(): void {
    const kw = this.kw();
    let out = this.all;
    if (this.scope === "current") {
      const cur = normPath(this.currentCwd);
      out = out.filter((s) => normPath(s.cwd) === cur);
    }
    if (kw) out = out.filter((s) => s.searchText.includes(kw));
    this.filtered = out;
    this.selected = 0;
    this.listOffset = 0;
    this.previewKey = ""; // 触发预览重建，buildPreview 会重新定位滚动位置
  }

  private bodyHeight(): number {
    return Math.max(8, Math.min(this.termRows - 12, 30));
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.onCancel?.();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.scope = this.scope === "all" ? "current" : "all";
      this.refilter();
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.up)) {
      if (this.selected > 0) {
        this.selected--;
        this.previewKey = "";
        this.invalidate();
      }
      return;
    }
    if (matchesKey(data, Key.down)) {
      if (this.selected < this.filtered.length - 1) {
        this.selected++;
        this.previewKey = "";
        this.invalidate();
      }
      return;
    }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
      const step = matchesKey(data, Key.pageUp) ? this.bodyHeight() : Math.max(1, this.bodyHeight() >> 1);
      this.previewOffset = Math.max(0, this.previewOffset - step);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
      const step = matchesKey(data, Key.pageDown) ? this.bodyHeight() : Math.max(1, this.bodyHeight() >> 1);
      this.previewOffset += step;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.shift("up"))) {
      this.previewOffset = Math.max(0, this.previewOffset - 3);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.shift("down"))) {
      this.previewOffset += 3;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.ctrl("n"))) {
      this.jumpMatch(1);
      return;
    }
    if (matchesKey(data, Key.ctrl("p"))) {
      this.jumpMatch(-1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const s = this.filtered[this.selected];
      if (s) this.onResume?.(s);
      return;
    }
    // 其余按键交给输入框（字符、删除、光标移动、IME 等）
    this.input.handleInput(data);
    this.refilter();
    this.invalidate();
  }

  /** 预览内跳转到下一个/上一个命中行 */
  private jumpMatch(dir: 1 | -1): void {
    if (!this.matchLines.length) return;
    const cur = this.previewOffset + 2;
    let target: number | undefined;
    if (dir === 1) {
      target = this.matchLines.find((l) => l > cur) ?? this.matchLines[0]; // 到底则回绕
    } else {
      target = [...this.matchLines].reverse().find((l) => l < cur) ?? this.matchLines[this.matchLines.length - 1];
    }
    if (target !== undefined) {
      this.previewOffset = Math.max(0, target - 2);
      this.invalidate();
    }
  }

  /** 左栏：会话列表，每项 2 行 */
  private buildList(height: number, lw: number): string[] {
    const t = this.theme;
    const kw = this.kw();
    const visible = Math.max(1, Math.floor(height / 2));
    if (this.selected < this.listOffset) this.listOffset = this.selected;
    if (this.selected >= this.listOffset + visible) {
      this.listOffset = this.selected - visible + 1;
    }

    const rows: string[] = [];
    for (let i = 0; i < visible; i++) {
      const idx = this.listOffset + i;
      const s = this.filtered[idx];
      if (!s) {
        rows.push(" ".repeat(lw), " ".repeat(lw));
        continue;
      }
      const sel = idx === this.selected;
      const time = s.time ? s.time.slice(5, 16).replace("T", " ") : "??? ??-??";
      const cwdTail = s.cwd.replace(/\\/g, "/").split("/").slice(-2).join("/");
      // 关键词模式下显示命中条数
      const hitBadge = kw
        ? ` ·${s.msgs.reduce((n, m) => n + (m.text.toLowerCase().includes(kw) ? 1 : 0), 0)}`
        : "";
      const l1 = `${sel ? "›" : " "} ${time} ${cwdTail}${hitBadge}`;
      const l2 = `  ${s.first}${s.name ? `  [${s.name}]` : ""}`;
      if (sel) {
        rows.push(t.bg("selectedBg", padEndVisible(t.fg("accent", truncateToWidth(l1, lw)), lw)));
        rows.push(t.bg("selectedBg", padEndVisible(truncateToWidth(l2, lw), lw)));
      } else {
        rows.push(padEndVisible(l1, lw));
        rows.push(padEndVisible(t.fg("dim", truncateToWidth(l2, lw)), lw));
      }
    }
    return rows.slice(0, height);
  }

  /**
   * 右栏：完整对话预览（可滚动）。
   * 有关键词 → 全部消息 + 命中高亮，自动滚动到第一个命中处，Ctrl+N/P 在命中间跳转
   * 无关键词 → 全部消息，自动滚动到底部（最新消息）
   */
  private buildPreview(rw: number): void {
    const t = this.theme;
    const s = this.filtered[this.selected];
    const key = s ? `${s.path}|${this.kw()}|${rw}` : "none";
    if (key === this.previewKey) return;
    this.previewKey = key;
    this.matchLines = [];

    if (!s) {
      this.previewLines = [t.fg("dim", "没有匹配的会话")];
      this.previewOffset = 0;
      return;
    }

    const lines: string[] = [];
    lines.push(
      truncateToWidth(
        t.fg("dim", `${s.cwd} • ${s.msgs.length} 条消息${s.name ? " • " + s.name : ""}`),
        rw,
      ),
    );
    lines.push("");

    const kw = this.kw();
    const MAX_MSGS = 500;
    const truncated = s.msgs.length > MAX_MSGS;
    const msgs = truncated ? s.msgs.slice(-MAX_MSGS) : s.msgs;
    if (truncated) {
      lines.push(t.fg("dim", `（会话过长，仅显示最后 ${MAX_MSGS} 条）`));
      lines.push("");
    }
    if (kw && !msgs.some((m) => m.text.toLowerCase().includes(kw))) {
      lines.push(t.fg("warning", "关键词仅命中会话名或目录，对话正文无匹配"));
      lines.push("");
    }

    // 消息分界：用户消息整条用 userMessageBg 背景块（与 pi 聊天区风格一致），
    // AI 消息用细线标签，两者一眼可分
    const fillLabel = (label: string): string => {
      const w = visibleWidth(label);
      return truncateToWidth(label + " " + "─".repeat(Math.max(2, rw - w - 1)), rw);
    };

    for (const m of msgs) {
      const isMatch = kw !== "" && m.text.toLowerCase().includes(kw);
      if (isMatch) this.matchLines.push(lines.length); // 记录 label 所在行
      const body = isMatch ? highlight(m.text, kw, t) : m.text;

      if (m.role === "user") {
        lines.push(
          t.bg("userMessageBg", padEndVisible(t.bold(t.fg("accent", fillLabel("👤 你"))), rw)),
        );
        for (const wl of wrapLines(body, rw - 2)) {
          lines.push(t.bg("userMessageBg", padEndVisible(" " + wl, rw)));
        }
      } else {
        lines.push(t.fg("muted", fillLabel("🤖 AI")));
        for (const wl of wrapLines(body, rw - 2)) lines.push(" " + wl);
      }
      lines.push("");
    }

    this.previewLines = lines;

    // 初始滚动位置：有命中 → 第一个命中往上留 2 行；无关键词 → 直接到底部看最新消息
    if (this.matchLines.length) {
      this.previewOffset = Math.max(0, this.matchLines[0] - 2);
    } else {
      this.previewOffset = Math.max(0, lines.length - this.bodyHeight());
    }
  }

  render(width: number): string[] {
    if (this.cachedWidth === width) return this.cachedLines;
    const t = this.theme;
    const H = this.bodyHeight();
    const lw = Math.max(26, Math.min(56, Math.floor(width * 0.4)));
    const rw = Math.max(20, width - lw - 3);

    const out: string[] = [];

    // 头部
    const scopeLabel = this.scope === "all" ? "全局" : "当前目录";
    const head =
      t.fg("accent", t.bold("🔍 会话搜索预览")) +
      t.fg("dim", "  范围[Tab]: ") +
      t.fg("warning", scopeLabel) +
      t.fg("dim", `  匹配 ${this.filtered.length}/${this.all.length}`);
    out.push(truncateToWidth(head, width));
    out.push(this.input.render(width)[0] ?? "");
    out.push(t.fg("borderMuted", "─".repeat(width)));

    // 双栏
    this.buildPreview(rw);
    const leftRows = this.buildList(H, lw);

    const maxOff = Math.max(0, this.previewLines.length - H);
    if (this.previewOffset > maxOff) this.previewOffset = maxOff;
    const rightRows = this.previewLines.slice(this.previewOffset, this.previewOffset + H);
    const scrollInfo =
      this.previewLines.length > H
        ? t.fg(
            "dim",
            ` (${this.previewOffset + 1}-${Math.min(this.previewOffset + H, this.previewLines.length)}/${this.previewLines.length})`,
          )
        : "";

    for (let i = 0; i < H; i++) {
      const l = leftRows[i] ?? "";
      let r = rightRows[i] ?? "";
      if (i === 0 && scrollInfo) {
        r = truncateToWidth(r, Math.max(0, rw - visibleWidth(scrollInfo))) + scrollInfo;
      }
      // 左栏单元格在 buildList 中已精确到 lw，不再重 pad（避免 styled 字符串被二次截断）
      out.push(l + t.fg("borderMuted", " │ ") + padEndVisible(r, rw));
    }

    // 底部提示
    out.push(t.fg("borderMuted", "─".repeat(width)));
    out.push(
      truncateToWidth(
        t.fg("dim", "↑↓ 选择  PgUp/Dn·^U/^D·⇧↑↓ 滚动  ^N/^P 命中跳转  Tab 范围  Enter 进入  Esc 关闭"),
        width,
      ),
    );

    this.cachedWidth = width;
    this.cachedLines = out;
    return out;
  }

  invalidate(): void {
    this.cachedWidth = -1;
    this.input.invalidate();
  }
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

let lastQuery = ""; // 进程内记住上次搜索词

/** 仅供测试脚本使用，pi 加载器会忽略额外导出 */
export const __peekTest = { scanSessions, PeekComponent, normPath };

export default function (pi: ExtensionAPI) {
  // ---- 终端启动形式: pi --peek / pi --peek=关键词 / pi --rp ----
  pi.registerFlag("peek", {
    description: "启动时打开会话搜索预览（可用 --peek=关键词 预填）",
    type: "boolean",
  });
  pi.registerFlag("rp", {
    description: "--peek 的别名",
    type: "boolean",
  });

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") return; // 只在进程启动时触发，切换会话不重开
    const flag = pi.getFlag("peek") ?? pi.getFlag("rp");
    if (!flag) return;
    const kw = typeof flag === "string" ? flag : "";
    const cmd = `/peek${kw ? ` ${kw}` : ""}`;

    // 等 UI 就绪再弹出；agent 忙（如带了初始 prompt）则排队到结束后
    const tryOpen = (attempt: number) => {
      if (ctx.isIdle()) {
        pi.sendUserMessage(cmd, { expandPromptTemplates: true });
      } else if (attempt < 20) {
        setTimeout(() => tryOpen(attempt + 1), 150);
      } else {
        pi.sendUserMessage(cmd, { expandPromptTemplates: true, deliverAs: "followUp" });
      }
    };
    setTimeout(() => tryOpen(0), 150);
  });

  pi.registerCommand("peek", {
    description: "搜索历史会话：左右分栏预览、关键词高亮，Enter 进入对话",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/peek 需要在交互模式（TUI）下使用", "error");
        return;
      }

      // 当前会话不出现在列表里
      const currentFile = ctx.sessionManager.getSessionFile();
      const all = scanSessions().filter((s) => s.path !== currentFile);
      if (!all.length) {
        ctx.ui.notify("没有找到历史会话", "info");
        return;
      }

      const initial = ((args ?? "").trim() || lastQuery) ?? "";
      const picked = await ctx.ui.custom<PeekSession | null>((tui, theme, _kb, done) => {
        const comp = new PeekComponent(all, ctx.cwd, theme, process.stdout.rows || 24, initial);
        comp.onResume = (s) => done(s);
        comp.onCancel = () => done(null);
        return comp;
      });

      if (!picked) return;
      lastQuery = initial;

      const result = await ctx.switchSession(picked.path);
      if (result?.cancelled) {
        ctx.ui.notify("切换会话已取消", "info");
      }
    },
  });
}

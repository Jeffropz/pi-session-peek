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
 *                       空格分隔多个词 = AND；@7d / @24h / @2w / @1m 限定最近活动时间
 *   Tab                 切换范围：当前目录及子目录 <-> 全局
 *   ↑ / ↓               选择会话
 *   PgUp / PgDn         滚动右侧预览（整页）
 *   Ctrl+U / Ctrl+F     滚动右侧预览（半页）
 *   Shift+↑ / Shift+↓   滚动右侧预览（3 行）
 *   Ctrl+N / Ctrl+P     跳到下一个 / 上一个关键词命中处
 *   Ctrl+D              删除选中的会话（y / Enter 二次确认；优先 trash 回收站，否则直接删文件）
 *   Ctrl+R              重命名选中的会话（追加 pi 原生 session_info 条目，Enter 确认 / Esc 取消）
 *   Enter               进入选中的会话（pi --session 等效）
 *   Ctrl+O              从选中的会话分叉出新会话继续（原会话不受影响）
 *   Esc / Ctrl+C        关闭
 *
 * 终端启动时直接打开:
 *   pi --rp                  启动 pi 并打开搜索界面
 *   pi --peek=getHttpValue   启动并预填关键词（--peek 必须带值）
 */

import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
import { appendFileSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";

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

/** ISO 时间 → 本地时区 "MM-DD HH:mm"；withYear 或非本年份时为 "YYYY-MM-DD HH:mm" */
function fmtTime(iso: string, withYear = false): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return withYear ? "????-??-?? ??:??" : "??-?? ??:??";
  const p = (n: number) => String(n).padStart(2, "0");
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return withYear || d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}-${md}` : md;
}

function padEndVisible(s: string, w: number): string {
  const v = visibleWidth(s);
  return v >= w ? truncateToWidth(s, w) : s + " ".repeat(w - v);
}

/** 解析后的查询：关键词列表（小写、AND 语义）+ 时间下限 */
interface ParsedQuery {
  kws: string[];
  /** 会话最后活动时间需 >= since（毫秒时间戳），0 表示不限 */
  since: number;
  /** 时间过滤的显示标签，如 "近7天" */
  sinceLabel: string;
}

const TIME_UNIT_MS: Record<string, number> = { h: 3600e3, d: 86400e3, w: 7 * 86400e3, m: 30 * 86400e3 };
const TIME_UNIT_LABEL: Record<string, string> = { h: "小时", d: "天", w: "周", m: "个月" };

/**
 * 查询语法：空格分隔多个词，全部命中才显示（AND）；@7d / @24h / @2w / @1m 限定最近活动时间。
 * 关键词统一小写，与 searchText 对齐。
 */
function parseQuery(q: string): ParsedQuery {
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
        sinceLabel = `近${n}${TIME_UNIT_LABEL[m[2]]}`;
      }
      continue;
    }
    if (!kws.includes(tok)) kws.push(tok);
  }
  return { kws, since, sinceLabel };
}

/** 文本（已小写）是否命中任一关键词 */
function anyKw(lower: string, kws: string[]): boolean {
  for (const k of kws) if (lower.includes(k)) return true;
  return false;
}

/** 从 i 起找最早出现的关键词；同位置取最长的。返回 [index, length]，未找到 index = -1 */
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

/**
 * 纯文本多关键词高亮（大小写不敏感），在 wrap 之前调用。
 * 不用主题的 searchMatchBg：dark/light 主题里它别名到 selectedBg，和左栏选中行同色，
 * 视觉上不明显。改为 warning 前景 + 粗体 + 下划线，任何主题都醒目。
 */
function highlight(text: string, kws: string[], theme: any): string {
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
      "\x1b[4m" + // underline on
      theme.bold(theme.fg("warning", text.slice(j, j + len))) +
      "\x1b[24m"; // underline off
    i = j + len;
  }
  return out;
}

/**
 * 左栏摘要：第一个命中处前后截一段（未高亮的纯文本）。
 * 没有任何消息命中（只命中会话名/目录）时返回 undefined，调用方回退到首条消息。
 */
function snippet(msgs: PeekMsg[], kws: string[], width: number): string | undefined {
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
  private confirmingDelete = false; // Ctrl+D 二次确认状态
  private renaming = false; // Ctrl+R 重命名输入态
  private renameInput: Input;
  private cachedWidth = -1;
  private cachedLines: string[] = [];
  private _focused = false;

  onResume?: (s: PeekSession) => void;
  /** 从会话分叉出新会话并进入（由命令层注入） */
  onFork?: (s: PeekSession) => void;
  onCancel?: () => void;
  /** 删除会话（由命令层注入：优先 trash，失败回退直接删文件）；返回是否成功 */
  onDelete?: (s: PeekSession) => Promise<boolean>;
  /** 重命名会话（由命令层注入：追加 session_info 条目）；返回是否成功 */
  onRename?: (s: PeekSession, name: string) => Promise<boolean>;
  /** 异步操作完成后请求 TUI 重绘（由命令层注入 tui.requestRender） */
  requestRender?: () => void;

  constructor(
    private all: PeekSession[],
    private currentCwd: string,
    private theme: any,
    private termRows: number,
    initialQuery: string,
  ) {
    this.input = new Input({ placeholder: "关键词过滤（空格分隔=同时命中；@7d 限定近 7 天）" });
    this.renameInput = new Input({ placeholder: "新会话名（Enter 确认 / Esc 取消，留空取消）" });
    if (initialQuery) this.input.setValue(initialQuery);
    // 当前目录树下有会话时默认当前目录，否则全局
    this.scope = all.some((s) => this.inCurrentTree(s)) ? "current" : "all";
    this.refilter();
  }

  // Focusable：把焦点传给当前活跃的输入框（搜索框 / 重命名框），保证中文/IME 光标位置正确
  get focused(): boolean {
    return this._focused;
  }
  set focused(v: boolean) {
    this._focused = v;
    this.input.focused = v && !this.renaming;
    this.renameInput.focused = v && this.renaming;
  }

  getQuery(): string {
    return this.input.getValue().trim();
  }

  private query(): ParsedQuery {
    return parseQuery(this.getQuery());
  }

  /** 会话 cwd 是否等于当前目录或位于其子目录（monorepo / 子目录启动时同项目会话也算） */
  private inCurrentTree(s: PeekSession): boolean {
    const cur = normPath(this.currentCwd);
    const c = normPath(s.cwd);
    return c === cur || c.startsWith(cur + "/");
  }

  /** 重算过滤结果；keepSelection 时尽量保持原选中会话（用于重命名后） */
  private refilter(keepSelection = false): void {
    const prev = keepSelection ? this.filtered[this.selected] : undefined;
    const { kws, since } = this.query();
    let out = this.all;
    if (this.scope === "current") out = out.filter((s) => this.inCurrentTree(s));
    if (since) out = out.filter((s) => s.mtime >= since);
    if (kws.length) out = out.filter((s) => kws.every((k) => s.searchText.includes(k)));
    this.filtered = out;
    const idx = prev ? out.indexOf(prev) : -1;
    this.selected = idx >= 0 ? idx : keepSelection ? Math.min(this.selected, Math.max(0, out.length - 1)) : 0;
    if (!keepSelection) this.listOffset = 0;
    this.previewKey = ""; // 触发预览重建，buildPreview 会重新定位滚动位置
  }

  private bodyHeight(): number {
    const rows = process.stdout.rows || this.termRows || 24; // 实时读取，终端拉伸后布局跟随
    return Math.max(8, Math.min(rows - 12, 30));
  }

  handleInput(data: string): void {
    // 重命名输入态：Enter 提交，Esc 取消（不会误关界面）
    if (this.renaming) {
      if (matchesKey(data, Key.enter)) {
        const s = this.filtered[this.selected];
        const name = this.renameInput.getValue().trim();
        this.renaming = false;
        this.focused = this._focused; // 焦点还给搜索框
        this.invalidate();
        if (s && name && this.onRename) {
          void this.onRename(s, name).then((ok) => {
            if (ok) {
              s.name = name;
              // 名字参与搜索，同步重建索引；新名字可能不再匹配关键词，重算列表但尽量保住选中项
              s.searchText = (s.msgs.map((m) => m.text).join(" ") + " " + name + " " + s.cwd).toLowerCase();
              this.refilter(true);
            }
            this.invalidate();
            this.requestRender?.();
          });
        }
        return;
      }
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
        this.renaming = false;
        this.focused = this._focused;
        this.invalidate();
        return;
      }
      this.renameInput.handleInput(data);
      this.invalidate();
      return;
    }
    // 删除二次确认中：y 执行，任意其他键取消（含 Esc，不会误关界面）
    if (this.confirmingDelete) {
      this.confirmingDelete = false;
      this.invalidate();
      if (data === "y" || data === "Y" || matchesKey(data, Key.enter)) {
        const s = this.filtered[this.selected];
        if (s && this.onDelete) {
          void this.onDelete(s).then((ok) => {
            if (ok) {
              let i = this.all.indexOf(s);
              if (i >= 0) this.all.splice(i, 1);
              i = this.filtered.indexOf(s);
              if (i >= 0) this.filtered.splice(i, 1);
              // 选中位置保持在原位（夹取），预览重建
              this.selected = Math.min(this.selected, Math.max(0, this.filtered.length - 1));
              this.previewKey = "";
            }
            this.invalidate();
            this.requestRender?.();
          });
        }
      }
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onCancel?.();
      return;
    }
    if (matchesKey(data, Key.ctrl("d"))) {
      if (this.filtered.length && this.onDelete) {
        this.confirmingDelete = true;
        this.invalidate();
      }
      return;
    }
    if (matchesKey(data, Key.ctrl("r"))) {
      const s = this.filtered[this.selected];
      if (s && this.onRename) {
        this.renaming = true;
        this.renameInput.setValue(s.name || "");
        this.focused = this._focused; // 焦点切到重命名框
        this.invalidate();
      }
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
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("f"))) {
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
    if (matchesKey(data, Key.ctrl("o"))) {
      const s = this.filtered[this.selected];
      if (s) this.onFork?.(s);
      return;
    }
    // 其余按键交给输入框（字符、删除、光标移动、IME 等）
    const before = this.input.getValue();
    this.input.handleInput(data);
    if (this.input.getValue() !== before) this.refilter(); // 纯光标移动不重置选中/滚动
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
    const { kws } = this.query();
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
      const time = fmtTime(s.time);
      const cwdTail = s.cwd.replace(/\\/g, "/").split("/").slice(-2).join("/");
      // 关键词模式下显示命中条数（含任一关键词的消息数）
      const hitBadge = kws.length
        ? ` ·${s.msgs.reduce((n, m) => n + (anyKw(m.text.toLowerCase(), kws) ? 1 : 0), 0)}`
        : "";
      const l1 = `${sel ? "›" : " "} ${time} ${cwdTail}${hitBadge}`;
      // 第二行：有关键词时显示命中片段（高亮），否则显示首条消息
      const snip = snippet(s.msgs, kws, lw);
      const l2 = snip !== undefined
        ? `  ${highlight(snip, kws, t)}`
        : `  ${s.first}${s.name ? `  [${s.name}]` : ""}`;
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
    const key = s ? `${s.path}|${this.getQuery()}|${rw}` : "none";
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

    const { kws } = this.query();
    const MAX_MSGS = 500;
    const truncated = s.msgs.length > MAX_MSGS;
    const msgs = truncated ? s.msgs.slice(-MAX_MSGS) : s.msgs;
    if (truncated) {
      lines.push(t.fg("dim", `（会话过长，仅显示最后 ${MAX_MSGS} 条）`));
      lines.push("");
    }
    if (kws.length && !msgs.some((m) => anyKw(m.text.toLowerCase(), kws))) {
      const inTruncated = truncated && s.msgs.some((m) => anyKw(m.text.toLowerCase(), kws));
      lines.push(
        t.fg(
          "warning",
          inTruncated ? "关键词命中在未显示的更早消息中" : "关键词仅命中会话名或目录，对话正文无匹配",
        ),
      );
      lines.push("");
    }

    // 消息分界：用户消息整条用 userMessageBg 背景块（与 pi 聊天区风格一致），
    // AI 消息用细线标签，两者一眼可分
    const fillLabel = (label: string): string => {
      const w = visibleWidth(label);
      return truncateToWidth(label + " " + "─".repeat(Math.max(2, rw - w - 1)), rw);
    };

    for (const m of msgs) {
      const isMatch = kws.length > 0 && anyKw(m.text.toLowerCase(), kws);
      if (isMatch) this.matchLines.push(lines.length); // 记录 label 所在行
      const body = isMatch ? highlight(m.text, kws, t) : m.text;

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
    const H = this.bodyHeight();
    const cacheKey = width * 1000 + H; // 宽或高变化都要重绘
    if (this.cachedWidth === cacheKey) return this.cachedLines;
    const t = this.theme;
    const lw = Math.max(26, Math.min(56, Math.floor(width * 0.4)));
    const rw = Math.max(20, width - lw - 3);

    const out: string[] = [];

    // 头部
    const scopeLabel = this.scope === "all" ? "全局" : "当前目录树";
    const { sinceLabel } = this.query();
    const head =
      t.fg("accent", t.bold("🔍 会话搜索预览")) +
      t.fg("dim", "  范围[Tab]: ") +
      t.fg("warning", scopeLabel) +
      (sinceLabel ? t.fg("dim", "  时间: ") + t.fg("warning", sinceLabel) : "") +
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

    // 底部提示（重命名/删除确认时切换为对应操作行）
    out.push(t.fg("borderMuted", "─".repeat(width)));
    if (this.renaming) {
      const prefix = "✏ 重命名: ";
      const inputLine = this.renameInput.render(Math.max(10, width - visibleWidth(prefix)))[0] ?? "";
      out.push(truncateToWidth(t.fg("warning", prefix) + inputLine, width));
    } else if (this.confirmingDelete) {
      const s = this.filtered[this.selected];
      const desc = s ? `${fmtTime(s.time, true)} ${s.first.slice(0, 30)}` : "";
      out.push(
        truncateToWidth(
          t.fg("error", t.bold(`⚠ 删除会话 [${desc}]？按 y / Enter 确认，任意其他键取消`)),
          width,
        ),
      );
    } else {
      out.push(
        truncateToWidth(
          t.fg("dim", "↑↓ 选择  PgUp/Dn·^U/^F·⇧↑↓ 滚动  ^N/^P 命中  Tab 范围  ^D 删除  ^R 改名  ^O 分叉  Enter 进入  Esc/^C 关闭"),
          width,
        ),
      );
    }

    this.cachedWidth = cacheKey;
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
export const __peekTest = { scanSessions, PeekComponent, normPath, parseQuery, highlight, snippet };

export default function (pi: ExtensionAPI) {
  // ---- 终端启动形式: pi --peek / pi --peek=关键词 / pi --rp ----
  // 注意：pi 对 boolean 类型 flag 一律把值强转为 true，所以带关键词的形式必须是 string 类型
  pi.registerFlag("peek", {
    description: "启动时打开会话搜索预览并预填关键词（--peek=关键词）",
    type: "string",
  });
  pi.registerFlag("rp", {
    description: "启动时打开会话搜索预览（不带关键词）",
    type: "boolean",
  });

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") return; // 只在进程启动时触发，切换会话不重开
    const peek = pi.getFlag("peek");
    const rp = pi.getFlag("rp");
    if (!peek && !rp) return;
    const kw = typeof peek === "string" ? peek.trim() : "";
    const cmd = `/peek${kw ? ` ${kw}` : ""}`;

    // 等 UI 就绪再弹出；agent 忙（如带了初始 prompt）则排队到结束后
    const tryOpen = (attempt: number) => {
      try {
        if (ctx.isIdle()) {
          pi.sendUserMessage(cmd, { expandPromptTemplates: true });
        } else if (attempt < 20) {
          setTimeout(() => tryOpen(attempt + 1), 150);
        } else {
          pi.sendUserMessage(cmd, { expandPromptTemplates: true, deliverAs: "followUp" });
        }
      } catch {
        // 进程已退出 / 扩展已重载：API 失效，静默放弃（定时器里抛错会变成未捕获异常）
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
      type Picked = { s: PeekSession; action: "resume" | "fork" } | null;
      const picked = await ctx.ui.custom<Picked>((tui, theme, _kb, done) => {
        const comp = new PeekComponent(all, ctx.cwd, theme, process.stdout.rows || 24, initial);
        comp.requestRender = () => tui.requestRender();
        comp.onResume = (s) => {
          lastQuery = comp.getQuery();
          done({ s, action: "resume" });
        };
        comp.onFork = (s) => {
          lastQuery = comp.getQuery();
          done({ s, action: "fork" });
        };
        comp.onCancel = () => {
          lastQuery = comp.getQuery();
          done(null);
        };
        // 删除：与自带 /resume 一致，有 trash 走回收站，没有则直接删文件
        comp.onDelete = async (s) => {
          let ok = false;
          try {
            const r = await pi.exec("trash", [s.path], { timeout: 4000 });
            ok = r.code === 0;
          } catch {
            ok = false;
          }
          if (!ok) {
            try {
              rmSync(s.path, { force: true });
              ok = true;
            } catch {
              ok = false;
            }
          }
          ctx.ui.notify(
            ok ? `已删除会话 ${basename(s.path)}` : "删除会话失败",
            ok ? "info" : "error",
          );
          return ok;
        };
        // 重命名：追加 pi 原生 session_info 条目（与 /name、自带选择器 Ctrl+R 同构）
        comp.onRename = async (s, name) => {
          let ok = false;
          try {
            // parentId 取文件最后一条可解析条目的 id（追加到树叶子）
            const lines = readFileSync(s.path, "utf8").split("\n");
            let parentId: string | null = null;
            for (let i = lines.length - 1; i >= 0; i--) {
              if (!lines[i]) continue;
              try {
                const o = JSON.parse(lines[i]);
                if (typeof o.id === "string") {
                  parentId = o.id;
                  break;
                }
              } catch {
                // 最后一行可能是写了一半的行，继续向上找
              }
            }
            const entry = {
              type: "session_info",
              id: randomBytes(4).toString("hex"),
              parentId,
              timestamp: new Date().toISOString(),
              name,
            };
            appendFileSync(s.path, JSON.stringify(entry) + "\n", "utf8");
            ok = true;
          } catch {
            ok = false;
          }
          ctx.ui.notify(ok ? `已重命名为「${name}」` : "重命名失败", ok ? "info" : "error");
          return ok;
        };
        return comp;
      });

      if (!picked) return;

      let target = picked.s.path;
      if (picked.action === "fork") {
        // 与 pi --fork 同构：复制全部条目到新文件，header 记录 parentSession，cwd 设为当前目录
        try {
          const forked = SessionManager.forkFrom(picked.s.path, ctx.cwd);
          target = forked.getSessionFile() ?? target;
          ctx.ui.notify(`已分叉为新会话 ${basename(target)}`, "info");
        } catch (e) {
          ctx.ui.notify(`分叉失败：${e instanceof Error ? e.message : String(e)}`, "error");
          return;
        }
      }

      const result = await ctx.switchSession(target);
      if (result?.cancelled) {
        ctx.ui.notify("切换会话已取消", "info");
      }
    },
  });
}

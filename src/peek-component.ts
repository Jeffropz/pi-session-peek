import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { msg } from "./i18n.ts";
import { anyKw, highlight, parseQuery, snippet, type ParsedQuery } from "./query.ts";
import type { PeekSession } from "./sessions.ts";
import { fmtTime, normPath, padEndVisible, wrapLines } from "./text.ts";

// 双栏选择器。文件操作（删除 / 重命名 / 分叉）不在这里做，由 index.ts 通过回调注入

export class PeekComponent implements Component, Focusable {
  private input: Input;
  private scope: "current" | "all";
  private filtered: PeekSession[] = [];
  private selected = 0;
  private listOffset = 0;
  private previewOffset = 0;
  private previewKey = ""; // 预览缓存的键（会话 + 关键词 + 宽度），置空强制重建
  private previewLines: string[] = [];
  private matchLines: number[] = []; // 预览里命中消息所在的行，Ctrl+N / Ctrl+P 用
  private confirmingDelete = false; // Ctrl+D 之后等待确认
  private renaming = false; // Ctrl+R 之后正在输入名字
  private renameInput: Input;
  private cachedWidth = -1;
  private cachedLines: string[] = [];
  private _focused = false;

  // 由 index.ts 注入
  onResume?: (s: PeekSession) => void;
  onFork?: (s: PeekSession) => void;
  onCancel?: () => void;
  onDelete?: (s: PeekSession) => Promise<boolean>;
  onRename?: (s: PeekSession, name: string) => Promise<boolean>;
  requestRender?: () => void; // 异步操作完成后让 TUI 重画

  constructor(
    private all: PeekSession[],
    private currentCwd: string,
    private theme: any,
    private termRows: number,
    initialQuery: string,
  ) {
    this.input = new Input({ placeholder: msg("searchPlaceholder") });
    this.renameInput = new Input({ placeholder: msg("renamePlaceholder") });
    if (initialQuery) this.input.setValue(initialQuery);
    // 当前目录树下有会话就默认当前目录，否则全局
    this.scope = all.some((s) => this.inCurrentTree(s)) ? "current" : "all";
    this.refilter();
  }

  // 焦点要落到真正在用的那个输入框上，否则 IME 候选框位置不对
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

  // 等于当前目录，或在它的子目录下
  private inCurrentTree(s: PeekSession): boolean {
    const cur = normPath(this.currentCwd);
    const c = normPath(s.cwd);
    return c === cur || c.startsWith(cur + "/");
  }

  // keepSelection：尽量保持原来选中的会话，重命名后用
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
    this.previewKey = "";
  }

  private bodyHeight(): number {
    const rows = process.stdout.rows || this.termRows || 24; // 每次都读，终端拉伸后布局跟着变
    return Math.max(8, Math.min(rows - 12, 30));
  }

  handleInput(data: string): void {
    // 重命名输入中：Enter 提交，Esc / Ctrl+C 取消，其他键交给输入框
    if (this.renaming) {
      if (matchesKey(data, Key.enter)) {
        const s = this.filtered[this.selected];
        const name = this.renameInput.getValue().trim();
        this.renaming = false;
        this.focused = this._focused;
        this.invalidate();
        if (s && name && this.onRename) {
          void this.onRename(s, name).then((ok) => {
            if (ok) {
              s.name = name;
              // 名字参与搜索，改完可能就不再匹配当前关键词了
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
    // 删除确认中：y / Enter 执行，其他任何键取消
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
              // 选中位置留在原地
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
        this.focused = this._focused;
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
    // 其余按键交给搜索框
    const before = this.input.getValue();
    this.input.handleInput(data);
    if (this.input.getValue() !== before) this.refilter(); // 光标移动不算输入，别重置列表
    this.invalidate();
  }

  // 预览里跳到下一个 / 上一个命中，到头了回绕
  private jumpMatch(dir: 1 | -1): void {
    if (!this.matchLines.length) return;
    const cur = this.previewOffset + 2;
    let target: number | undefined;
    if (dir === 1) {
      target = this.matchLines.find((l) => l > cur) ?? this.matchLines[0];
    } else {
      target = [...this.matchLines].reverse().find((l) => l < cur) ?? this.matchLines[this.matchLines.length - 1];
    }
    if (target !== undefined) {
      this.previewOffset = Math.max(0, target - 2);
      this.invalidate();
    }
  }

  // 左栏，每个会话两行
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
      // 有关键词时显示命中的消息数
      const hitBadge = kws.length
        ? ` ·${s.msgs.reduce((n, m) => n + (anyKw(m.text.toLowerCase(), kws) ? 1 : 0), 0)}`
        : "";
      const l1 = `${sel ? "›" : " "} ${time} ${cwdTail}${hitBadge}`;
      // 第二行：有关键词时显示命中片段，否则显示首条消息
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

  // 右栏。有关键词时滚到第一个命中处，没有时滚到底部看最新消息
  private buildPreview(rw: number): void {
    const t = this.theme;
    const s = this.filtered[this.selected];
    const key = s ? `${s.path}|${this.getQuery()}|${rw}` : "none";
    if (key === this.previewKey) return;
    this.previewKey = key;
    this.matchLines = [];

    if (!s) {
      this.previewLines = [t.fg("dim", msg("noMatch"))];
      this.previewOffset = 0;
      return;
    }

    const lines: string[] = [];
    lines.push(
      truncateToWidth(
        t.fg("dim", `${s.cwd} • ${msg("msgCount", { n: s.msgs.length })}${s.name ? " • " + s.name : ""}`),
        rw,
      ),
    );
    lines.push("");

    const { kws } = this.query();
    const MAX_MSGS = 500;
    const truncated = s.msgs.length > MAX_MSGS;
    const msgs = truncated ? s.msgs.slice(-MAX_MSGS) : s.msgs;
    if (truncated) {
      lines.push(t.fg("dim", msg("truncated", { n: MAX_MSGS })));
      lines.push("");
    }
    if (kws.length && !msgs.some((m) => anyKw(m.text.toLowerCase(), kws))) {
      const inTruncated = truncated && s.msgs.some((m) => anyKw(m.text.toLowerCase(), kws));
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

    for (const m of msgs) {
      const isMatch = kws.length > 0 && anyKw(m.text.toLowerCase(), kws);
      if (isMatch) this.matchLines.push(lines.length);
      const body = isMatch ? highlight(m.text, kws, t) : m.text;

      if (m.role === "user") {
        lines.push(
          t.bg("userMessageBg", padEndVisible(t.bold(t.fg("accent", fillLabel(msg("you")))), rw)),
        );
        for (const wl of wrapLines(body, rw - 2)) {
          lines.push(t.bg("userMessageBg", padEndVisible(" " + wl, rw)));
        }
      } else {
        lines.push(t.fg("muted", fillLabel(msg("ai"))));
        for (const wl of wrapLines(body, rw - 2)) lines.push(" " + wl);
      }
      lines.push("");
    }

    this.previewLines = lines;

    if (this.matchLines.length) {
      this.previewOffset = Math.max(0, this.matchLines[0] - 2);
    } else {
      this.previewOffset = Math.max(0, lines.length - this.bodyHeight());
    }
  }

  render(width: number): string[] {
    const H = this.bodyHeight();
    const cacheKey = width * 1000 + H; // 宽或高变了都要重画
    if (this.cachedWidth === cacheKey) return this.cachedLines;
    const t = this.theme;
    const lw = Math.max(26, Math.min(56, Math.floor(width * 0.4)));
    const rw = Math.max(20, width - lw - 3);

    const out: string[] = [];

    // 头部：标题、范围、时间过滤、匹配数，然后是搜索框
    const scopeLabel = this.scope === "all" ? msg("scopeAll") : msg("scopeCurrent");
    const { sinceLabel } = this.query();
    const head =
      t.fg("accent", t.bold(msg("title"))) +
      t.fg("dim", msg("scopeLabel")) +
      t.fg("warning", scopeLabel) +
      (sinceLabel ? t.fg("dim", msg("timeLabel")) + t.fg("warning", sinceLabel) : "") +
      t.fg("dim", msg("matchCount", { n: this.filtered.length, total: this.all.length }));
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
      // 左栏在 buildList 里已经 pad 到 lw，这里再 pad 会把带样式的行截坏
      out.push(l + t.fg("borderMuted", " │ ") + padEndVisible(r, rw));
    }

    // 底部：重命名和删除确认时换成对应的操作行
    out.push(t.fg("borderMuted", "─".repeat(width)));
    if (this.renaming) {
      const prefix = msg("renamePrefix");
      const inputLine = this.renameInput.render(Math.max(10, width - visibleWidth(prefix)))[0] ?? "";
      out.push(truncateToWidth(t.fg("warning", prefix) + inputLine, width));
    } else if (this.confirmingDelete) {
      const s = this.filtered[this.selected];
      const desc = s ? `${fmtTime(s.time, true)} ${s.first.slice(0, 30)}` : "";
      out.push(
        truncateToWidth(
          t.fg("error", t.bold(msg("confirmDelete", { desc }))),
          width,
        ),
      );
    } else {
      out.push(
        truncateToWidth(
          t.fg("dim", msg("footer")),
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

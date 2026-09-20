import {
  Input,
  Key,
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import { msg } from "./i18n.ts";
import { anyKw, highlight, kwRegExps, lineHasKw, matchesSession, parseQuery, snippet, type ParsedQuery } from "./query.ts";
import type { PeekMsg, PeekSession } from "./sessions.ts";
import { fmtTime, normPath, padEndVisible } from "./text.ts";

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
  private matchLines: number[] = []; // 预览里含关键词的行（升序），Ctrl+N / Ctrl+P 用
  private rendered = new WeakMap<PeekMsg, { w: number; lines: string[] }>(); // 每条消息渲染好的行，按宽度缓存
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
    private mdTheme: MarkdownTheme,
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
    if (kws.length) {
      const res = kwRegExps(kws);
      out = out.filter((s) => matchesSession(s, res));
    }
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

  // 预览里跳到当前视口之外的下一个 / 上一个命中行，到头了回绕。同一屏里的多个命中算一处，
  // 否则一段里连着几行都命中要按好几次才过得去
  private jumpMatch(dir: 1 | -1): void {
    if (!this.matchLines.length) return;
    const H = this.bodyHeight();
    const top = this.previewOffset;
    const bottom = Math.min(top + H, this.previewLines.length) - 1;
    let target: number | undefined;
    if (dir === 1) {
      target = this.matchLines.find((l) => l > bottom) ?? this.matchLines[0];
    } else {
      target = [...this.matchLines].reverse().find((l) => l < top) ?? this.matchLines[this.matchLines.length - 1];
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
    // 每项两行，height 是奇数时会少一行，补空行，否则最后一行右栏会顶到左边
    while (rows.length < height) rows.push(" ".repeat(lw));
    return rows.slice(0, height);
  }

  // 用 pi 自己的 Markdown 组件渲染一条消息，和主界面里的对话长得一样；参数照抄 pi 的
  // user-message / assistant-message 组件。渲染比较贵，按消息和宽度缓存，换关键词时不用重来
  private renderMsg(m: PeekMsg, rw: number): string[] {
    const hit = this.rendered.get(m);
    if (hit && hit.w === rw) return hit.lines;
    const t = this.theme;
    const md =
      m.role === "user"
        ? new Markdown(
            m.text,
            1,
            0,
            this.mdTheme,
            { color: (s) => t.fg("userMessageText", s), bgColor: (s) => t.bg("userMessageBg", s) },
            { preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
          )
        : new Markdown(m.text, 1, 0, this.mdTheme);
    const lines = md.render(rw);
    this.rendered.set(m, { w: rw, lines });
    return lines;
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
      const head = lines.length;
      if (m.role === "user") {
        lines.push(
          t.bg("userMessageBg", padEndVisible(t.bold(t.fg("accent", fillLabel(msg("you")))), rw)),
        );
      } else {
        lines.push(t.fg("muted", fillLabel(msg("ai"))));
      }
      // 先渲染再高亮：往 markdown 源码里插转义码会把链接、代码块的语法弄坏
      const before = this.matchLines.length;
      for (const l of this.renderMsg(m, rw)) {
        if (isMatch && lineHasKw(l, kws)) this.matchLines.push(lines.length);
        lines.push(isMatch ? highlight(l, kws, t) : l);
      }
      // 关键词被折行拆开时哪一行都找不到，退回到消息标题行，别把这条消息漏掉
      if (isMatch && this.matchLines.length === before) this.matchLines.push(head);
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
    // 右上角：有命中时显示"第几处/共几处"（视口内第一个命中的序号），行数多时再加行号范围
    const end = Math.min(this.previewOffset + H, this.previewLines.length);
    let info = "";
    if (this.matchLines.length) {
      const i = this.matchLines.findIndex((l) => l >= this.previewOffset && l < end);
      info += msg("hitPos", { k: i >= 0 ? String(i + 1) : "-", n: this.matchLines.length });
    }
    if (this.previewLines.length > H) info += ` (${this.previewOffset + 1}-${end}/${this.previewLines.length})`;
    const scrollInfo = info ? t.fg("dim", info) : "";

    for (let i = 0; i < H; i++) {
      const l = leftRows[i] ?? " ".repeat(lw);
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

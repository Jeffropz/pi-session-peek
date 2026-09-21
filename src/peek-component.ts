import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type MarkdownTheme,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { msg } from "./i18n.ts";
import { BODY_TOP, bodyRows, paneWidths, SEP } from "./layout.ts";
import { buildList, followSelection, listRows, visibleItems } from "./list.ts";
import { buildPreview, initialOffset, nextMatchTarget, type RenderCache } from "./preview.ts";
import { matchesSession, parseQuery, roleTerms, type ParsedQuery, type RoleTerms } from "./query.ts";
import { bounds, highlightColumns, rowColumns, selectionText, type Cell, type Pane, type Selection } from "./selection.ts";
import type { PeekSession } from "./sessions.ts";
import { fmtTime, normPath, padEndVisible } from "./text.ts";
import type { PeekTheme } from "./theme.ts";

// 双栏选择器。文件操作（删除 / 重命名 / 分叉）不在这里做，由 index.ts 通过回调注入。
// 几何常量在 layout.ts，左栏在 list.ts，右栏在 preview.ts

const WHEEL_LINES = 3; // 滚轮每格滚几行预览，和 Shift+↑↓ 一样
const AUTO_SCROLL_MS = 50; // 拖选拖出预览上下边时自动滚动的节奏，和 pi-tui 一样
const HINT_MS = 1500; // 底部"已复制"提示停留时间

export class PeekComponent implements Component, Focusable {
  private input: Input;
  private scope: "current" | "all";
  private filtered: PeekSession[] = [];
  private selected = 0;
  private listOffset = 0;
  private previewOffset = 0;
  private previewKey = ""; // 预览缓存的键（会话 + 关键词 + 宽度 + 工具开关），置空强制重建
  private showTools = false; // Ctrl+T：预览里显示每次工具调用的一行摘要
  private previewLines: string[] = [];
  private matchLines: number[] = []; // 预览里含关键词的行（升序），Ctrl+N / Ctrl+P 用
  private rendered: RenderCache = new WeakMap(); // 每条消息渲染好的行，按宽度缓存
  private confirmingDelete = false; // Ctrl+D 之后等待确认
  private renaming = false; // Ctrl+R 之后正在输入名字
  private busy = false; // 删除 / 重命名的异步回调还没回来：期间不能再删、改名、进入或分叉，免得对同一个文件动两次
  private renameInput: Input;
  private cachedWidth = -1;
  private cachedLines: string[] = [];
  private layout = { lw: 0, rw: 0, H: 0 }; // 最近一次 render 的分栏尺寸，鼠标定位用
  private scopeSpan: [number, number] = [0, 0]; // 头部"范围"字样占的列区间，点击切换范围
  private sel?: Selection; // 鼠标拖出来的选区，只在一栏里
  private dragging = false; // 左键还按着
  private selMoved = false; // 按下之后拖过没有；没拖过的选区不显示也不算数（那是单击）
  private dragX = 0; // 最近一次拖动的列，自动滚动时焦点跟着它
  private autoScrollDir = 0; // 拖出预览上下边：-1 往上 1 往下
  private autoScrollTimer?: ReturnType<typeof setInterval>;
  private hint?: { text: string; ok: boolean }; // 底部一闪而过的复制结果
  private hintTimer?: ReturnType<typeof setTimeout>;
  private _focused = false;

  // 由 index.ts 注入
  onResume?: (s: PeekSession) => void;
  onFork?: (s: PeekSession) => void;
  onCancel?: () => void;
  onDelete?: (s: PeekSession) => Promise<boolean>;
  onRename?: (s: PeekSession, name: string) => Promise<boolean>;
  onCopy?: (text: string) => Promise<boolean>; // 拖选后 Ctrl+C
  onDispose?: () => void; // 关闭时
  requestRender?: () => void; // 异步操作完成后让 TUI 重画
  afterRender?: () => void; // 每次 render 之后调用；常规模式的鼠标桥接靠它重新测组件在屏幕上的位置

  constructor(
    private all: PeekSession[],
    private currentCwd: string,
    private theme: PeekTheme,
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
    const { terms, since } = this.query();
    let out = this.all;
    if (this.scope === "current") out = out.filter((s) => this.inCurrentTree(s));
    if (since) out = out.filter((s) => s.mtime >= since);
    if (terms.length) out = out.filter((s) => matchesSession(s, terms));
    this.filtered = out;
    const idx = prev ? out.indexOf(prev) : -1;
    this.selected = idx >= 0 ? idx : keepSelection ? Math.min(this.selected, Math.max(0, out.length - 1)) : 0;
    if (!keepSelection) this.listOffset = 0;
    this.previewKey = "";
    this.clearSelection();
  }

  // 换选中的会话：预览重建，拖选的选区作废
  private select(idx: number): void {
    this.selected = idx;
    this.previewKey = "";
    this.clearSelection();
  }

  private clearSelection(): void {
    this.sel = undefined;
    this.dragging = false;
    this.selMoved = false;
    this.stopAutoScroll();
  }

  // 拖过的才算选区，只按下没拖的是单击
  private activeSel(): Selection | undefined {
    return this.sel && this.selMoved ? this.sel : undefined;
  }

  dispose(): void {
    this.stopAutoScroll();
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintTimer = undefined;
    this.onDispose?.();
  }

  private bodyHeight(): number {
    return bodyRows(this.termRows);
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
        if (s && name && this.onRename && !this.busy) {
          this.busy = true;
          void this.onRename(s, name).then((ok) => {
            if (ok) {
              s.name = name;
              // 名字参与搜索，改完可能就不再匹配当前关键词了
              this.refilter(true);
            }
          }).catch(() => {
            // 回调自己负责提示；这里吞掉，别变成 unhandled rejection
          }).finally(() => {
            // 放在 finally：回调抛了错也要解锁，否则删除 / 改名 / 进入全部永久失效
            this.busy = false;
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
        if (s && this.onDelete && !this.busy) {
          this.busy = true;
          void this.onDelete(s).then((ok) => {
            if (ok) {
              let i = this.all.indexOf(s);
              if (i >= 0) this.all.splice(i, 1);
              i = this.filtered.indexOf(s);
              if (i >= 0) this.filtered.splice(i, 1);
              // 选中位置留在原地
              this.selected = Math.min(this.selected, Math.max(0, this.filtered.length - 1));
              this.previewKey = "";
              this.clearSelection();
            }
          }).catch(() => {
          }).finally(() => {
            this.busy = false;
            this.invalidate();
            this.requestRender?.();
          });
        }
      }
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      // 有拖选的选区时 Ctrl+C 是复制，和终端里的习惯一样；没有才是关闭
      if (matchesKey(data, Key.ctrl("c")) && this.activeSel()) {
        this.copySelection();
        return;
      }
      this.onCancel?.();
      return;
    }
    if (matchesKey(data, Key.ctrl("d"))) {
      if (this.filtered.length && this.onDelete && !this.busy) {
        this.confirmingDelete = true;
        this.invalidate();
      }
      return;
    }
    if (matchesKey(data, Key.ctrl("r"))) {
      const s = this.filtered[this.selected];
      if (s && this.onRename && !this.busy) {
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
        this.select(this.selected - 1);
        this.invalidate();
      }
      return;
    }
    if (matchesKey(data, Key.down)) {
      if (this.selected < this.filtered.length - 1) {
        this.select(this.selected + 1);
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
    if (matchesKey(data, Key.ctrl("t"))) {
      this.showTools = !this.showTools;
      this.previewKey = "";
      this.clearSelection();
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
      if (s && !this.busy) this.onResume?.(s);
      return;
    }
    if (matchesKey(data, Key.ctrl("o"))) {
      const s = this.filtered[this.selected];
      if (s && !this.busy) this.onFork?.(s);
      return;
    }
    // 其余按键交给搜索框
    const before = this.input.getValue();
    this.input.handleInput(data);
    if (this.input.getValue() !== before) this.refilter(); // 光标移动不算输入，别重置列表
    this.invalidate();
  }

  // 硬件光标在组件内的行号：搜索框在第 1 行，改名时在最后一行。常规模式的鼠标桥接靠它算组件顶行
  cursorRow(): number | undefined {
    if (!this._focused || !this.layout.H) return undefined;
    return this.renaming ? BODY_TOP + this.layout.H + 1 : 1;
  }

  // 鼠标：左栏按下选中、双击进入、滚轮换选中项；右栏滚轮滚预览；点头部"范围"切换；点输入框移光标；
  // 在任一栏里按住拖动是选文字，只选这一栏，Ctrl+C 复制。
  // 全屏模式由 pi-tui 按布局直接调，常规模式由 mouse.ts 换算成组件内坐标后调。坐标以组件左上角为原点
  handleMouse(ev: TuiMouseEvent): TuiMouseEventResult | undefined {
    const { lw, H } = this.layout;
    if (!H) return undefined; // 还没画过，不知道分栏在哪
    const inList = ev.x < lw;
    const bodyRow = ev.y - BODY_TOP;
    const inBody = bodyRow >= 0 && bodyRow < H;
    const itemAt = (): number => (inList && inBody ? this.listOffset + (bodyRow >> 1) : -1); // 每项两行

    if (ev.type === "wheel") {
      const delta = ev.wheelDelta ?? 0;
      if (!delta) return undefined;
      let changed = this.confirmingDelete; // 和按键一样，滚一下就算取消确认，免得删错换过去的那条
      this.confirmingDelete = false;
      if (inList) {
        if (!this.renaming) {
          // 改名中换了会话就改错对象了
          const next = Math.max(0, Math.min(this.filtered.length - 1, this.selected + delta));
          if (next !== this.selected) {
            this.select(next);
            changed = true;
          }
        }
      } else {
        const maxOff = Math.max(0, this.previewLines.length - H);
        const next = Math.max(0, Math.min(maxOff, this.previewOffset + delta * WHEEL_LINES));
        if (next !== this.previewOffset) {
          this.previewOffset = next;
          changed = true;
        }
      }
      if (changed) this.invalidate();
      return { handled: true, render: changed };
    }
    if (ev.type === "drag") {
      if (!this.dragging || !this.sel || ev.button !== "left") return undefined;
      this.dragX = ev.x;
      const changed = this.dragTo(ev.x, ev.y);
      if (changed) this.selMoved = true;
      // 右栏拖出上下边就自动滚；左栏不滚，列表是跟着选中项走的
      if (this.sel.pane === "preview") this.setAutoScroll(bodyRow < 0 ? -1 : bodyRow >= H ? 1 : 0);
      if (changed) this.invalidate();
      return { handled: true, render: changed };
    }
    if (ev.button !== "left") return undefined;
    if (ev.type === "release") {
      if (!this.dragging) return undefined;
      this.dragging = false;
      this.stopAutoScroll();
      if (!this.selMoved) this.sel = undefined; // 没拖过就是单击
      return { handled: true, render: false };
    }
    if (ev.type === "click") {
      // 单击在 press 里已经选中了，双击才进入
      const s = this.filtered[itemAt()];
      if (!s) return undefined;
      if (!this.renaming && !this.busy && (ev.clickCount ?? 1) >= 2) this.onResume?.(s);
      return { handled: true, render: false };
    }
    if (ev.type !== "press") return undefined;

    // 删除确认和已有的选区：点一下就没了，和按键一样
    let changed = this.confirmingDelete || this.activeSel() !== undefined;
    this.confirmingDelete = false;
    this.clearSelection();
    let handled = changed;
    if (this.renaming) {
      if (ev.y === BODY_TOP + H + 1) {
        // 改名行：点哪里光标就去哪里
        this.renameInput.handleMouse({ ...ev, x: ev.x - visibleWidth(msg("renamePrefix")), y: 0 });
        handled = changed = true;
      }
    } else if (ev.y === 1) {
      this.input.handleMouse({ ...ev, y: 0 });
      handled = changed = true;
    } else if (ev.y === 0) {
      if (ev.x >= this.scopeSpan[0] && ev.x < this.scopeSpan[1]) {
        this.scope = this.scope === "all" ? "current" : "all";
        this.refilter();
        handled = changed = true;
      }
    } else {
      const idx = itemAt();
      if (idx >= 0 && idx < this.filtered.length && idx !== this.selected) {
        this.select(idx);
        changed = true;
      }
    }
    if (inBody) {
      // 两栏里按下都可能是拖选的起点，拖起来才算数；接管后面的拖动和松开
      const pane: Pane = inList ? "list" : "preview";
      const cell = this.cellAt(pane, ev.x, bodyRow);
      this.sel = { pane, anchor: cell, focus: { ...cell } };
      this.dragging = true;
      this.dragX = ev.x;
      handled = true;
    }
    if (!handled) return undefined;
    if (changed) this.invalidate();
    return inBody ? { handled: true, capture: true, render: changed } : { handled: true, render: changed };
  }

  // 屏幕位置换成某一栏的内容坐标：行是内容的绝对行号，列夹在这一栏里，拖到栏外也只选栏内的字
  private cellAt(pane: Pane, x: number, bodyRow: number): Cell {
    const { lw, rw, H } = this.layout;
    const row = Math.max(0, Math.min(H - 1, bodyRow));
    if (pane === "list") return { row: this.listOffset * 2 + row, col: Math.max(0, Math.min(lw - 1, x)) };
    return { row: this.previewOffset + row, col: Math.max(0, Math.min(rw - 1, x - lw - SEP)) };
  }

  // 拖到某个位置：焦点跟过去。返回有没有变
  private dragTo(x: number, y: number): boolean {
    if (!this.sel) return false;
    const cell = this.cellAt(this.sel.pane, x, y - BODY_TOP);
    if (cell.row === this.sel.focus.row && cell.col === this.sel.focus.col) return false;
    this.sel.focus = cell;
    return true;
  }

  private setAutoScroll(dir: number): void {
    this.autoScrollDir = dir;
    if (!dir) {
      this.stopAutoScroll();
      return;
    }
    if (this.autoScrollTimer) return;
    this.autoScrollTimer = setInterval(() => this.autoScrollTick(), AUTO_SCROLL_MS);
    this.autoScrollTimer.unref?.();
  }

  // 每次滚一行，焦点跟着指针：指针在上边就是视口第一行，在下边就是最后一行
  private autoScrollTick(): void {
    const { H } = this.layout;
    const maxOff = Math.max(0, this.previewLines.length - H);
    const next = Math.max(0, Math.min(maxOff, this.previewOffset + this.autoScrollDir));
    if (!this.sel || !this.dragging || next === this.previewOffset) {
      this.stopAutoScroll();
      return;
    }
    this.previewOffset = next;
    if (this.dragTo(this.dragX, this.autoScrollDir < 0 ? BODY_TOP - 1 : BODY_TOP + H)) this.selMoved = true;
    this.invalidate();
    this.requestRender?.();
  }

  private stopAutoScroll(): void {
    if (this.autoScrollTimer) clearInterval(this.autoScrollTimer);
    this.autoScrollTimer = undefined;
    this.autoScrollDir = 0;
  }

  // 选区里的纯文本
  private selectionToText(sel: Selection): string {
    const { lw, rw } = this.layout;
    if (sel.pane === "preview") return selectionText(sel, rw, (row) => this.previewLines[row]);
    const { rt, hasBody } = this.listTerms();
    return selectionText(sel, lw, (row) => {
      const s = this.filtered[row >> 1];
      return s && listRows(s, (row >> 1) === this.selected, lw, rt, hasBody, this.theme)[row & 1];
    });
  }

  // Ctrl+C：复制选区，清掉高亮，底部闪一下结果
  private copySelection(): void {
    const sel = this.activeSel();
    if (!sel) return;
    const text = this.selectionToText(sel);
    const n = text.split("\n").length;
    this.clearSelection();
    this.invalidate();
    if (!text.trim() || !this.onCopy) return;
    void this.onCopy(text).then((ok) => this.showHint(ok ? msg("copied", { n }) : msg("copyFailed"), ok));
  }

  private showHint(text: string, ok: boolean): void {
    this.hint = { text, ok };
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => {
      this.hintTimer = undefined;
      this.hint = undefined;
      this.invalidate();
      this.requestRender?.();
    }, HINT_MS);
    this.hintTimer.unref?.();
    this.invalidate();
    this.requestRender?.();
  }

  // 预览里跳到当前视口之外的下一个 / 上一个命中行，到头了回绕
  private jumpMatch(dir: 1 | -1): void {
    const H = this.bodyHeight();
    const top = this.previewOffset;
    const bottom = Math.min(top + H, this.previewLines.length) - 1;
    const target = nextMatchTarget(this.matchLines, top, bottom, dir);
    if (target !== undefined) {
      this.previewOffset = Math.max(0, target - 2);
      this.invalidate();
    }
  }

  // 左栏用的关键词：排除词和 name: / cwd: 不在正文里高亮
  private listTerms(): { rt: RoleTerms; hasBody: boolean } {
    const rt = roleTerms(this.query().terms);
    return { rt, hasBody: rt.user.length > 0 || rt.assistant.length > 0 };
  }

  // 右栏。预览键（会话 + 关键词 + 宽度 + 工具开关）没变就复用；变了重建，滚动位置放到首个命中处或底部
  private rebuildPreview(rw: number, rt: RoleTerms): void {
    const s = this.filtered[this.selected];
    const key = s ? `${s.path}|${this.getQuery()}|${rw}|${this.showTools ? "t" : ""}` : "none";
    if (key === this.previewKey) return;
    this.previewKey = key;
    const p = buildPreview(s, rt, rw, this.showTools, this.theme, this.mdTheme, this.rendered);
    this.previewLines = p.lines;
    this.matchLines = p.matchLines;
    this.previewOffset = initialOffset(p, this.bodyHeight());
  }

  render(width: number): string[] {
    const H = this.bodyHeight();
    const cacheKey = width * 1000 + H; // 宽或高变了都要重画
    if (this.cachedWidth === cacheKey) {
      // 缓存命中时组件在屏幕上的位置也可能变了（上面多了一行状态提示），照样通知一次，桥接那边自己去重
      this.afterRender?.();
      return this.cachedLines;
    }
    const t = this.theme;
    const { lw, rw } = paneWidths(width);
    this.layout = { lw, rw, H };

    const out: string[] = [];

    // 头部：标题、范围、时间过滤、匹配数，然后是搜索框
    const scopeLabel = this.scope === "all" ? msg("scopeAll") : msg("scopeCurrent");
    const { sinceLabel } = this.query();
    // 「范围[Tab]: 当前目录树」整段都能点
    const scopeStart = visibleWidth(msg("title"));
    this.scopeSpan = [scopeStart, scopeStart + visibleWidth(msg("scopeLabel") + scopeLabel)];
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
    const { rt, hasBody } = this.listTerms();
    this.rebuildPreview(rw, rt);
    this.listOffset = followSelection(this.selected, this.listOffset, visibleItems(H));
    const leftRows = buildList(this.filtered, this.selected, this.listOffset, H, lw, rt, hasBody, t);

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

    const sel = this.activeSel();
    for (let i = 0; i < H; i++) {
      let l = leftRows[i] ?? " ".repeat(lw);
      let r = rightRows[i] ?? "";
      const infoW = i === 0 && scrollInfo ? visibleWidth(scrollInfo) : 0;
      if (infoW) r = truncateToWidth(r, Math.max(0, rw - infoW));
      r = padEndVisible(r, rw - infoW) + (infoW ? scrollInfo : "");
      // 拖选的高亮最后叠上去，反显整格；右栏第一行别盖到右上角的命中信息
      if (sel?.pane === "list") {
        const cols = rowColumns(sel, this.listOffset * 2 + i, l, lw);
        if (cols) l = highlightColumns(l, cols[0], cols[1]);
      } else if (sel?.pane === "preview") {
        const cols = rowColumns(sel, this.previewOffset + i, r, rw - infoW);
        if (cols) r = highlightColumns(r, cols[0], cols[1]);
      }
      // 左栏在 buildList 里已经 pad 到 lw，这里再 pad 会把带样式的行截坏
      out.push(l + t.fg("borderMuted", " │ ") + r);
    }

    // 底部：重命名和删除确认时换成对应的操作行，复制结果和选区提示也在这里
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
    } else if (this.hint) {
      out.push(truncateToWidth(t.fg(this.hint.ok ? "success" : "error", this.hint.text), width));
    } else if (sel) {
      const [s, e] = bounds(sel);
      out.push(truncateToWidth(t.fg("warning", msg("selHint", { n: e.row - s.row + 1 })), width));
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
    this.afterRender?.();
    return out;
  }

  invalidate(): void {
    this.cachedWidth = -1;
    this.input.invalidate();
  }
}

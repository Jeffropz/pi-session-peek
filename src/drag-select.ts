import { SEP } from "./layout.ts";
import type { Cell, Pane, Selection } from "./selection.ts";

// 鼠标拖选的状态机：按下（begin）→ 拖动（move）→ 松开（release），中间拖出预览上下边时自动滚动。
// 选区本身的几何（起止排序、每行列区间、反显、取文字）是 selection.ts 的纯函数，这里只管"现在选到哪了"。
// 坐标一律是主体行号（组件 y 减去 BODY_TOP）；组件通过 host 提供分栏尺寸和滚动位置，并接收自动滚动的写回

const AUTO_SCROLL_MS = 50; // 拖选拖出预览上下边时自动滚动的节奏，和 pi-tui 一样

export interface DragHost {
  /** 最近一次 render 的分栏尺寸和两栏当前的滚动偏移 */
  geometry(): { lw: number; rw: number; H: number; listOffset: number; previewOffset: number };
  /** 预览总行数，自动滚动到底时停 */
  previewLength(): number;
  /** 自动滚动写回预览偏移；紧接着的 move 用新值算格 */
  setPreviewOffset(n: number): void;
  /** 自动滚动改了状态，让组件重画（invalidate + requestRender） */
  changed(): void;
}

export class DragSelect {
  sel?: Selection; // 鼠标拖出来的选区，只在一栏里
  dragging = false; // 左键还按着
  selMoved = false; // 按下之后拖过没有；没拖过的选区不显示也不算数（那是单击）
  dragX = 0; // 最近一次拖动的列，自动滚动时焦点跟着它
  autoScrollDir = 0; // 拖出预览上下边：-1 往上 1 往下
  autoScrollTimer?: ReturnType<typeof setInterval>;

  constructor(private host: DragHost) {}

  // 拖过的才算选区，只按下没拖的是单击
  active(): Selection | undefined {
    return this.sel && this.selMoved ? this.sel : undefined;
  }

  clear(): void {
    this.sel = undefined;
    this.dragging = false;
    this.selMoved = false;
    this.stopAutoScroll();
  }

  // 屏幕位置换成某一栏的内容坐标：行是内容的绝对行号，列夹在这一栏里，拖到栏外也只选栏内的字
  cellAt(pane: Pane, x: number, bodyRow: number): Cell {
    const { lw, rw, H, listOffset, previewOffset } = this.host.geometry();
    const row = Math.max(0, Math.min(H - 1, bodyRow));
    if (pane === "list") return { row: listOffset * 2 + row, col: Math.max(0, Math.min(lw - 1, x)) };
    return { row: previewOffset + row, col: Math.max(0, Math.min(rw - 1, x - lw - SEP)) };
  }

  // 按下：可能是拖选的起点，拖起来才算数
  begin(pane: Pane, x: number, bodyRow: number): void {
    const cell = this.cellAt(pane, x, bodyRow);
    this.sel = { pane, anchor: cell, focus: { ...cell } };
    this.dragging = true;
    this.dragX = x;
  }

  // 拖到某个位置：焦点跟过去。返回有没有变
  move(x: number, bodyRow: number): boolean {
    this.dragX = x;
    const changed = this.dragTo(x, bodyRow);
    if (changed) this.selMoved = true;
    return changed;
  }

  private dragTo(x: number, bodyRow: number): boolean {
    if (!this.sel) return false;
    const cell = this.cellAt(this.sel.pane, x, bodyRow);
    if (cell.row === this.sel.focus.row && cell.col === this.sel.focus.col) return false;
    this.sel.focus = cell;
    return true;
  }

  // 指针在预览上边（-1）/ 下边（1）时开始自动滚，回到里面（0）停
  autoScroll(dir: -1 | 0 | 1): void {
    this.autoScrollDir = dir;
    if (!dir) {
      this.stopAutoScroll();
      return;
    }
    if (this.autoScrollTimer) return;
    this.autoScrollTimer = setInterval(() => this.tick(), AUTO_SCROLL_MS);
    this.autoScrollTimer.unref?.();
  }

  // 每次滚一行，焦点跟着指针：指针在上边就是视口第一行，在下边就是最后一行
  private tick(): void {
    const { H, previewOffset } = this.host.geometry();
    const maxOff = Math.max(0, this.host.previewLength() - H);
    const next = Math.max(0, Math.min(maxOff, previewOffset + this.autoScrollDir));
    if (!this.sel || !this.dragging || next === previewOffset) {
      this.stopAutoScroll();
      return;
    }
    this.host.setPreviewOffset(next);
    if (this.dragTo(this.dragX, this.autoScrollDir < 0 ? -1 : H)) this.selMoved = true;
    this.host.changed();
  }

  // 松开：没拖过就是单击，选区作废。返回是不是我们在跟踪的那次按下
  release(): boolean {
    if (!this.dragging) return false;
    this.dragging = false;
    this.stopAutoScroll();
    if (!this.selMoved) this.sel = undefined;
    return true;
  }

  private stopAutoScroll(): void {
    if (this.autoScrollTimer) clearInterval(this.autoScrollTimer);
    this.autoScrollTimer = undefined;
    this.autoScrollDir = 0;
  }

  dispose(): void {
    this.stopAutoScroll();
  }
}

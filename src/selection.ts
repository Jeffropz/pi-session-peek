import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

// 鼠标拖出来的选区。只在一个栏里：行号是这一栏内容的绝对行号（左栏每个会话两行，右栏是预览行），
// 列号是栏内列号。起止格都算在内，中间的行整行选中，所以从左栏拖到右栏也只会选左栏的字

export type Pane = "list" | "preview";

export interface Cell {
  row: number;
  col: number;
}

export interface Selection {
  pane: Pane;
  anchor: Cell; // 按下的格
  focus: Cell; // 现在拖到的格
}

// CSI / OSC / APC 序列，反显时要原样保留
const SEQ = /\x1b\[[0-9;?<>=!]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const TAIL = new RegExp(`(?:${SEQ.source})+$`); // 行尾的样式收尾码
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 起止格，按阅读顺序 */
export function bounds(sel: Selection): [Cell, Cell] {
  const a = sel.anchor;
  const f = sel.focus;
  const ordered = a.row < f.row || (a.row === f.row && a.col <= f.col);
  return ordered ? [a, f] : [f, a];
}

// 每个字符占的列区间，宽字符两列
function cells(line: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let col = 0;
  for (const { segment } of graphemes.segment(stripTerminalSequences(line))) {
    const w = visibleWidth(segment);
    if (w > 0) out.push({ start: col, end: col + w });
    col += w;
  }
  return out;
}

/**
 * 某一行被选中的列区间 [c0, c1)。边界吸附到整个字符，宽字符不会被切掉一半；
 * 这一行不在选区里返回 undefined。width 是这一栏的宽度
 */
export function rowColumns(sel: Selection, row: number, line: string, width: number): [number, number] | undefined {
  const [s, e] = bounds(sel);
  if (row < s.row || row > e.row) return undefined;
  let c0 = row === s.row ? s.col : 0;
  let c1 = row === e.row ? e.col + 1 : width;
  const cs = cells(line);
  const g0 = cs.find((g) => c0 >= g.start && c0 < g.end);
  if (g0) c0 = g0.start;
  const g1 = cs.find((g) => c1 - 1 >= g.start && c1 - 1 < g.end);
  if (g1) c1 = g1.end;
  c0 = Math.max(0, Math.min(c0, width));
  c1 = Math.max(c0, Math.min(c1, width));
  return c1 > c0 ? [c0, c1] : undefined;
}

// 整段反显。段里原有的样式码照留，每个样式码后面补一次反显，免得被 0m 之类的重置掉
function inverse(text: string): string {
  let out = "\x1b[7m";
  let last = 0;
  for (const m of text.matchAll(SEQ)) {
    out += text.slice(last, m.index) + m[0];
    if (m[0].startsWith("\x1b[") && m[0].endsWith("m")) out += "\x1b[7m";
    last = m.index + m[0].length;
  }
  return out + text.slice(last) + "\x1b[27m";
}

/** 给一行的 [c0, c1) 列加反显，其余部分原样 */
export function highlightColumns(line: string, c0: number, c1: number): string {
  const w = visibleWidth(line);
  const before = sliceByColumn(line, 0, c0, true);
  const mid = sliceByColumn(line, c0, c1 - c0, true);
  const after = sliceByColumn(line, c1, Math.max(0, w - c1), true);
  // sliceByColumn 切到行尾时会丢掉最后那些收尾码（39m、49m 之类），补回去，否则背景色会漏到右边
  const tail = TAIL.exec(line)?.[0] ?? "";
  return before + inverse(mid) + after + tail;
}

/** 选区里的纯文本：每行去掉样式和尾部空白，行间用换行。lineAt 给不出的行当空行 */
export function selectionText(sel: Selection, width: number, lineAt: (row: number) => string | undefined): string {
  const [s, e] = bounds(sel);
  const lines: string[] = [];
  for (let row = s.row; row <= e.row; row++) {
    const line = lineAt(row) ?? "";
    const cols = rowColumns(sel, row, line, width);
    lines.push(cols ? stripTerminalSequences(sliceByColumn(line, cols[0], cols[1] - cols[0], true)).trimEnd() : "");
  }
  return lines.join("\n");
}

// 终端转义序列相关的工具，三种用途分开：
//   1. ANSI_SEQ_RE / splitAnsi：把 pi-tui 渲染出来的一行拆成"可见文字 / 序列"两类片段，序列原样保留、
//      绝不吞可见字。高亮（query.ts）和反显（selection.ts）都靠它，两边必须用同一个正则，
//      否则"记为命中的行"和"高亮到的行"会对不上
//   2. applySgr：只跟踪 SGR 里高亮会碰到的几项（前景色、粗体 / 暗淡、下划线），高亮结束时把外层样式恢复回去
//   3. sanitizeText：解析会话 JSONL 时净化输入。比 1 宽得多：DCS / PM / SOS、没终止的 OSC、孤立的 ESC、
//      C0 控制字符全去掉，宁可多删。每个 ANSI_SEQ_RE 能匹配的序列都在它的覆盖范围内，反之不然
// scripts/screenshot.mjs 有一个自己的 SGR → CSS 状态机（要斜体和背景色），用途不同，不共用

/** pi-tui 会产生的三类序列：CSI（颜色等）、OSC（超链接）、APC。带 g，只用于 matchAll / replace，两者都不受 lastIndex 影响 */
export const ANSI_SEQ_RE = /\x1b\[[0-9;?<>=!]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** 行尾连续的序列（39m、49m 之类的收尾码） */
export const ANSI_TAIL_RE = new RegExp(`(?:${ANSI_SEQ_RE.source})+$`);

export interface AnsiSegment {
  text: string;
  esc: boolean; // true：这一段是一个完整的转义序列
}

/** 一行拆成可见文本和转义序列交替的片段，按顺序拼回去就是原样 */
export function splitAnsi(line: string): AnsiSegment[] {
  const segs: AnsiSegment[] = [];
  let last = 0;
  for (const m of line.matchAll(ANSI_SEQ_RE)) {
    if (m.index > last) segs.push({ text: line.slice(last, m.index), esc: false });
    segs.push({ text: m[0], esc: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) segs.push({ text: line.slice(last), esc: false });
  return segs;
}

/** 是不是 SGR（CSI … m）：只有它会改样式 */
export const isSgr = (seq: string): boolean => seq.startsWith("\x1b[") && seq.endsWith("m");

// 只跟踪高亮会碰到的几项：前景色、粗体 / 暗淡、下划线
export interface SgrStyle {
  fg: string;
  bold: boolean;
  dim: boolean;
  underline: boolean;
}

export function applySgr(st: SgrStyle, seq: string): void {
  const m = /^\x1b\[([0-9;]*)m$/.exec(seq);
  if (!m) return;
  const p = m[1] === "" ? [0] : m[1].split(";").map(Number);
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === 0) {
      st.fg = "";
      st.bold = st.dim = st.underline = false;
    } else if (c === 1) st.bold = true;
    else if (c === 2) st.dim = true;
    else if (c === 22) st.bold = st.dim = false;
    else if (c === 4) st.underline = true;
    else if (c === 24) st.underline = false;
    else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) st.fg = `\x1b[${c}m`;
    else if (c === 39) st.fg = "";
    else if (c === 38 || c === 48) {
      // 扩展色 38;5;n / 38;2;r;g;b；背景色（48）只需要跳过它的参数
      const n = p[i + 1] === 5 ? 2 : p[i + 1] === 2 ? 4 : 0;
      if (c === 38 && n) st.fg = `\x1b[${p.slice(i, i + n + 1).join(";")}m`;
      i += n;
    }
  }
}

// 终端转义序列（CSI / OSC / DCS / APC 等）和除 \t \n 外的 C0 控制字符。正文里带这些会原样写到屏幕上：
// 排版错乱、宽度算错，OSC 52 之类的还能改剪贴板 / 窗口标题
const CONTROL_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]P_^X][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])|[\x00-\x08\x0b-\x1f\x7f]/g;
export const sanitizeText = (s: string) => s.replace(/\r\n?/g, "\n").replace(CONTROL_RE, "");

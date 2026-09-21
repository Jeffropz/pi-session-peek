// 双栏选择器的几何：头部占几行、分隔线几列、主体多高、左右栏多宽。
// 组件、左栏、拖选都要用，单独放一个文件，免得它们反向 import 组件

export const BODY_TOP = 3; // 头部、搜索框、分隔线之后才是双栏主体
export const SEP = 3; // 两栏之间 " │ " 占的列数

// 主体高度。每次都读 process.stdout.rows，终端拉伸后布局跟着变；读不到时用启动时记下的行数
export function bodyRows(termRows: number): number {
  const rows = process.stdout.rows || termRows || 24;
  return Math.max(8, Math.min(rows - 12, 30));
}

// 左栏占 40%，夹在 26 到 56 列之间；右栏拿剩下的，至少 20 列
export function paneWidths(width: number): { lw: number; rw: number } {
  const lw = Math.max(26, Math.min(56, Math.floor(width * 0.4)));
  const rw = Math.max(20, width - lw - SEP);
  return { lw, rw };
}

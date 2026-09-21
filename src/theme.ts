import type { Theme } from "@earendil-works/pi-coding-agent";

// 组件和高亮只用到主题的这三个方法。从 pi 导出的 Theme 取子集：颜色名跟着 pi 的 ThemeColor / ThemeBg 联合走，
// 写错名字 typecheck 就报；测试里的桩只要有这三个方法就能当主题用。类型导入编译后被擦除，运行时不依赖 pi-coding-agent
export type PeekTheme = Pick<Theme, "fg" | "bg" | "bold">;

// 把样式函数拆出前缀（fn(" ") 里空格前面那段转义码），pi 的 Markdown 组件也是这么做的
export function stylePrefix(fn: (s: string) => string): string {
  const s = fn(" ");
  const i = s.indexOf(" ");
  return i >= 0 ? s.slice(0, i) : "";
}

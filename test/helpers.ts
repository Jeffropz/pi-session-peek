import type { MarkdownTheme } from "@earendil-works/pi-tui";

// 组件测试共用的桩：主题全部原样返回，只看结构和文字

export const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };

const id = (s: string) => s;
export const mdTheme: MarkdownTheme = {
  heading: id, link: id, linkUrl: id, code: id, codeBlock: id, codeBlockBorder: id, quote: id, quoteBorder: id,
  hr: id, listBullet: id, bold: id, italic: id, strikethrough: id, underline: id,
};

// 去掉颜色（CSI）和超链接（OSC）序列
export const strip = (l: string) => l.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

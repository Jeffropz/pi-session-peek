import { setCapabilityOverrides, type MarkdownTheme } from "@earendil-works/pi-tui";
import { ANSI_SEQ_RE } from "../src/ansi.ts";

// pi-tui 只在识别出支持 OSC 8 的终端（WT_SESSION、TERM_PROGRAM 等）时才输出超链接，
// CI 的 runner 没有这些变量，会把链接退化成 "text (url)"。测试里固定打开，结果不随运行环境变
setCapabilityOverrides({ hyperlinks: true });

// 组件测试共用的桩：主题全部原样返回，只看结构和文字

export const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };

const id = (s: string) => s;
export const mdTheme: MarkdownTheme = {
  heading: id, link: id, linkUrl: id, code: id, codeBlock: id, codeBlockBorder: id, quote: id, quoteBorder: id,
  hr: id, listBullet: id, bold: id, italic: id, strikethrough: id, underline: id,
};

// 去掉转义序列（颜色、超链接等），和生产代码分词用的是同一个正则
export const strip = (l: string) => l.replace(ANSI_SEQ_RE, "");

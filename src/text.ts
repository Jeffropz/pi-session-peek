import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// Windows 路径大小写不敏感，统一小写再比
export const normPath = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// 本地时间 "MM-DD HH:mm"；withYear 或不是今年时带年份
export function fmtTime(iso: string, withYear = false): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return withYear ? "????-??-?? ??:??" : "??-?? ??:??";
  const p = (n: number) => String(n).padStart(2, "0");
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return withYear || d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}-${md}` : md;
}

// 按显示宽度补齐到 w，中文和 ANSI 都算对
export function padEndVisible(s: string, w: number): string {
  const v = visibleWidth(s);
  return v >= w ? truncateToWidth(s, w) : s + " ".repeat(w - v);
}

export function wrapLines(text: string, width: number): string[] {
  const out: string[] = [];
  for (const part of text.split("\n")) {
    const wrapped = wrapTextWithAnsi(part, width);
    out.push(...(wrapped.length ? wrapped : [""]));
  }
  return out;
}

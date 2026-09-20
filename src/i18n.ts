export type Lang = "zh" | "en";

const zh = {
  flagPeek: "启动时打开会话搜索预览并预填关键词（--peek=关键词）",
  flagRp: "启动时打开会话搜索预览（不带关键词）",
  cmdDesc: "搜索历史会话：左右分栏预览、关键词高亮，Enter 进入对话",
  needTui: "/peek 需要在交互模式（TUI）下使用",
  noSessions: "没有找到历史会话",
  trashed: "已将会话 {file} 移入回收站",
  deleted: "已永久删除会话 {file}（未找到回收站）",
  deleteFailed: "删除会话失败",
  renamed: "已重命名为「{name}」",
  renameFailed: "重命名失败",
  forked: "已分叉为新会话 {file}",
  forkFailed: "分叉失败：{error}",
  switchCancelled: "切换会话已取消",
  searchPlaceholder: "过滤：空格=都要命中  \"短语\"  a|b  -排除  name:/dir:/user:/ai:  /正则/  @7d",
  renamePlaceholder: "新会话名（Enter 确认 / Esc 取消，留空取消）",
  title: "🔍 会话搜索预览",
  scopeLabel: "  范围[Tab]: ",
  scopeAll: "全局",
  scopeCurrent: "当前目录树",
  timeLabel: "  时间: ",
  matchCount: "  匹配 {n}/{total}",
  noMatch: "没有匹配的会话",
  msgCount: "{n} 条消息",
  hitPos: " 命中 {k}/{n}",
  truncated: "（会话过长，仅显示最后 {n} 条）",
  hitInTruncated: "关键词命中在未显示的更早消息中",
  hitOnlyMeta: "关键词仅命中会话名或目录，对话正文无匹配",
  you: "👤 你",
  ai: "🤖 AI",
  renamePrefix: "✏ 重命名: ",
  confirmDelete: "⚠ 删除会话 [{desc}]？按 y / Enter 确认，任意其他键取消",
  footer: "↑↓ 选择  PgUp/Dn·^U/^F·⇧↑↓ 滚动  ^N/^P 命中  Tab 范围  ^D 删除  ^R 改名  ^O 分叉  Enter 进入  Esc/^C 关闭",
  since: "近{n}{unit}",
  unitH: "小时",
  unitD: "天",
  unitW: "周",
  unitM: "个月",
};

const en: Record<keyof typeof zh, string> = {
  flagPeek: "Open the session picker at startup with a keyword (--peek=<keyword>)",
  flagRp: "Open the session picker at startup",
  cmdDesc: "Search session history: two-pane preview with keyword highlighting, Enter to resume",
  needTui: "/peek only works in interactive (TUI) mode",
  noSessions: "No sessions found",
  trashed: "Moved session {file} to the trash",
  deleted: "Permanently deleted session {file} (no trash available)",
  deleteFailed: "Failed to delete session",
  renamed: "Renamed to “{name}”",
  renameFailed: "Rename failed",
  forked: "Forked into new session {file}",
  forkFailed: "Fork failed: {error}",
  switchCancelled: "Session switch cancelled",
  searchPlaceholder: "Filter: space=AND  \"phrase\"  a|b  -exclude  name:/dir:/user:/ai:  /regex/  @7d",
  renamePlaceholder: "New session name (Enter to confirm, Esc to cancel, empty = cancel)",
  title: "🔍 Session search",
  scopeLabel: "  Scope[Tab]: ",
  scopeAll: "all projects",
  scopeCurrent: "current dir tree",
  timeLabel: "  Time: ",
  matchCount: "  {n}/{total} matched",
  noMatch: "No matching sessions",
  msgCount: "{n} messages",
  hitPos: " hit {k}/{n}",
  truncated: "(long session, showing the last {n} messages)",
  hitInTruncated: "Keyword hits are in earlier messages not shown here",
  hitOnlyMeta: "Keyword matched only the session name or directory, not the conversation",
  you: "👤 You",
  ai: "🤖 AI",
  renamePrefix: "✏ Rename: ",
  confirmDelete: "⚠ Delete session [{desc}]? y / Enter to confirm, any other key to cancel",
  footer: "↑↓ select  PgUp/Dn·^U/^F·⇧↑↓ scroll  ^N/^P hits  Tab scope  ^D del  ^R rename  ^O fork  Enter open  Esc close",
  since: "last {n}{unit}",
  unitH: "h",
  unitD: "d",
  unitW: "w",
  unitM: "mo",
};

export const messages = { zh, en };
export type MsgKey = keyof typeof zh;

function classify(v: string | undefined): Lang | undefined {
  const s = v?.trim().toLowerCase();
  if (!s || s === "c" || s === "posix") return undefined;
  if (s.startsWith("zh")) return "zh";
  if (s.startsWith("en")) return "en";
  return undefined;
}

// PI_SESSION_PEEK_LANG > LC_ALL / LC_MESSAGES / LANG > 系统区域；都认不出来就用英文
export function detectLang(
  env: Record<string, string | undefined> = process.env,
  systemLocale: () => string = () => Intl.DateTimeFormat().resolvedOptions().locale,
): Lang {
  const forced = classify(env.PI_SESSION_PEEK_LANG);
  if (forced) return forced;
  for (const v of [env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    const l = classify(v);
    if (l) return l;
    if (v && v.trim() && !["c", "posix"].includes(v.trim().toLowerCase())) return "en";
  }
  let loc = "";
  try {
    loc = systemLocale();
  } catch {
  }
  return loc.toLowerCase().startsWith("zh") ? "zh" : "en";
}

let current: Lang = detectLang();

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  current = lang;
}

export function msg(key: MsgKey, vars?: Record<string, string | number>): string {
  let s: string = messages[current][key];
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

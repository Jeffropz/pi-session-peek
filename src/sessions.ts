import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { normPath } from "./text.ts";

// 读 ~/.pi/agent/sessions 下的会话 JSONL，按 mtime 缓存；重命名和删除也在这里。
// 搜索不预存小写全文：会话正文只在 msgs 里放一份，匹配时用不区分大小写的正则直接扫（见 query.ts 的 matchesSession）

export interface PeekTool {
  name: string;
  summary: string; // 主参数（命令 / 路径 / URL…）压成一行，预览里显示用
}

export interface PeekMsg {
  role: "user" | "assistant";
  text: string; // 只发了工具调用、没写字的 AI 轮次为空串
  tools?: PeekTool[]; // 这条消息里的工具调用，没有就不带这个键。不进搜索索引
}

export interface PeekSession {
  path: string;
  cwd: string;
  time: string;
  name: string; // 最后一条 session_info 里的名字，没有则为空
  first: string; // 首条消息，列表里显示用
  msgs: PeekMsg[];
  mtime: number;
  size: number; // 和 mtime 一起当缓存键：mtime 粒度粗的文件系统上连续两次写入可能同一个 mtime
}

const sessionCache = new Map<string, PeekSession>();
const READ_CONCURRENCY = 16; // 同时读的文件数，太高会把 libuv 线程池排满

const expandTilde = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

// 默认布局下所有项目的会话根目录：和 pi 一样认 PI_CODING_AGENT_DIR，下面每个 cwd 一个子目录
export function sessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  const agent = env.PI_CODING_AGENT_DIR ? expandTilde(env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent");
  return join(agent, "sessions");
}

/** 要扫描的根目录。pi 的 getSessionDir() 是参数、环境变量、settings.json 合并后的结果：
 * 默认布局时它是 <root>/sessions/<按 cwd 编码的子目录>，取上一级才能看到所有项目；
 * 用户自定义了目录（--session-dir 等）时就是那个目录本身，直接扫它 */
export function scanRoot(currentSessionDir: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const root = sessionsDir(env);
  if (!currentSessionDir) return root;
  return normPath(dirname(currentSessionDir)) === normPath(root) ? root : currentSessionDir;
}

async function walkJsonl(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walkJsonl(p, out);
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
}

// 终端转义序列（CSI / OSC / DCS / APC 等）和除 \t \n 外的 C0 控制字符。正文里带这些会原样写到屏幕上：
// 排版错乱、宽度算错，OSC 52 之类的还能改剪贴板 / 窗口标题
const CONTROL_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]P_^X][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])|[\x00-\x08\x0b-\x1f\x7f]/g;
export const sanitizeText = (s: string) => s.replace(/\r\n?/g, "\n").replace(CONTROL_RE, "");

function extractText(content: unknown): string {
  if (typeof content === "string") return sanitizeText(content);
  if (!Array.isArray(content)) return "";
  return sanitizeText(
    content
      .filter((c: any) => c?.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("\n"),
  );
}

// 工具调用的主参数：按常见键名找第一个字符串，都没有就取第一个字符串参数。不存结果，bash 输出动辄几十 KB
const TOOL_ARG_KEYS = ["command", "path", "url", "query", "pattern", "file_path"];
const TOOL_SUMMARY_MAX = 120;

export function toolSummary(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const o = args as Record<string, unknown>;
  let v = TOOL_ARG_KEYS.map((k) => o[k]).find((x) => typeof x === "string" && x.trim());
  if (typeof v !== "string") v = Object.values(o).find((x) => typeof x === "string" && (x as string).trim());
  if (typeof v !== "string") return "";
  return sanitizeText(v).replace(/\s+/g, " ").trim().slice(0, TOOL_SUMMARY_MAX);
}

function extractTools(content: unknown): PeekTool[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c: any) => c?.type === "toolCall" && typeof c.name === "string")
    .map((c: any) => ({ name: c.name, summary: toolSummary(c.arguments) }));
}

function parseSession(path: string, raw: string, mtime: number, size: number): PeekSession | null {
  let cwd = "";
  let time = "";
  let name = "";
  const msgs: PeekMsg[] = [];

  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      if (line.includes('"type":"session"')) {
        const o = JSON.parse(line);
        cwd = o.cwd ?? cwd;
        time = o.timestamp ?? time;
        continue;
      }
      if (line.includes('"type":"session_info"')) {
        const o = JSON.parse(line);
        if (typeof o.name === "string") name = sanitizeText(o.name).trim(); // 空名字是显式清掉
        continue;
      }
      // 先用子串粗筛，省掉大部分行的 JSON.parse
      if (!line.includes('"role":"user"') && !line.includes('"role":"assistant"')) continue;
      const o = JSON.parse(line);
      if (o.type !== "message") continue;
      const role = o.message?.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = extractText(o.message?.content).trim();
      const tools = role === "assistant" ? extractTools(o.message.content) : [];
      // 只有工具调用的 AI 轮次也留着，否则预览里"我来看看"直接跳到结论，中间做了什么全没了
      if (tools.length) msgs.push({ role, text, tools });
      else if (text) msgs.push({ role, text });
    } catch {
    }
  }

  // 一条文字消息都没有的会话不列出来；列表里的首条也只看有文字的
  const firstText = msgs.find((m) => m.text);
  if (!firstText) return null;

  return {
    path,
    cwd,
    time,
    name,
    msgs,
    mtime,
    size,
    first: firstText.text.replace(/\s+/g, " ").slice(0, 80),
  };
}

// 单个文件：mtime 没变直接用缓存，否则重新读和解析
async function loadSession(file: string): Promise<PeekSession | null> {
  let mtime: number;
  let size: number;
  try {
    const st = await stat(file);
    mtime = st.mtimeMs;
    size = st.size;
  } catch {
    return null;
  }
  const hit = sessionCache.get(file);
  if (hit && hit.mtime === mtime && hit.size === size) return hit;
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  const parsed = parseSession(file, raw, mtime, size);
  if (parsed) sessionCache.set(file, parsed);
  return parsed;
}

/** 全部会话，按最后修改时间倒序；文件没变的直接用缓存。
 * 目录遍历和文件读取都走异步 I/O，几百个会话也不会把 TUI 卡住 */
export async function scanSessions(root: string = sessionsDir()): Promise<PeekSession[]> {
  const files: string[] = [];
  await walkJsonl(root, files);

  const out: PeekSession[] = [];
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const s = await loadSession(files[next++]);
      if (s) out.push(s);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, files.length) }, worker));

  // 文件已经不在了的，从缓存里去掉
  const seen = new Set(files);
  for (const key of [...sessionCache.keys()]) {
    if (!seen.has(key)) sessionCache.delete(key);
  }

  return out.sort((a, b) => b.mtime - a.mtime);
}

// 和 pi 自带的 /name 写同一种 session_info 记录，parentId 用文件里最后一条记录的 id
export function renameSession(path: string, name: string): void {
  name = sanitizeText(name).replace(/\n+/g, " ").trim(); // 和 pi 的 appendSessionInfo 一样，换行不能进 JSONL 的一行
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  let parentId: string | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    try {
      const o = JSON.parse(lines[i]);
      if (typeof o.id === "string") {
        parentId = o.id;
        break;
      }
    } catch {
      // 末行可能只写了一半
    }
  }
  const entry = {
    type: "session_info",
    id: randomBytes(4).toString("hex"),
    parentId,
    timestamp: new Date().toISOString(),
    name,
  };
  // 末行没换行（写了一半）时先补一个，别和新记录粘在一起
  const sep = raw === "" || raw.endsWith("\n") ? "" : "\n";
  appendFileSync(path, sep + JSON.stringify(entry) + "\n", "utf8");
}

export type DeleteResult = "trash" | "rm" | false;

// 各平台把文件送进回收站的命令，按顺序试。trash（trash-cli / brew trash）放最前面，装了就说明用户想用它；
// 后面是系统自带的途径：Windows 走 PowerShell 的 VisualBasic FileSystem，macOS 走 Finder，Linux 走 gio / trash-put
export function trashCommands(path: string, platform: NodeJS.Platform = process.platform): [string, string[]][] {
  const cmds: [string, string[]][] = [["trash", [path]]];
  if (platform === "win32") {
    const script =
      "Add-Type -AssemblyName Microsoft.VisualBasic; " +
      `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${path.replace(/'/g, "''")}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
    const args = ["-NoProfile", "-NonInteractive", "-Command", script];
    cmds.push(["powershell", args], ["pwsh", args]);
  } else if (platform === "darwin") {
    cmds.push(["osascript", ["-e", `tell application "Finder" to delete POSIX file "${path.replace(/[\\"]/g, "\\$&")}"`]]);
  } else {
    cmds.push(["gio", ["trash", path]], ["trash-put", [path]]);
  }
  return cmds;
}

// 优先进回收站（能恢复），每个途径都不行再直接删。exec 由调用方传入，方便测试；
// 命令退出码为 0 但文件还在也当失败，继续试下一个。命令超时被杀但其实已经把文件移走了的，
// 事后再看一眼文件，别把"已进回收站"报成"永久删除"
export async function deleteSession(
  path: string,
  exec: (cmd: string, args: string[]) => Promise<{ code: number }>,
  platform: NodeJS.Platform = process.platform,
): Promise<DeleteResult> {
  const wasThere = existsSync(path);
  for (const [cmd, args] of trashCommands(path, platform)) {
    try {
      const r = await exec(cmd, args);
      if (r.code === 0 && !existsSync(path)) return "trash";
    } catch {
    }
    if (wasThere && !existsSync(path)) return "trash";
  }
  try {
    rmSync(path, { force: true });
    return "rm";
  } catch {
    return false;
  }
}

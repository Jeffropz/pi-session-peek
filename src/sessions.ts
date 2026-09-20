import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// 读 ~/.pi/agent/sessions 下的会话 JSONL，按 mtime 缓存；重命名和删除也在这里。
// 搜索不预存小写全文：会话正文只在 msgs 里放一份，匹配时用不区分大小写的正则直接扫（见 query.ts 的 matchesSession）

export interface PeekMsg {
  role: "user" | "assistant";
  text: string;
}

export interface PeekSession {
  path: string;
  cwd: string;
  time: string;
  name: string; // 最后一条 session_info 里的名字，没有则为空
  first: string; // 首条消息，列表里显示用
  msgs: PeekMsg[];
  mtime: number;
}

const sessionCache = new Map<string, PeekSession>();
const READ_CONCURRENCY = 16; // 同时读的文件数，太高会把 libuv 线程池排满

// 和 pi 一样认 PI_CODING_AGENT_DIR
function sessionsDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR;
  const agent = env ? (env.startsWith("~") ? join(homedir(), env.slice(1)) : env) : join(homedir(), ".pi", "agent");
  return join(agent, "sessions");
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

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join("\n");
}

function parseSession(path: string, raw: string, mtime: number): PeekSession | null {
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
        if (typeof o.name === "string" && o.name) name = o.name;
        continue;
      }
      // 先用子串粗筛，省掉大部分行的 JSON.parse
      if (!line.includes('"role":"user"') && !line.includes('"role":"assistant"')) continue;
      const o = JSON.parse(line);
      if (o.type !== "message") continue;
      const role = o.message?.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = extractText(o.message?.content).trim();
      if (text) msgs.push({ role, text });
    } catch {
    }
  }

  if (!msgs.length) return null;

  return {
    path,
    cwd,
    time,
    name,
    msgs,
    mtime,
    first: msgs[0].text.replace(/\s+/g, " ").slice(0, 80),
  };
}

// 单个文件：mtime 没变直接用缓存，否则重新读和解析
async function loadSession(file: string): Promise<PeekSession | null> {
  let mtime: number;
  try {
    mtime = (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
  const hit = sessionCache.get(file);
  if (hit && hit.mtime === mtime) return hit;
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  const parsed = parseSession(file, raw, mtime);
  if (parsed) sessionCache.set(file, parsed);
  return parsed;
}

/** 全部会话，按最后修改时间倒序；文件没变的直接用缓存。
 * 目录遍历和文件读取都走异步 I/O，几百个会话也不会把 TUI 卡住 */
export async function scanSessions(): Promise<PeekSession[]> {
  const files: string[] = [];
  await walkJsonl(sessionsDir(), files);

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
// 命令退出码为 0 但文件还在也当失败，继续试下一个
export async function deleteSession(
  path: string,
  exec: (cmd: string, args: string[]) => Promise<{ code: number }>,
  platform: NodeJS.Platform = process.platform,
): Promise<DeleteResult> {
  for (const [cmd, args] of trashCommands(path, platform)) {
    try {
      const r = await exec(cmd, args);
      if (r.code === 0 && !existsSync(path)) return "trash";
    } catch {
    }
  }
  try {
    rmSync(path, { force: true });
    return "rm";
  } catch {
    return false;
  }
}

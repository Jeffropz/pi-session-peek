import { appendFileSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// 读 ~/.pi/agent/sessions 下的会话 JSONL，按 mtime 缓存；重命名和删除也在这里

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
  searchText: string; // 正文 + 会话名 + cwd，已小写
  mtime: number;
}

const sessionCache = new Map<string, PeekSession>();

// 和 pi 一样认 PI_CODING_AGENT_DIR
function sessionsDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR;
  const agent = env ? (env.startsWith("~") ? join(homedir(), env.slice(1)) : env) : join(homedir(), ".pi", "agent");
  return join(agent, "sessions");
}

function* walkJsonl(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(p);
    else if (e.name.endsWith(".jsonl")) yield p;
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

function parseSession(path: string, mtime: number): PeekSession | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
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
    searchText: (msgs.map((m) => m.text).join(" ") + " " + name + " " + cwd).toLowerCase(),
  };
}

/** 全部会话，按最后修改时间倒序；文件没变的直接用缓存 */
export function scanSessions(): PeekSession[] {
  const seen = new Set<string>();
  const out: PeekSession[] = [];

  for (const file of walkJsonl(sessionsDir())) {
    seen.add(file);
    let mtime = 0;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    const hit = sessionCache.get(file);
    if (hit && hit.mtime === mtime) {
      out.push(hit);
      continue;
    }
    const parsed = parseSession(file, mtime);
    if (parsed) {
      sessionCache.set(file, parsed);
      out.push(parsed);
    }
  }

  // 文件已经不在了的，从缓存里去掉
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

// 先试 trash（能恢复），不行再直接删。trashExec 由调用方传入，方便测试
export async function deleteSession(
  path: string,
  trashExec: (cmd: string, args: string[]) => Promise<{ code: number }>,
): Promise<boolean> {
  try {
    const r = await trashExec("trash", [path]);
    if (r.code === 0) return true;
  } catch {
  }
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

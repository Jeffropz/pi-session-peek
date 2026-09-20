import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { kwRegExps, matchesSession } from "../src/query.ts";
import { deleteSession, renameSession, scanSessions, trashCommands, type PeekSession } from "../src/sessions.ts";

let agentDir: string;
let dir: string;

function line(o: unknown) {
  return JSON.stringify(o) + "\n";
}

function session(file: string, opts: { cwd: string; time: string; name?: string; msgs: [string, string][]; tool?: boolean }) {
  let out = line({ type: "session", version: 3, id: file, timestamp: opts.time, cwd: opts.cwd });
  let prev: string | null = null;
  let n = 0;
  for (const [role, text] of opts.msgs) {
    const id = `${file}-${n++}`;
    out += line({ type: "message", id, parentId: prev, timestamp: opts.time, message: { role, content: [{ type: "text", text }] } });
    prev = id;
  }
  if (opts.tool) {
    out += line({ type: "message", id: "t1", parentId: prev, timestamp: opts.time, message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "grep SECRET_TOOL_ARG" } }] } });
    out += line({ type: "message", id: "t2", parentId: "t1", timestamp: opts.time, message: { role: "toolResult", content: [{ type: "text", text: "SECRET_TOOL_OUTPUT" }] } });
    prev = "t2";
  }
  if (opts.name !== undefined) {
    out += line({ type: "session_info", id: "info", parentId: prev, timestamp: opts.time, name: opts.name });
  }
  const p = join(dir, `${file}.jsonl`);
  writeFileSync(p, out);
  return p;
}

// 以前的 searchText 现在由 matchesSession 现算
function hits(s: PeekSession, kw: string): boolean {
  return matchesSession(s, kwRegExps([kw.toLowerCase()]));
}

before(() => {
  agentDir = mkdtempSync(join(tmpdir(), "peek-agent-"));
  dir = join(agentDir, "sessions", "--D--proj--");
  mkdirSync(dir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

after(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(agentDir, { recursive: true, force: true });
});

test("scanSessions: 解析 header、消息、名字，工具输入输出不进索引", async () => {
  const a = session("a", {
    cwd: "D:\\proj",
    time: "2026-09-01T00:00:00.000Z",
    name: "my name",
    msgs: [["user", "  first   question\nsecond line "], ["assistant", "an answer"]],
    tool: true,
  });
  utimesSync(a, new Date("2026-09-01T00:00:00Z"), new Date("2026-09-01T00:00:00Z"));
  const b = session("b", { cwd: "D:\\proj", time: "2026-09-02T00:00:00.000Z", msgs: [["user", "later one"]] });
  utimesSync(b, new Date("2026-09-02T00:00:00Z"), new Date("2026-09-02T00:00:00Z"));
  session("empty", { cwd: "D:\\proj", time: "2026-09-03T00:00:00.000Z", msgs: [] });
  writeFileSync(join(dir, "broken.jsonl"), "not json\n{\n");

  const all = await scanSessions();
  assert.deepEqual(all.map((s) => s.path), [b, a]);

  const sa = all[1];
  assert.equal(sa.cwd, "D:\\proj");
  assert.equal(sa.time, "2026-09-01T00:00:00.000Z");
  assert.equal(sa.name, "my name");
  assert.deepEqual(sa.msgs, [
    { role: "user", text: "first   question\nsecond line" },
    { role: "assistant", text: "an answer" },
  ]);
  assert.equal(sa.first, "first question second line");
  assert.ok(!("searchText" in sa)); // 不再额外存一份小写全文
  assert.ok(hits(sa, "FIRST   question"));
  assert.ok(hits(sa, "my name"));
  assert.ok(hits(sa, "d:\\proj"));
  assert.ok(!hits(sa, "secret_tool_arg"));
  assert.ok(!hits(sa, "secret_tool_output"));
});

test("scanSessions: 最后一条 session_info 生效，空名字清掉", async () => {
  const p = session("c", { cwd: "D:\\proj", time: "2026-09-04T00:00:00.000Z", name: "old", msgs: [["user", "x"]] });
  writeFileSync(p, readFileSync(p, "utf8") + line({ type: "session_info", id: "info2", parentId: "info", timestamp: "2026-09-04T00:00:01.000Z", name: "" }) + line({ type: "session_info", id: "info3", parentId: "info2", timestamp: "2026-09-04T00:00:02.000Z", name: "newest" }));
  const s = (await scanSessions()).find((s) => s.path === p)!;
  assert.equal(s.name, "newest");
});

test("scanSessions: mtime 不变复用缓存，变了重新解析，文件删了就消失", async () => {
  const p = session("d", { cwd: "D:\\proj", time: "2026-09-05T00:00:00.000Z", msgs: [["user", "v1"]] });
  const t1 = new Date("2026-09-05T00:00:00Z");
  utimesSync(p, t1, t1);
  const first = (await scanSessions()).find((s) => s.path === p)!;
  const again = (await scanSessions()).find((s) => s.path === p)!;
  assert.equal(again, first);

  writeFileSync(p, readFileSync(p, "utf8") + line({ type: "message", id: "m9", parentId: "d-0", timestamp: "x", message: { role: "assistant", content: [{ type: "text", text: "v2" }] } }));
  const t2 = new Date("2026-09-05T01:00:00Z");
  utimesSync(p, t2, t2);
  const updated = (await scanSessions()).find((s) => s.path === p)!;
  assert.notEqual(updated, first);
  assert.equal(updated.msgs.length, 2);

  rmSync(p);
  assert.equal((await scanSessions()).some((s) => s.path === p), false);
});

test("renameSession: 追加 session_info，parentId 是最后一条记录，能跳过写了一半的末行", async () => {
  const p = session("e", { cwd: "D:\\proj", time: "2026-09-06T00:00:00.000Z", msgs: [["user", "hi"], ["assistant", "yo"]] });
  writeFileSync(p, readFileSync(p, "utf8") + '{"type":"message","id":"half"');
  renameSession(p, "renamed");
  const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  const last = JSON.parse(lines.at(-1)!);
  assert.equal(last.type, "session_info");
  assert.equal(last.name, "renamed");
  assert.equal(last.parentId, "e-1");
  assert.equal(typeof last.id, "string");
  assert.equal((await scanSessions()).find((s) => s.path === p)!.name, "renamed");
});

test("deleteSession: 回收站命令成功且文件消失才算进回收站，否则依次再试，最后直接删", async () => {
  const p = session("f", { cwd: "D:\proj", time: "2026-09-07T00:00:00.000Z", msgs: [["user", "bye"]] });
  const calls: string[][] = [];
  // 模拟 trash 真的把文件移走了
  const r1 = await deleteSession(p, async (cmd, args) => (calls.push([cmd, ...args]), rmSync(p), { code: 0 }), "linux");
  assert.equal(r1, "trash");
  assert.deepEqual(calls, [["trash", p]]);

  // 退出码 0 但文件还在（比如同名的别的程序）：不算成功，继续试后面的
  const q = session("g", { cwd: "D:\proj", time: "2026-09-07T00:00:00.000Z", msgs: [["user", "bye"]] });
  calls.length = 0;
  const r2 = await deleteSession(q, async (cmd) => (calls.push([cmd]), { code: 0 }), "linux");
  assert.equal(r2, "rm");
  assert.deepEqual(calls.map((c) => c[0]), ["trash", "gio", "trash-put"]);
  assert.equal(existsSync(q), false);

  // 全部抛错（命令不存在）也直接删
  const h = session("h", { cwd: "D:\proj", time: "2026-09-07T00:00:00.000Z", msgs: [["user", "bye"]] });
  assert.equal(await deleteSession(h, async () => { throw new Error("no trash"); }, "darwin"), "rm");
  assert.equal(existsSync(h), false);

  // 文件本来就不存在：回收站命令不可能成功，rmSync force 也不报错
  assert.equal(await deleteSession(join(dir, "nope.jsonl"), async () => ({ code: 1 }), "win32"), "rm");
});

test("trashCommands: 各平台的候选命令，路径里的引号要转义", () => {
  assert.deepEqual(trashCommands("/a/b.jsonl", "linux"), [
    ["trash", ["/a/b.jsonl"]],
    ["gio", ["trash", "/a/b.jsonl"]],
    ["trash-put", ["/a/b.jsonl"]],
  ]);

  const mac = trashCommands('/a/it"s.jsonl', "darwin");
  assert.equal(mac[0][0], "trash");
  assert.equal(mac[1][0], "osascript");
  assert.equal(mac[1][1][1], 'tell application "Finder" to delete POSIX file "/a/it\\"s.jsonl"');

  const win = trashCommands("C:\\x\\it's.jsonl", "win32");
  assert.deepEqual(win.map((c) => c[0]), ["trash", "powershell", "pwsh"]);
  const script = win[1][1].at(-1)!;
  assert.ok(win[1][1].includes("-NonInteractive"));
  assert.ok(script.includes("DeleteFile('C:\\x\\it''s.jsonl', 'OnlyErrorDialogs', 'SendToRecycleBin')"), script);
  assert.deepEqual(win[2][1], win[1][1]);
});

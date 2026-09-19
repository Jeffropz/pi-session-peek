import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { deleteSession, renameSession, scanSessions } from "../src/sessions.ts";

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

test("scanSessions: 解析 header、消息、名字，工具输入输出不进索引", () => {
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

  const all = scanSessions();
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
  assert.ok(sa.searchText.includes("first   question"));
  assert.ok(sa.searchText.includes("my name"));
  assert.ok(sa.searchText.includes("d:\\proj"));
  assert.ok(!sa.searchText.includes("secret_tool_arg"));
  assert.ok(!sa.searchText.includes("secret_tool_output"));
});

test("scanSessions: 最后一条 session_info 生效，空名字清掉", () => {
  const p = session("c", { cwd: "D:\\proj", time: "2026-09-04T00:00:00.000Z", name: "old", msgs: [["user", "x"]] });
  writeFileSync(p, readFileSync(p, "utf8") + line({ type: "session_info", id: "info2", parentId: "info", timestamp: "2026-09-04T00:00:01.000Z", name: "" }) + line({ type: "session_info", id: "info3", parentId: "info2", timestamp: "2026-09-04T00:00:02.000Z", name: "newest" }));
  const s = scanSessions().find((s) => s.path === p)!;
  assert.equal(s.name, "newest");
});

test("scanSessions: mtime 不变复用缓存，变了重新解析，文件删了就消失", () => {
  const p = session("d", { cwd: "D:\\proj", time: "2026-09-05T00:00:00.000Z", msgs: [["user", "v1"]] });
  const t1 = new Date("2026-09-05T00:00:00Z");
  utimesSync(p, t1, t1);
  const first = scanSessions().find((s) => s.path === p)!;
  const again = scanSessions().find((s) => s.path === p)!;
  assert.equal(again, first);

  writeFileSync(p, readFileSync(p, "utf8") + line({ type: "message", id: "m9", parentId: "d-0", timestamp: "x", message: { role: "assistant", content: [{ type: "text", text: "v2" }] } }));
  const t2 = new Date("2026-09-05T01:00:00Z");
  utimesSync(p, t2, t2);
  const updated = scanSessions().find((s) => s.path === p)!;
  assert.notEqual(updated, first);
  assert.equal(updated.msgs.length, 2);

  rmSync(p);
  assert.equal(scanSessions().some((s) => s.path === p), false);
});

test("renameSession: 追加 session_info，parentId 是最后一条记录，能跳过写了一半的末行", () => {
  const p = session("e", { cwd: "D:\\proj", time: "2026-09-06T00:00:00.000Z", msgs: [["user", "hi"], ["assistant", "yo"]] });
  writeFileSync(p, readFileSync(p, "utf8") + '{"type":"message","id":"half"');
  renameSession(p, "renamed");
  const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  const last = JSON.parse(lines.at(-1)!);
  assert.equal(last.type, "session_info");
  assert.equal(last.name, "renamed");
  assert.equal(last.parentId, "e-1");
  assert.equal(typeof last.id, "string");
  assert.equal(scanSessions().find((s) => s.path === p)!.name, "renamed");
});

test("deleteSession: trash 成功就不再删文件，失败或抛错则直接删", async () => {
  const p = session("f", { cwd: "D:\\proj", time: "2026-09-07T00:00:00.000Z", msgs: [["user", "bye"]] });
  const calls: string[][] = [];
  assert.equal(await deleteSession(p, async (cmd, args) => (calls.push([cmd, ...args]), { code: 0 })), true);
  assert.deepEqual(calls, [["trash", p]]);
  assert.equal(existsSync(p), true);

  assert.equal(await deleteSession(p, async () => ({ code: 1 })), true);
  assert.equal(existsSync(p), false);

  const q = session("g", { cwd: "D:\\proj", time: "2026-09-07T00:00:00.000Z", msgs: [["user", "bye"]] });
  assert.equal(await deleteSession(q, async () => { throw new Error("no trash"); }), true);
  assert.equal(existsSync(q), false);
});

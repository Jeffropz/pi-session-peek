import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { setLang } from "../src/i18n.ts";
import { PeekComponent } from "../src/peek-component.ts";
import type { PeekSession } from "../src/sessions.ts";
import { mdTheme, strip, theme } from "./helpers.ts";

setLang("zh");

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const KEY = { enter: "\r", tab: "\t", up: "\x1b[A", down: "\x1b[B", bs: "\x7f", esc: "\x1b", cc: "\x03", cd: "\x04", cf: "\x06", co: "\x0f", cr: "\x12", ct: "\x14", cu: "\x15" };

function mk(cwd: string, texts: string[], ageDays: number, name = ""): PeekSession {
  const mtime = Date.now() - ageDays * 86400e3;
  return {
    path: `${cwd}/${texts[0].slice(0, 8)}.jsonl`,
    cwd,
    time: new Date(mtime).toISOString(),
    name,
    first: texts[0],
    msgs: texts.map((text, i) => ({ role: i % 2 ? "assistant" : "user", text })),
    mtime,
    size: 0,
  };
}

function fixture() {
  return [
    mk("D:/proj", ["alpha beta", "reply one"], 1),
    mk("D:/proj/packages/web", ["alpha only"], 2),
    mk("D:/projX", ["some long preamble text and then gamma appears"], 20, "named-x"),
    mk("D:/other", ["beta alpha"], 40, "other-name"),
  ];
}

function make(all = fixture(), cwd = "d:/PROJ", initial = "") {
  const c: any = new PeekComponent(all, cwd, theme, mdTheme, 40, initial);
  c.requestRender = () => {};
  return c;
}

function type(c: any, s: string) {
  for (const ch of s) c.handleInput(ch);
}

test("默认范围：当前目录树下有会话就选当前目录，含子目录，大小写和斜杠不敏感", () => {
  const c = make();
  assert.equal(c.scope, "current");
  assert.deepEqual(c.filtered.map((s: PeekSession) => s.cwd), ["D:/proj", "D:/proj/packages/web"]);
});

test("默认范围：当前目录下没有会话就选全局", () => {
  const c = make(fixture(), "D:/nowhere");
  assert.equal(c.scope, "all");
  assert.equal(c.filtered.length, 4);
});

test("Tab 切换范围", () => {
  const c = make();
  c.handleInput(KEY.tab);
  assert.equal(c.scope, "all");
  assert.equal(c.filtered.length, 4);
  c.handleInput(KEY.tab);
  assert.equal(c.filtered.length, 2);
});

test("多关键词 AND", () => {
  const c = make(fixture(), "D:/nowhere");
  type(c, "alpha");
  assert.equal(c.filtered.length, 3);
  type(c, " beta");
  assert.equal(c.filtered.length, 2);
  type(c, " gamma");
  assert.equal(c.filtered.length, 0);
});

test("关键词命中会话名", () => {
  const c = make(fixture(), "D:/nowhere");
  type(c, "named-x");
  assert.equal(c.filtered.length, 1);
  assert.equal(c.filtered[0].cwd, "D:/projX");
});

test("@10d 时间过滤，头部显示时间标签", () => {
  const c = make(fixture(), "D:/nowhere");
  type(c, "alpha beta @10d");
  assert.equal(c.filtered.length, 1);
  assert.equal(c.filtered[0].cwd, "D:/proj");
  assert.ok(strip(c.render(120)[0]).includes("近10天"));
});

test("头部显示匹配数", () => {
  const c = make(fixture(), "D:/nowhere");
  type(c, "beta");
  assert.ok(strip(c.render(120)[0]).includes("匹配 2/4"));
});

test("有关键词时列表第二行显示命中片段", () => {
  const c = make(fixture(), "D:/nowhere");
  type(c, "gamma");
  const row2 = strip(c.render(120)[4]);
  assert.ok(row2.includes("…"));
  assert.ok(row2.includes("gamma"));
});

test("没有关键词时列表第二行显示首条消息和会话名", () => {
  const c = make(fixture(), "D:/nowhere");
  const rows = c.render(120).map(strip);
  assert.ok(rows[4].includes("alpha beta"));
  const named = rows.find((r: string) => r.includes("beta alpha  [other-name]"));
  assert.ok(named);
});

test("只移动光标不重置选中项", () => {
  const c = make(fixture(), "D:/nowhere");
  c.handleInput(KEY.down);
  assert.equal(c.selected, 1);
  c.handleInput("\x1b[H");
  assert.equal(c.selected, 1);
  type(c, "a");
  assert.equal(c.selected, 0);
});

test("Enter 进入，Ctrl+O 分叉，Esc / Ctrl+C 关闭", () => {
  const c = make();
  const got: string[] = [];
  c.onResume = (s: PeekSession) => got.push("resume:" + s.cwd);
  c.onFork = (s: PeekSession) => got.push("fork:" + s.cwd);
  c.onCancel = () => got.push("cancel");
  c.handleInput(KEY.enter);
  c.handleInput(KEY.co);
  c.handleInput(KEY.esc);
  c.handleInput(KEY.cc);
  assert.deepEqual(got, ["resume:D:/proj", "fork:D:/proj", "cancel", "cancel"]);
});

test("Ctrl+D 需要确认：y / Enter 执行，其他键取消", async () => {
  const c = make();
  let deleted = 0;
  c.onDelete = async () => (deleted++, true);
  c.handleInput(KEY.cd);
  assert.equal(c.confirmingDelete, true);
  assert.ok(strip(c.render(120).at(-1)).includes("删除会话"));
  c.handleInput("n");
  assert.equal(c.confirmingDelete, false);
  assert.equal(deleted, 0);

  c.handleInput(KEY.cd);
  c.handleInput(KEY.enter);
  await tick();
  assert.equal(deleted, 1);
  assert.equal(c.filtered.length, 1);
  assert.equal(c.all.length, 3);

  c.handleInput(KEY.cd);
  c.handleInput("y");
  await tick();
  assert.equal(deleted, 2);
  assert.equal(c.filtered.length, 0);
});

test("删除确认中按 Ctrl+C 只取消确认，不关闭", () => {
  const c = make();
  let cancelled = 0;
  c.onCancel = () => cancelled++;
  c.onDelete = async () => true;
  c.handleInput(KEY.cd);
  c.handleInput(KEY.cc);
  assert.equal(c.confirmingDelete, false);
  assert.equal(cancelled, 0);
});

test("删除失败时列表不变", async () => {
  const c = make();
  c.onDelete = async () => false;
  c.handleInput(KEY.cd);
  c.handleInput("y");
  await tick();
  assert.equal(c.filtered.length, 2);
});

test("删除在途时不能再删、改名、进入、分叉；回来后恢复", async () => {
  const c = make();
  let resolve!: (ok: boolean) => void;
  let calls = 0;
  c.onDelete = () => (calls++, new Promise<boolean>((r) => (resolve = r)));
  const opened: string[] = [];
  c.onResume = () => opened.push("resume");
  c.onFork = () => opened.push("fork");
  c.onRename = async () => true;
  c.handleInput(KEY.cd);
  c.handleInput("y");
  assert.equal(calls, 1);
  // 回调没回来之前
  c.handleInput(KEY.cd);
  assert.equal(c.confirmingDelete, false);
  c.handleInput(KEY.cr);
  assert.equal(c.renaming, false);
  c.handleInput(KEY.enter);
  c.handleInput(KEY.co);
  c.render(120);
  c.handleMouse({ type: "press", button: "left", x: 2, y: 3 });
  c.handleMouse({ type: "click", button: "left", x: 2, y: 3, clickCount: 2 });
  assert.deepEqual(opened, []);
  resolve(true);
  await tick();
  assert.equal(c.filtered.length, 1);
  c.handleInput(KEY.enter);
  assert.deepEqual(opened, ["resume"]);
});

test("删除 / 重命名回调抛错也会解锁，不会永久锁住", async () => {
  const c = make();
  c.onDelete = async () => { throw new Error("boom"); };
  c.onRename = async () => { throw new Error("boom"); };
  c.handleInput(KEY.cd);
  c.handleInput("y");
  assert.equal(c.busy, true);
  await tick();
  assert.equal(c.busy, false);
  assert.equal(c.filtered.length, 2, "nothing removed on error");
  c.handleInput(KEY.cr);
  c.renameInput.setValue("x");
  c.handleInput(KEY.enter);
  assert.equal(c.busy, true);
  await tick();
  assert.equal(c.busy, false);
});

test("Ctrl+R 重命名：Enter 提交，名字参与搜索", async () => {
  const c = make(fixture(), "D:/nowhere");
  const calls: string[] = [];
  c.onRename = async (_s: PeekSession, name: string) => (calls.push(name), true);
  c.handleInput(KEY.cr);
  assert.equal(c.renaming, true);
  assert.ok(strip(c.render(120).at(-1)).includes("重命名"));
  c.renameInput.setValue("fresh-name");
  c.handleInput(KEY.enter);
  await tick();
  assert.deepEqual(calls, ["fresh-name"]);
  assert.equal(c.filtered[0].name, "fresh-name");
  // 新名字立刻参与搜索，且不区分大小写
  c.input.setValue("FRESH-name");
  c.refilter();
  assert.deepEqual(c.filtered.map((s: PeekSession) => s.name), ["fresh-name"]);
});

test("重命名后不再匹配关键词的会话从列表移除，仍匹配的保持选中", async () => {
  const all = fixture();
  const c = make(all, "D:/nowhere");
  c.onRename = async () => true;
  type(c, "named-x");
  assert.equal(c.filtered.length, 1);
  c.handleInput(KEY.cr);
  c.renameInput.setValue("other");
  c.handleInput(KEY.enter);
  await tick();
  assert.equal(c.filtered.length, 0);

  const c2 = make(fixture(), "D:/nowhere");
  c2.onRename = async () => true;
  type(c2, "alpha");
  c2.handleInput(KEY.down);
  const target = c2.filtered[1];
  c2.handleInput(KEY.cr);
  c2.renameInput.setValue("still alpha");
  c2.handleInput(KEY.enter);
  await tick();
  assert.equal(c2.filtered[c2.selected], target);
});

test("重命名中 Esc / Ctrl+C 只取消重命名", () => {
  const c = make();
  let cancelled = 0;
  c.onCancel = () => cancelled++;
  c.onRename = async () => true;
  c.handleInput(KEY.cr);
  c.handleInput(KEY.esc);
  assert.equal(c.renaming, false);
  c.handleInput(KEY.cr);
  c.handleInput(KEY.cc);
  assert.equal(c.renaming, false);
  assert.equal(cancelled, 0);
});

test("焦点跟着活跃的输入框走", () => {
  const c = make();
  c.onRename = async () => true;
  c.focused = true;
  assert.equal(c.input.focused, true);
  assert.equal(c.renameInput.focused, false);
  c.handleInput(KEY.cr);
  assert.equal(c.input.focused, false);
  assert.equal(c.renameInput.focused, true);
  c.handleInput(KEY.esc);
  assert.equal(c.input.focused, true);
});

test("预览滚动：Ctrl+U / Ctrl+F，PgUp / PgDn，到边界夹住", () => {
  const long = mk("D:/proj", Array.from({ length: 60 }, (_, i) => `message number ${i} ${"x".repeat(80)}`), 1);
  const c = make([long], "D:/proj");
  c.render(120);
  const bottom = c.previewOffset;
  assert.ok(bottom > 0);
  c.handleInput(KEY.cu);
  const up = c.previewOffset;
  assert.ok(up < bottom);
  c.handleInput(KEY.cf);
  assert.equal(c.previewOffset, bottom);
  c.handleInput(KEY.cf);
  c.render(120);
  assert.equal(c.previewOffset, bottom);
  c.handleInput("\x1b[5~");
  assert.ok(c.previewOffset < bottom);
});

test("有关键词时预览定位到第一个命中，Ctrl+N / Ctrl+P 在命中间跳转并回绕", () => {
  const texts = Array.from({ length: 40 }, (_, i) => (i === 5 || i === 25 ? `hit ${i}` : `filler ${i}`));
  const c = make([mk("D:/proj", texts, 1)], "D:/proj", "hit");
  c.render(120);
  assert.equal(c.matchLines.length, 2);
  assert.equal(c.previewOffset, Math.max(0, c.matchLines[0] - 2));
  c.handleInput("\x0e");
  assert.equal(c.previewOffset, c.matchLines[1] - 2);
  c.handleInput("\x0e");
  assert.equal(c.previewOffset, Math.max(0, c.matchLines[0] - 2));
  c.handleInput("\x10");
  assert.equal(c.previewOffset, c.matchLines[1] - 2);
});

test("同一条消息里多处命中，每一行都是跳转点", () => {
  const body = Array.from({ length: 60 }, (_, i) => (i % 20 === 0 ? `hit line ${i}` : `filler ${i}`)).join("\n\n");
  const c = make([mk("D:/proj", ["question", body], 1)], "D:/proj", "hit");
  c.render(120);
  const lines: string[] = c.previewLines.map(strip);
  assert.deepEqual(
    c.matchLines,
    lines.map((l, i) => (l.includes("hit") ? i : -1)).filter((i) => i >= 0),
  );
  assert.equal(c.matchLines.length, 3);
  c.handleInput("\x0e");
  assert.equal(c.previewOffset, c.matchLines[1] - 2);
  c.handleInput("\x0e");
  assert.equal(c.previewOffset, c.matchLines[2] - 2);
});

test("Ctrl+N 跳过当前视口里的命中，Ctrl+P 同理", () => {
  // 第 0、1、2 行连着命中，再隔很远一个
  const body = ["hit a", "hit b", "hit c", ...Array.from({ length: 50 }, (_, i) => `filler ${i}`), "hit far"].join("\n\n");
  const c = make([mk("D:/proj", ["question", body], 1)], "D:/proj", "hit");
  c.render(120);
  const H = c.bodyHeight();
  assert.equal(c.matchLines.length, 4);
  assert.ok(c.matchLines[2] < c.previewOffset + H, "first three hits share the viewport");
  c.handleInput("\x0e");
  c.render(120);
  const maxOff = Math.max(0, c.previewLines.length - H);
  assert.equal(c.previewOffset, Math.min(c.matchLines[3] - 2, maxOff), "one Ctrl+N goes straight to the far hit");
  assert.ok(c.matchLines[3] >= c.previewOffset && c.matchLines[3] < c.previewOffset + H, "far hit is on screen");
  c.handleInput("\x10");
  c.render(120);
  assert.equal(c.previewOffset, c.matchLines[2] - 2, "Ctrl+P lands on the nearest hit above the viewport");
});

test("右上角显示命中序号，随跳转变化", () => {
  const body = ["hit a", ...Array.from({ length: 50 }, (_, i) => `filler ${i}`), "hit far"].join("\n\n");
  const c = make([mk("D:/proj", ["question", body], 1)], "D:/proj", "hit");
  let top = strip(c.render(120)[3]);
  assert.ok(top.includes("命中 1/2"), top);
  c.handleInput("\x0e");
  top = strip(c.render(120)[3]);
  assert.ok(top.includes("命中 2/2"), top);
});

test("关键词只命中会话名时预览给出提示", () => {
  const c = make(fixture(), "D:/nowhere", "named-x");
  const lines = c.render(120).map(strip).join("\n");
  assert.ok(lines.includes("对话正文无匹配"));
});

test("没有匹配时右栏提示", () => {
  const c = make(fixture(), "D:/nowhere", "zzzzzz");
  assert.equal(c.filtered.length, 0);
  assert.ok(c.render(120).map(strip).join("\n").includes("没有匹配的会话"));
});

test("每行宽度不超过给定宽度", () => {
  const c = make(fixture(), "D:/nowhere", "alpha");
  for (const w of [80, 100, 140]) {
    for (const line of c.render(w)) assert.ok(strip(line).length <= w, `width ${w}: ${strip(line).length}`);
  }
});

const MD_REPLY = [
  "问题在 **getHttpValue**，见 [文档](https://example.com/doc)。",
  "",
  "```ts",
  "const token = getHttpValue(res.headers);",
  "```",
  "",
  "| 文件 | 改动 |",
  "| --- | --- |",
  "| src/utils/http.ts | 读取移到 response 事件之后，并加了失败重试 |",
  "| src/views/login.vue | 换成同一个封装 |",
  "",
  "- 第一点",
  "- 第二点",
].join("\n");

function mdFixture() {
  return [mk("D:/proj", ["帮我看下 token 为什么是 undefined", MD_REPLY], 1)];
}

test("预览用 Markdown 渲染：表格画出边框且不超宽，代码块和列表保持结构", () => {
  const c = make(mdFixture(), "D:/proj");
  c.handleInput(KEY.cu);
  c.handleInput(KEY.cu);
  const width = 110;
  const lines = c.render(width).map(strip);
  const body = lines.slice(3, 3 + c.bodyHeight());
  assert.ok(body.every((l: string) => visibleWidth(l) === width), "every body row is full width");
  const right = c.previewLines.map(strip);
  assert.ok(right.some((l: string) => l.startsWith(" ┌") && l.includes("┬")), "table top border");
  assert.ok(right.some((l: string) => /^ │ 文件\s+│ 改动\s+│/.test(l)), "table header row");
  assert.ok(right.some((l: string) => l.includes("src/utils/http.ts") && l.includes("│")), "table cell");
  assert.ok(right.some((l: string) => l.trim() === "```ts"), "code fence");
  assert.ok(right.some((l: string) => l.trim() === "- 第一点"), "list item");
  assert.ok(!right.some((l: string) => l.includes("**")), "bold markers are consumed");
  assert.ok(!right.some((l: string) => l.includes("](")), "link syntax is consumed");
});

test("预览的关键词高亮在渲染之后叠加，不破坏表格和链接", () => {
  const c = make(mdFixture(), "D:/proj", "http");
  c.render(110);
  const raw: string[] = c.previewLines;
  const cell = raw.find((l) => strip(l).includes("src/utils/http.ts"))!;
  assert.ok(cell.includes("\x1b[1m\x1b[4m"), "keyword inside a table cell is highlighted");
  assert.ok(strip(cell).includes("│"), "cell borders survive");
  const link = raw.find((l) => strip(l).includes("文档"))!;
  assert.ok(link.includes("\x1b]8;;https://example.com/doc"), "hyperlink survives");
  assert.ok(!strip(link).includes("]("), "link syntax is consumed");
  // 命中按行记：正好是去掉样式后含关键词的那些行
  const expect = raw.map((l, i) => (strip(l).toLowerCase().includes("http") ? i : -1)).filter((i) => i >= 0);
  assert.ok(expect.length > 1);
  assert.deepEqual(c.matchLines, expect);
});

test("同一宽度下每条消息只渲染一次，换关键词也不重来", () => {
  const all = mdFixture();
  const c = make(all, "D:/proj");
  c.render(110);
  const first = c.rendered.get(all[0].msgs[1]).lines;
  type(c, "http");
  c.render(110);
  assert.equal(c.rendered.get(all[0].msgs[1]).lines, first);
  c.render(120);
  assert.notEqual(c.rendered.get(all[0].msgs[1]).lines, first);
});

test("主体高度为奇数时，最后一行的分隔线仍在同一列（右栏不会顶到左边）", () => {
  const long = mk("D:/proj", Array.from({ length: 80 }, (_, i) => `line ${i} ${"x".repeat(60)}`), 1);
  const saved = process.stdout.rows;
  Object.defineProperty(process.stdout, "rows", { value: undefined, configurable: true, writable: true });
  try {
    for (const termRows of [35, 36]) {
      const c: any = new PeekComponent([long], "D:/proj", theme, mdTheme, termRows, "");
      c.requestRender = () => {};
      const H = c.bodyHeight();
      assert.equal(H, termRows - 12);
      const width = 120;
      c.render(width);
      c.handleInput(KEY.cu);
      c.handleInput(KEY.cu);
      const lines = c.render(width).map(strip);
      const body = lines.slice(3, 3 + H);
      assert.equal(body.length, H);
      const cols = new Set(body.map((l: string) => l.indexOf("│")));
      assert.equal(cols.size, 1, `separator columns: ${[...cols].join(",")} (H=${H})`);
      assert.ok(body.every((l: string) => visibleWidth(l) === width), "every body row is full width");
    }
  } finally {
    Object.defineProperty(process.stdout, "rows", { value: saved, configurable: true, writable: true });
  }
});

// 搜索语法在组件里的整体效果：过滤、命中数、片段、高亮都按同一套规则
function cwds(q: string, all = fixture()): string[] {
  const c = make(all, "D:/nowhere");
  type(c, q);
  return c.filtered.map((s: PeekSession) => s.cwd);
}

test("搜索语法：短语、OR、排除、字段前缀、正则都能过滤", () => {
  assert.deepEqual(cwds('"alpha beta"'), ["D:/proj"]); // "beta alpha" 顺序不对，不算
  assert.deepEqual(cwds("alpha -beta"), ["D:/proj/packages/web"]);
  assert.deepEqual(cwds("gamma|only"), ["D:/proj/packages/web", "D:/projX"]);
  assert.deepEqual(cwds("name:other"), ["D:/other"]);
  assert.deepEqual(cwds("dir:projx"), ["D:/projX"]);
  assert.deepEqual(cwds("ai:reply"), ["D:/proj"]);
  assert.deepEqual(cwds("user:reply"), []);
  assert.deepEqual(cwds("/alph[a]\\s+(beta|only)/"), ["D:/proj", "D:/proj/packages/web"]);
  assert.deepEqual(cwds("-ai:reply -gamma @30d"), ["D:/proj/packages/web"]);
});

test("只有排除词或 name: / dir: 时列表不显示命中数和片段，预览不高亮也不提示", () => {
  const c = make(fixture(), "D:/nowhere");
  type(c, "-gamma name:other");
  assert.deepEqual(c.filtered.map((s: PeekSession) => s.cwd), ["D:/other"]);
  const rows = c.render(120).map(strip);
  assert.ok(!/·\d/.test(rows[3]), rows[3]);
  assert.ok(rows[4].includes("beta alpha  [other-name]"), rows[4]);
  assert.equal(c.matchLines.length, 0);
  assert.ok(!rows.join("\n").includes("对话正文无匹配"));
});

test("ai: 的词只在 AI 回复里计数、截片段和高亮，user: 同理", () => {
  const all = [mk("D:/proj", ["alpha asks", "alpha answers", "alpha again"], 1)];
  const c = make(all, "D:/proj");
  type(c, "ai:alpha");
  let rows = c.render(120);
  assert.ok(strip(rows[3]).includes("·1"), strip(rows[3]));
  assert.ok(strip(rows[4]).includes("alpha answers"), strip(rows[4]));
  assert.ok(rows[4].includes("\x1b[1m\x1b[4m"), "snippet is highlighted");
  const hit = c.previewLines.filter((l: string) => l.includes("\x1b[1m\x1b[4m")).map((l: string) => strip(l).trim());
  assert.deepEqual(hit, ["alpha answers"]);
  assert.equal(c.matchLines.length, 1);

  c.input.setValue("user:alpha");
  c.refilter();
  c.invalidate();
  rows = c.render(120);
  assert.ok(strip(rows[3]).includes("·2"), strip(rows[3]));
  assert.deepEqual(
    c.previewLines.filter((l: string) => l.includes("\x1b[1m\x1b[4m")).map((l: string) => strip(l).trim()),
    ["alpha asks", "alpha again"],
  );
});

test("短语和正则在预览里整段高亮，排除词不高亮", () => {
  const all = [mk("D:/proj", ["find the get http value", "getHttpValue is here, draft"], 1)];
  const c = make(all, "D:/proj");
  type(c, '"get http" /gethttp\\w+/ -zzz');
  c.render(120);
  const hit = c.previewLines.filter((l: string) => l.includes("\x1b[1m\x1b[4m"));
  assert.equal(hit.length, 2);
  assert.ok(hit[0].includes(`\x1b[1m\x1b[4mget http\x1b[24m`), hit[0]);
  assert.ok(hit[1].includes(`\x1b[1m\x1b[4mgetHttpValue\x1b[24m`), hit[1]);
});

// 预览右栏去掉样式后的文字行
function rightCol(c: any, width = 100): string[] {
  c.render(width);
  return c.previewLines.map(strip);
}

function toolFixture(): PeekSession[] {
  const s = mk("D:/proj", ["fix the bug", "let me look", "done, fixed"], 1);
  s.msgs[1].tools = [{ name: "read", summary: "src/a.ts" }];
  // 只有工具调用、没写字的 AI 轮次，紧接在上一条 AI 文字后面
  s.msgs.splice(2, 0, { role: "assistant", text: "", tools: [{ name: "bash", summary: "npm test" }, { name: "edit", summary: "" }] });
  s.msgs[3].role = "assistant";
  return [s];
}

test("工具调用默认不显示，只有工具调用的 AI 轮次整条跳过", () => {
  const c = make(toolFixture(), "D:/proj");
  const lines = rightCol(c);
  assert.ok(!lines.some((l) => l.includes("⚙")));
  assert.equal(lines.filter((l) => l.startsWith("🤖 AI")).length, 2);
  assert.ok(lines.some((l) => l.includes("let me look")));
  assert.ok(lines.some((l) => l.includes("done, fixed")));
});

test("Ctrl+T 显示工具调用摘要，纯工具轮次接在上一条 AI 正文下面不重复标签，再按一次关掉", () => {
  const c = make(toolFixture(), "D:/proj");
  c.handleInput(KEY.ct);
  const lines = rightCol(c);
  const tools = lines.filter((l) => l.includes("⚙")).map((l) => l.trim());
  assert.deepEqual(tools, ["⚙ read  src/a.ts", "⚙ bash  npm test", "⚙ edit"]);
  assert.equal(lines.filter((l) => l.startsWith("🤖 AI")).length, 2);
  // 顺序：AI 标签 → 正文 → read → bash → edit → 空行 → AI 标签 → done
  const look = lines.findIndex((l) => l.includes("let me look"));
  const edit = lines.findIndex((l) => l.includes("⚙ edit"));
  const done = lines.findIndex((l) => l.includes("done, fixed"));
  assert.ok(look < edit && edit < done);
  assert.equal(lines[edit + 1], "");
  assert.ok(lines[edit + 2].startsWith("🤖 AI"));
  c.handleInput(KEY.ct);
  assert.ok(!rightCol(c).some((l) => l.includes("⚙")));
});

test("工具摘要不参与搜索和高亮", () => {
  const c = make(toolFixture(), "D:/proj");
  c.handleInput(KEY.ct);
  type(c, "npm");
  assert.equal(c.filtered.length, 0);
  type(c, KEY.bs + KEY.bs + KEY.bs);
  type(c, "fixed");
  assert.equal(c.filtered.length, 1);
  rightCol(c);
  assert.equal(c.matchLines.length, 1);
});

// 鼠标：坐标以组件左上角为原点，第 0 行标题、第 1 行搜索框、第 2 行分隔线，第 3 行起是双栏
const MOUSE = (type: "press" | "click" | "wheel" | "release", x: number, y: number, extra: Record<string, unknown> = {}) => ({
  type,
  button: type === "wheel" ? "none" : "left",
  x,
  y,
  screenX: x,
  screenY: y,
  width: 120,
  height: 40,
  shift: false,
  alt: false,
  ctrl: false,
  ...extra,
});

test("鼠标：没画过之前不处理；左栏按下选中，同一项再按不重画，双击进入，单击不进入", () => {
  const c = make(fixture(), "D:/nowhere");
  assert.equal(c.handleMouse(MOUSE("press", 2, 5)), undefined);
  c.render(120);
  const lw = c.layout.lw;
  assert.equal(lw, 48);
  const got: string[] = [];
  c.onResume = (s: PeekSession) => got.push(s.cwd);
  // 第 3 项占主体第 4、5 行，即组件第 7、8 行
  assert.deepEqual(c.handleMouse(MOUSE("press", 2, 8)), { handled: true, capture: true, render: true });
  assert.equal(c.selected, 2);
  assert.deepEqual(c.handleMouse(MOUSE("press", lw - 1, 7)), { handled: true, capture: true, render: false });
  assert.equal(c.selected, 2);
  c.handleMouse(MOUSE("click", 2, 8, { clickCount: 1 }));
  assert.deepEqual(got, []);
  c.handleMouse(MOUSE("click", 2, 8, { clickCount: 2 }));
  assert.deepEqual(got, ["D:/projX"]);
  // 列表下面的空白行和右栏按下也接管（可能是拖选的起点），但不改选中项
  assert.deepEqual(c.handleMouse(MOUSE("press", 2, 3 + 8)), { handled: true, capture: true, render: false });
  assert.deepEqual(c.handleMouse(MOUSE("release", 2, 3 + 8)), { handled: true, render: false });
  assert.deepEqual(c.handleMouse(MOUSE("press", lw + 5, 5)), { handled: true, capture: true, render: false });
  c.handleMouse(MOUSE("release", lw + 5, 5));
  assert.equal(c.handleMouse(MOUSE("release", 2, 8)), undefined); // 没按下就松开，不管
  assert.equal(c.selected, 2);
});

test("鼠标：左栏滚轮换选中项并到边界夹住，右栏滚轮滚预览三行一格", () => {
  const long = mk("D:/proj", Array.from({ length: 60 }, (_, i) => `message number ${i} ${"x".repeat(80)}`), 1);
  const c = make([...fixture(), long], "D:/nowhere");
  c.render(120);
  const lw = c.layout.lw;
  assert.deepEqual(c.handleMouse(MOUSE("wheel", 2, 5, { wheelDelta: 1 })), { handled: true, render: true });
  assert.equal(c.selected, 1);
  c.handleMouse(MOUSE("wheel", 2, 5, { wheelDelta: -5 }));
  assert.equal(c.selected, 0);
  assert.deepEqual(c.handleMouse(MOUSE("wheel", 2, 5, { wheelDelta: -1 })), { handled: true, render: false });
  c.handleMouse(MOUSE("wheel", 2, 5, { wheelDelta: 99 }));
  assert.equal(c.selected, 4);

  c.render(120);
  const bottom = c.previewOffset;
  assert.ok(bottom > 6);
  assert.deepEqual(c.handleMouse(MOUSE("wheel", lw + 10, 5, { wheelDelta: -1 })), { handled: true, render: true });
  assert.equal(c.previewOffset, bottom - 3);
  c.handleMouse(MOUSE("wheel", lw + 10, 5, { wheelDelta: 5 }));
  c.render(120);
  assert.equal(c.previewOffset, bottom, "clamped at the end");
  c.handleMouse(MOUSE("wheel", lw + 10, 5, { wheelDelta: -999 }));
  assert.equal(c.previewOffset, 0);
  assert.equal(c.selected, 4, "preview wheel leaves the selection alone");
});

test("鼠标：点头部的范围字样切换范围，点别处不管；点搜索框移动光标", () => {
  const c = make();
  c.render(120);
  assert.equal(c.scope, "current");
  const [from, to] = c.scopeSpan;
  assert.ok(from > 0 && to > from);
  assert.deepEqual(c.handleMouse(MOUSE("press", from, 0)), { handled: true, render: true });
  assert.equal(c.scope, "all");
  c.handleMouse(MOUSE("press", to - 1, 0));
  assert.equal(c.scope, "current");
  assert.equal(c.handleMouse(MOUSE("press", 0, 0)), undefined);
  assert.equal(c.handleMouse(MOUSE("press", to, 0)), undefined);
  assert.equal(c.scope, "current");

  type(c, "abc");
  assert.equal(c.input.cursor, 3);
  assert.deepEqual(c.handleMouse(MOUSE("press", 3, 1)), { handled: true, render: true });
  assert.equal(c.input.cursor, 1);
  assert.equal(c.selected, 0);
});

test("鼠标：删除确认中按一下就取消；改名中滚轮不换会话，点改名行移动光标", () => {
  const c = make();
  c.onDelete = async () => true;
  c.onRename = async () => true;
  c.render(120);
  c.handleInput(KEY.cd);
  assert.equal(c.confirmingDelete, true);
  assert.deepEqual(c.handleMouse(MOUSE("press", c.layout.lw + 5, 5)), { handled: true, capture: true, render: true });
  assert.equal(c.confirmingDelete, false);

  c.handleInput(KEY.cr);
  c.renameInput.setValue("hello");
  c.handleMouse(MOUSE("wheel", 2, 5, { wheelDelta: 1 }));
  assert.equal(c.selected, 0);
  c.handleMouse(MOUSE("click", 2, 3, { clickCount: 2 }));
  assert.equal(c.renaming, true);
  const lastRow = 3 + c.layout.H + 1;
  const prefixW = visibleWidth("✏ 重命名: ");
  assert.deepEqual(c.handleMouse(MOUSE("press", prefixW + 2 + 2, lastRow)), { handled: true, render: true });
  assert.equal(c.renameInput.cursor, 2);
});

test("cursorRow：没焦点时不知道，搜索框在第 1 行，改名时在最后一行；render 每次都通知 afterRender", () => {
  const c = make();
  c.onRename = async () => true;
  let notified = 0;
  c.afterRender = () => notified++;
  assert.equal(c.cursorRow(), undefined);
  c.render(120);
  assert.equal(notified, 1);
  c.render(120); // 缓存命中也要通知：组件在屏幕上的位置可能变了
  assert.equal(notified, 2);
  assert.equal(c.cursorRow(), undefined);
  c.focused = true;
  assert.equal(c.cursorRow(), 1);
  c.handleInput(KEY.cr);
  assert.equal(c.cursorRow(), 3 + c.layout.H + 1);
  c.handleInput(KEY.esc);
  assert.equal(c.cursorRow(), 1);
});

// 拖选：按下 → 拖动 → 松开，只高亮不复制；Ctrl+C 复制
const drag = (c: any, x0: number, y0: number, x1: number, y1: number) => {
  c.handleMouse(MOUSE("press", x0, y0));
  c.handleMouse({ ...MOUSE("press", x1, y1), type: "drag" });
  c.handleMouse(MOUSE("release", x1, y1));
};
const INV = "\x1b[7m";
// 主体里带反显的行号（搜索框的光标也是反显，不算）
const hlRows = (c: any, width = 120): number[] =>
  c.render(width).map((l: string, i: number) => (i >= 3 && i < 3 + c.layout.H && l.includes(INV) ? i : -1)).filter((i: number) => i >= 0);

function longFixture() {
  const texts = Array.from({ length: 30 }, (_, i) => `line ${String(i).padStart(2, "0")} ${"abcdefghij".repeat(6)}`);
  return [mk("D:/proj", texts, 1), mk("D:/other", ["other one", "reply"], 2)];
}

test("拖选：右栏拖出的选区只在右栏，首行从起点起、中间整行、末行到终点；松开不复制，Ctrl+C 才复制并清掉高亮", async () => {
  const c = make(longFixture(), "D:/nowhere");
  const copied: string[] = [];
  c.onCopy = async (t: string) => (copied.push(t), true);
  let cancelled = 0;
  c.onCancel = () => cancelled++;
  c.render(120);
  const { lw, rw, H } = c.layout;
  const x0 = lw + 3;
  c.handleInput(KEY.cu);
  c.handleInput(KEY.cu);
  c.render(120);
  const top = c.previewOffset;
  const raw: string[] = c.previewLines.map(strip);
  // 从第 2 行第 4 列拖到第 4 行第 8 列（都是主体行号）
  const r = c.handleMouse(MOUSE("press", x0 + 4, 3 + 2));
  assert.deepEqual(r, { handled: true, capture: true, render: false });
  assert.deepEqual(hlRows(c), [], "no highlight before dragging");
  c.handleMouse({ ...MOUSE("press", x0 + 8, 3 + 4), type: "drag" });
  assert.deepEqual(c.handleMouse(MOUSE("release", x0 + 8, 3 + 4)), { handled: true, render: false });
  assert.equal(copied.length, 0, "release does not copy");
  const lines = c.render(120);
  const hl = hlRows(c);
  assert.deepEqual(hl, [3 + 2, 3 + 3, 3 + 4]);
  // 高亮只在右栏：分隔线左边没有反显
  for (const i of hl) {
    const line = lines[i];
    assert.ok(line.indexOf(INV) > line.indexOf("│"), "highlight starts after the separator");
  }
  assert.ok(strip(lines.at(-1)).includes("已选 3 行"), strip(lines.at(-1)));
  c.handleInput(KEY.cc);
  await tick();
  assert.equal(cancelled, 0, "Ctrl+C with a selection copies instead of closing");
  assert.deepEqual(copied, [[raw[top + 2].slice(4).trimEnd(), raw[top + 3].trimEnd(), raw[top + 4].slice(0, 9).trimEnd()].join("\n")]);
  assert.deepEqual(hlRows(c), [], "highlight cleared after copy");
  assert.ok(strip(c.render(120).at(-1)).includes("已复制 3 行"));
  c.handleInput(KEY.cc);
  assert.equal(cancelled, 1, "Ctrl+C without a selection closes");
  assert.ok(rw > 20 && H > 0);
});

test("拖选：左栏的选区不会跨到右栏，拖到右栏也只选左栏的字；文字来自列表行", async () => {
  const c = make(longFixture(), "D:/nowhere");
  const copied: string[] = [];
  c.onCopy = async (t: string) => (copied.push(t), true);
  const lines0 = c.render(120);
  const { lw } = c.layout;
  drag(c, 2, 3, lw + 20, 4 + 3); // 从第 1 项第一行拖到右栏
  const lines = c.render(120);
  for (const i of [3, 4, 5, 6, 7]) {
    const line = lines[i];
    assert.ok(line.includes(INV), `row ${i} highlighted`);
    assert.ok(line.indexOf("\x1b[27m") < line.indexOf("│"), `row ${i}: highlight ends before the separator`);
  }
  assert.ok(!lines[8].includes(INV));
  c.handleInput(KEY.cc);
  await tick();
  const left = lines0.slice(3, 8).map((l: string) => strip(l).slice(0, lw));
  const want = [left[0].slice(2).trimEnd(), ...left.slice(1, 4).map((l: string) => l.trimEnd()), left[4].slice(0, lw).trimEnd()].join("\n");
  assert.deepEqual(copied, [want]);
  assert.ok(copied[0].includes("proj"));
  assert.ok(!copied[0].includes("│"));
});

test("拖选：往上拖也行；单击不留选区；再按一下清掉选区；换会话、打字、Ctrl+T 都清掉", () => {
  const c = make(longFixture(), "D:/nowhere");
  c.render(120);
  const x0 = c.layout.lw + 3;
  drag(c, x0 + 5, 3 + 5, x0 + 1, 3 + 2);
  assert.equal(hlRows(c).length, 4);
  assert.deepEqual(c.handleMouse(MOUSE("press", x0 + 1, 3 + 1)), { handled: true, capture: true, render: true });
  c.handleMouse(MOUSE("release", x0 + 1, 3 + 1));
  assert.equal(hlRows(c).length, 0);
  assert.equal(c.sel, undefined);

  drag(c, x0 + 5, 3 + 5, x0 + 1, 3 + 2);
  c.handleInput(KEY.down);
  assert.equal(hlRows(c).length, 0);
  drag(c, x0 + 5, 3 + 5, x0 + 1, 3 + 2);
  type(c, "x");
  assert.equal(c.sel, undefined);
  c.handleInput(KEY.bs);
  drag(c, x0 + 5, 3 + 5, x0 + 1, 3 + 2);
  c.handleInput(KEY.ct);
  assert.equal(c.sel, undefined);
  // 预览滚动不清选区，高亮跟着内容走
  c.render(120); // 按键之后先画一帧，鼠标坐标才对得上当前的预览位置
  drag(c, x0 + 5, 3 + 5, x0 + 1, 3 + 2);
  const before = hlRows(c)[0];
  assert.equal(before, 3 + 2);
  c.handleInput("\x1b[1;2A"); // Shift+↑ 滚三行
  const after = hlRows(c)[0];
  assert.equal(after, before + 3);
});

test("拖选：右栏拖出下边自动滚动，焦点跟到最后一行；松开停下", async () => {
  const c = make(longFixture(), "D:/nowhere");
  c.render(120);
  const { lw, H } = c.layout;
  const x0 = lw + 3;
  c.handleInput(KEY.cu);
  c.handleInput(KEY.cu);
  c.handleInput(KEY.cu);
  c.render(120);
  const top = c.previewOffset;
  assert.ok(top + H < c.previewLines.length - 5, "room to scroll");
  c.handleMouse(MOUSE("press", x0 + 2, 3 + 2));
  c.handleMouse({ ...MOUSE("press", x0 + 2, 3 + H + 1), type: "drag" }); // 拖到主体下面
  assert.equal(c.autoScrollDir, 1);
  await tick(130);
  assert.ok(c.previewOffset > top, "scrolled down");
  assert.equal(c.sel.focus.row, c.previewOffset + H - 1, "focus follows the bottom row");
  c.handleMouse(MOUSE("release", x0 + 2, 3 + H + 1));
  const stopped = c.previewOffset;
  await tick(130);
  assert.equal(c.previewOffset, stopped, "stops on release");
  assert.equal(c.autoScrollTimer, undefined);
  c.dispose();
});

test("dispose 停掉计时器并调 onDispose", () => {
  const c = make();
  let disposed = 0;
  c.onDispose = () => disposed++;
  c.render(120);
  c.dispose();
  assert.equal(disposed, 1);
});

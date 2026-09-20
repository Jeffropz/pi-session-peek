import assert from "node:assert/strict";
import { test } from "node:test";
import { setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import { setLang } from "../src/i18n.ts";
import { PeekComponent } from "../src/peek-component.ts";
import type { PeekSession } from "../src/sessions.ts";
import { mdTheme, strip, theme } from "./helpers.ts";

setLang("zh");
// Markdown 只在检测到终端支持时才输出 OSC 8 超链接；CI 没有任何终端环境变量会走纯文本回退，
// 这里把能力固定住，让预览渲染在所有环境下一致
setCapabilities({ images: null, trueColor: true, hyperlinks: true });

const tick = () => new Promise((r) => setTimeout(r, 5));

const KEY = { enter: "\r", tab: "\t", up: "\x1b[A", down: "\x1b[B", bs: "\x7f", esc: "\x1b", cc: "\x03", cd: "\x04", cf: "\x06", co: "\x0f", cr: "\x12", cu: "\x15" };

function mk(cwd: string, texts: string[], ageDays: number, name = ""): PeekSession {
  const mtime = Date.now() - ageDays * 86400e3;
  return {
    path: `${cwd}/${texts[0].slice(0, 8)}.jsonl`,
    cwd,
    time: new Date(mtime).toISOString(),
    name,
    first: texts[0],
    msgs: texts.map((text, i) => ({ role: i % 2 ? "assistant" : "user", text })),
    searchText: (texts.join(" ") + " " + name + " " + cwd).toLowerCase(),
    mtime,
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
  assert.ok(c.filtered[0].searchText.includes("fresh-name"));
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

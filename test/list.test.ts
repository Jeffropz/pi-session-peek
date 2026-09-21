import assert from "node:assert/strict";
import { test } from "node:test";
import { bodyRows, paneWidths } from "../src/layout.ts";
import { buildList, followSelection, listRows, visibleItems } from "../src/list.ts";
import { roleTerms, parseQuery } from "../src/query.ts";
import type { PeekSession } from "../src/sessions.ts";
import { strip, theme } from "./helpers.ts";

// 几何和左栏的纯函数。组件层面的效果（选中高亮、命中片段、宽度）在 peek-component.test.ts 里

const NO_TERMS = { rt: roleTerms([]), hasBody: false };

function sess(cwd: string, first: string, name = ""): PeekSession {
  return { path: `${cwd}/x.jsonl`, cwd, time: new Date(2020, 0, 2, 3, 4).toISOString(), name, first, msgs: [{ role: "user", text: first }], mtime: 0, size: 0 };
}

test("paneWidths：左栏 40% 夹在 26..56，右栏拿剩下的至少 20", () => {
  assert.deepEqual(paneWidths(120), { lw: 48, rw: 69 });
  assert.deepEqual(paneWidths(50), { lw: 26, rw: 21 });
  assert.deepEqual(paneWidths(40), { lw: 26, rw: 20 }); // 右栏到底线，总宽不够时允许超出
  assert.deepEqual(paneWidths(200), { lw: 56, rw: 141 });
});

test("bodyRows：读 process.stdout.rows，读不到用给定值，夹在 8..30", () => {
  const saved = Object.getOwnPropertyDescriptor(process.stdout, "rows");
  Object.defineProperty(process.stdout, "rows", { value: undefined, configurable: true, writable: true });
  try {
    assert.equal(bodyRows(40), 28);
    assert.equal(bodyRows(15), 8);
    assert.equal(bodyRows(100), 30);
    assert.equal(bodyRows(0), 12); // 24 - 12
    Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true, writable: true });
    assert.equal(bodyRows(100), 18);
  } finally {
    if (saved) Object.defineProperty(process.stdout, "rows", saved);
  }
});

test("visibleItems / followSelection：每项两行；选中项跑出视口才挪偏移", () => {
  assert.equal(visibleItems(28), 14);
  assert.equal(visibleItems(1), 1);
  assert.equal(followSelection(3, 0, 5), 0); // 在视口里，不动
  assert.equal(followSelection(5, 0, 5), 1); // 刚好出下边，挪到刚好看见
  assert.equal(followSelection(12, 0, 5), 8);
  assert.equal(followSelection(2, 4, 5), 2); // 出上边，偏移就是选中项
});

test("listRows：选中行带 › 和背景，第二行是首条消息 + [名字]；时间带年份（不是今年）", () => {
  const s = sess("D:/proj/packages/web", "hello there", "nm");
  const [a, b] = listRows(s, true, 40, NO_TERMS.rt, NO_TERMS.hasBody, theme);
  assert.equal(strip(a), "› 2020-01-02 03:04 packages/web".padEnd(40));
  assert.equal(strip(b), "  hello there  [nm]".padEnd(40));
  const [c] = listRows(s, false, 40, NO_TERMS.rt, NO_TERMS.hasBody, theme);
  assert.ok(c.startsWith("  2020-01-02"));
});

test("listRows：有正文关键词时第一行带命中数，第二行是高亮片段", () => {
  const s = sess("D:/proj", "alpha beta alpha");
  const rt = roleTerms(parseQuery("alpha").terms);
  const [a, b] = listRows(s, false, 40, rt, true, theme);
  assert.ok(strip(a).includes(" ·1"), strip(a));
  assert.ok(b.includes("\x1b[1m\x1b[4m"), "snippet highlighted");
});

test("buildList：从 offset 起画满 height 行，空位补空，奇数高度补一行", () => {
  const all = [sess("D:/a", "one"), sess("D:/b", "two"), sess("D:/c", "three")];
  const rows = buildList(all, 1, 1, 5, 30, NO_TERMS.rt, NO_TERMS.hasBody, theme);
  assert.equal(rows.length, 5);
  assert.ok(strip(rows[0]).includes("D:/b"));
  assert.ok(strip(rows[1]).includes("two"));
  assert.ok(strip(rows[2]).includes("D:/c"));
  assert.equal(rows[4], " ".repeat(30));
  for (const r of rows) assert.equal(strip(r).length, 30);
});

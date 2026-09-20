import assert from "node:assert/strict";
import { test } from "node:test";
import { bounds, highlightColumns, rowColumns, selectionText, type Selection } from "../src/selection.ts";

// 选区的纯函数：起止排序、每行的列区间、反显、取文字

const sel = (ar: number, ac: number, fr: number, fc: number): Selection => ({
  pane: "preview",
  anchor: { row: ar, col: ac },
  focus: { row: fr, col: fc },
});

test("bounds：按阅读顺序排，往上拖也一样", () => {
  assert.deepEqual(bounds(sel(1, 5, 3, 2)), [{ row: 1, col: 5 }, { row: 3, col: 2 }]);
  assert.deepEqual(bounds(sel(3, 2, 1, 5)), [{ row: 1, col: 5 }, { row: 3, col: 2 }]);
  assert.deepEqual(bounds(sel(2, 7, 2, 3)), [{ row: 2, col: 3 }, { row: 2, col: 7 }]);
});

test("rowColumns：首行从起点到行尾，中间整行，末行到终点那格为止；选区外的行没有", () => {
  const s = sel(1, 5, 3, 2);
  assert.deepEqual(rowColumns(s, 0, "abcdefghij", 10), undefined);
  assert.deepEqual(rowColumns(s, 1, "abcdefghij", 10), [5, 10]);
  assert.deepEqual(rowColumns(s, 2, "abcdefghij", 10), [0, 10]);
  assert.deepEqual(rowColumns(s, 3, "abcdefghij", 10), [0, 3]);
  assert.deepEqual(rowColumns(s, 4, "abcdefghij", 10), undefined);
  // 同一行
  assert.deepEqual(rowColumns(sel(2, 7, 2, 3), 2, "abcdefghij", 10), [3, 8]);
  assert.deepEqual(rowColumns(sel(2, 4, 2, 4), 2, "abcdefghij", 10), [4, 5]);
  // 超出栏宽夹住
  assert.deepEqual(rowColumns(sel(2, 4, 2, 40), 2, "abcdefghij", 10), [4, 10]);
});

test("rowColumns：边界落在宽字符中间时吸附到整个字，不把中文切成半个", () => {
  // 中(0-1) 文(2-3) a(4) b(5)
  assert.deepEqual(rowColumns(sel(0, 1, 0, 3), 0, "中文ab", 10), [0, 4]);
  assert.deepEqual(rowColumns(sel(0, 3, 0, 4), 0, "\x1b[31m中文\x1b[39mab", 10), [2, 5]);
});

test("highlightColumns：只反显给定的列，行里原有的样式码照留，样式码后面补一次反显，行尾收尾码不丢", () => {
  assert.equal(highlightColumns("abcdef", 1, 3), "a\x1b[7mbc\x1b[27mdef");
  assert.equal(highlightColumns("abcdef", 0, 6), "\x1b[7mabcdef\x1b[27m");
  // 段里有 0m 重置，重置之后反显要重新打开
  assert.equal(
    highlightColumns("a\x1b[31mb\x1b[0mc", 0, 3),
    "\x1b[7ma\x1b[31m\x1b[7mb\x1b[0m\x1b[7mc\x1b[27m",
  );
  // 前面的样式带进选中段（带进来的样式码后面也补反显），后面的段也带上前面的样式，行尾的 22m 保留
  assert.equal(
    highlightColumns("\x1b[1mabcd\x1b[22m", 1, 3),
    "\x1b[1ma\x1b[7m\x1b[1m\x1b[7mbc\x1b[27m\x1b[1md\x1b[22m",
  );
  // 选到行尾时收尾码也在
  assert.equal(highlightColumns("\x1b[44mab\x1b[49m", 1, 2), "\x1b[44ma\x1b[7m\x1b[44m\x1b[7mb\x1b[27m\x1b[49m");
  // 超链接序列不动，文字不变
  const link = "\x1b]8;;https://x\x07link\x1b]8;;\x07 tail";
  const out = highlightColumns(link, 0, 4);
  assert.equal(out.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, ""), "link tail");
  assert.ok(out.startsWith("\x1b[7m\x1b]8;;https://x\x07link"));
  assert.ok(out.includes("\x1b]8;;\x07"));
  assert.ok(out.indexOf("\x1b[27m") < out.indexOf(" tail"));
});

test("selectionText：每行去样式、去尾部空白，行间换行，给不出的行算空行", () => {
  const lines = ["\x1b[2mhead\x1b[22m   ", "second line here", "third"];
  const text = selectionText(sel(0, 2, 2, 2), 20, (r) => lines[r]);
  assert.equal(text, "ad\nsecond line here\nthi");
  assert.equal(selectionText(sel(0, 0, 1, 3), 20, () => undefined), "\n");
  assert.equal(selectionText(sel(1, 3, 1, 7), 20, (r) => lines[r]), "ond l");
});

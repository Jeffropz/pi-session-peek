import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { fmtTime, normPath, padEndVisible } from "../src/text.ts";

test("normPath: 反斜杠、尾部斜杠、大小写", () => {
  const bs = String.fromCharCode(92);
  assert.equal(normPath(`D:${bs}A${bs}b${bs}`), "d:/a/b");
  assert.equal(normPath("D:/A/b///"), "d:/a/b");
  assert.equal(normPath("/home/User"), "/home/user");
});

test("fmtTime: 本地时间，今年不带年份", () => {
  const d = new Date();
  d.setMonth(2, 5);
  d.setHours(9, 7, 0, 0);
  assert.equal(fmtTime(d.toISOString()), "03-05 09:07");
});

test("fmtTime: withYear 或不是今年时带年份", () => {
  const d = new Date(2020, 0, 2, 3, 4);
  assert.equal(fmtTime(d.toISOString()), "2020-01-02 03:04");
  const now = new Date();
  now.setMonth(5, 6);
  now.setHours(7, 8, 0, 0);
  assert.equal(fmtTime(now.toISOString(), true), `${now.getFullYear()}-06-06 07:08`);
});

test("fmtTime: 非法输入", () => {
  assert.equal(fmtTime(""), "??-?? ??:??");
  assert.equal(fmtTime("garbage", true), "????-??-?? ??:??");
});

test("padEndVisible: 按显示宽度补齐，中文算两格，ANSI 不算", () => {
  assert.equal(padEndVisible("ab", 4), "ab  ");
  assert.equal(padEndVisible("中文", 6), "中文  ");
  assert.equal(padEndVisible("\x1b[1mab\x1b[22m", 4), "\x1b[1mab\x1b[22m  ");
});

test("padEndVisible: 超宽时按显示宽度截断", () => {
  const out = padEndVisible("abcdefgh", 4);
  assert.equal(visibleWidth(out), 4);
  assert.ok(out.startsWith("a"));
});

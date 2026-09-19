import assert from "node:assert/strict";
import { test } from "node:test";
import { setLang } from "../src/i18n.ts";
import { anyKw, highlight, parseQuery, snippet } from "../src/query.ts";

setLang("zh");

const theme = {
  fg: (_c: string, s: string) => `<${s}>`,
  bg: (_c: string, s: string) => s,
  bold: (s: string) => s,
};

test("parseQuery: 小写、去重、@7d 变成时间下限", () => {
  const q = parseQuery("  Foo  @7d bar foo ");
  assert.deepEqual(q.kws, ["foo", "bar"]);
  assert.ok(Math.abs(Date.now() - q.since - 7 * 86400e3) < 5000);
  assert.equal(q.sinceLabel, "近7天");
});

test("parseQuery: 各时间单位", () => {
  assert.equal(parseQuery("@24h").sinceLabel, "近24小时");
  assert.equal(parseQuery("@2w").sinceLabel, "近2周");
  assert.equal(parseQuery("@1m").sinceLabel, "近1个月");
  assert.ok(parseQuery("@1m").since < parseQuery("@2w").since);
});

test("parseQuery: @0d 不生效，@abc 当普通关键词", () => {
  assert.equal(parseQuery("@0d x").since, 0);
  assert.deepEqual(parseQuery("@0d x").kws, ["x"]);
  assert.deepEqual(parseQuery("@abc").kws, ["@abc"]);
});

test("parseQuery: 空字符串", () => {
  assert.deepEqual(parseQuery(""), { kws: [], since: 0, sinceLabel: "" });
});

test("anyKw: 命中任意一个即可", () => {
  assert.equal(anyKw("hello world", ["zzz", "world"]), true);
  assert.equal(anyKw("hello world", ["zzz"]), false);
  assert.equal(anyKw("hello", []), false);
});

test("highlight: 大小写不敏感，保留原文大小写", () => {
  assert.equal(highlight("xAy", ["a"], theme), "x\x1b[4m<A>\x1b[24my");
});

test("highlight: 同一位置取最长的词，多个词都高亮", () => {
  assert.equal(highlight("abcabc", ["ab", "abc"], theme), "\x1b[4m<abc>\x1b[24m\x1b[4m<abc>\x1b[24m");
  assert.equal(highlight("foo bar", ["bar", "foo"], theme), "\x1b[4m<foo>\x1b[24m \x1b[4m<bar>\x1b[24m");
});

test("highlight: 没有关键词原样返回", () => {
  assert.equal(highlight("plain", [], theme), "plain");
});

test("snippet: 命中前后截取，被截掉的前文用省略号标出", () => {
  const msgs = [{ role: "user" as const, text: "x".repeat(100) + "\n\nNEEDLE here " + "y".repeat(50) }];
  const s = snippet(msgs, ["needle"], 30)!;
  assert.ok(s.startsWith("…"));
  assert.ok(s.toLowerCase().includes("needle"));
  assert.ok(s.length <= 31);
  assert.ok(!s.includes("\n"));
});

test("snippet: 命中在开头就不加省略号", () => {
  assert.equal(snippet([{ role: "user", text: "needle first" }], ["needle"], 30), "needle first");
});

test("snippet: 取第一条命中的消息", () => {
  const msgs = [
    { role: "user" as const, text: "nothing here" },
    { role: "assistant" as const, text: "second has needle" },
  ];
  assert.equal(snippet(msgs, ["needle"], 40), "second has needle");
});

test("snippet: 没有消息命中返回 undefined", () => {
  assert.equal(snippet([{ role: "user", text: "nothing" }], ["zzz"], 30), undefined);
  assert.equal(snippet([{ role: "user", text: "nothing" }], [], 30), undefined);
});

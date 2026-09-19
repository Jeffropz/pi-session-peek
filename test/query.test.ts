import assert from "node:assert/strict";
import { test } from "node:test";
import { setLang } from "../src/i18n.ts";
import { anyKw, highlight, parseQuery, snippet } from "../src/query.ts";

setLang("zh");

// 和真实主题一样：颜色是 "前缀 + 文本 + 39m"，高亮只取前缀
const theme = {
  fg: (_c: string, s: string) => `\x1b[33m${s}\x1b[39m`,
  bg: (_c: string, s: string) => s,
  bold: (s: string) => s,
};
const ON = "\x1b[1m\x1b[4m\x1b[33m";
const OFF = "\x1b[24m\x1b[22m\x1b[39m"; // 外面没有样式时：下划线、粗体、前景色全关

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
  assert.equal(highlight("xAy", ["a"], theme), `x${ON}A${OFF}y`);
});

test("highlight: 同一位置取最长的词，多个词都高亮", () => {
  assert.equal(highlight("abcabc", ["ab", "abc"], theme), `${ON}abc${OFF}${ON}abc${OFF}`);
  assert.equal(highlight("foo bar", ["bar", "foo"], theme), `${ON}foo${OFF} ${ON}bar${OFF}`);
});

test("highlight: 没有关键词或没有命中时原样返回", () => {
  assert.equal(highlight("plain", [], theme), "plain");
  assert.equal(highlight("\x1b[31mplain\x1b[39m", ["zzz"], theme), "\x1b[31mplain\x1b[39m");
});

test("highlight: 转义序列不参与匹配，命中可以跨过它", () => {
  // 关键词在 ANSI 两侧各一半：序列原样保留，之后把高亮补回来
  assert.equal(highlight("a\x1b[1mb", ["ab"], theme), `${ON}a\x1b[1m${ON}b\x1b[24m\x1b[39m`);
  assert.equal(highlight("get\x1b[39mHttp", ["gethttp"], theme), `${ON}get\x1b[39m${ON}Http${OFF}`);
});

test("highlight: 结束时恢复外层的前景色 / 粗体 / 下划线", () => {
  assert.equal(highlight("\x1b[31mfoo bar\x1b[39m", ["bar"], theme), `\x1b[31mfoo ${ON}bar\x1b[24m\x1b[22m\x1b[31m\x1b[39m`);
  assert.equal(
    highlight("\x1b[38;2;1;2;3mfoo\x1b[39m", ["foo"], theme),
    `\x1b[38;2;1;2;3m${ON}foo\x1b[24m\x1b[22m\x1b[38;2;1;2;3m\x1b[39m`,
  );
  assert.equal(highlight("\x1b[1m\x1b[4mfoo\x1b[24m\x1b[22m", ["foo"], theme), `\x1b[1m\x1b[4m${ON}foo\x1b[39m\x1b[24m\x1b[22m`);
  // 背景色的参数不能被当成前景色
  assert.equal(highlight("\x1b[48;2;9;9;9mfoo\x1b[49m", ["foo"], theme), `\x1b[48;2;9;9;9m${ON}foo${OFF}\x1b[49m`);
});

test("highlight: OSC 超链接里的文字能命中，序列本身不动", () => {
  const open = "\x1b]8;;https://x.y\x1b\\";
  const close = "\x1b]8;;\x1b\\";
  assert.equal(highlight(`${open}doc${close}`, ["doc"], theme), `${open}${ON}doc${OFF}${close}`);
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

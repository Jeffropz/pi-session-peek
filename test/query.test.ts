import assert from "node:assert/strict";
import { test } from "node:test";
import { setLang } from "../src/i18n.ts";
import { anyMatch, highlight, lineHasMatch, matchesSession, parseQuery, roleTerms, snippet, type Term } from "../src/query.ts";
import type { PeekSession } from "../src/sessions.ts";

setLang("zh");

// 和真实主题一样：颜色是 "前缀 + 文本 + 39m"，高亮只取前缀
const theme = {
  fg: (_c: string, s: string) => `\x1b[33m${s}\x1b[39m`,
  bg: (_c: string, s: string) => s,
  bold: (s: string) => s,
};
const ON = "\x1b[1m\x1b[4m\x1b[33m";
const OFF = "\x1b[24m\x1b[22m\x1b[39m"; // 外面没有样式时：下划线、粗体、前景色全关

const terms = (q: string): Term[] => parseQuery(q).terms;
// 词的形状：-name:foo 这种紧凑写法，方便断言
const shape = (q: string) => terms(q).map((t) => `${t.negate ? "-" : ""}${t.field === "any" ? "" : t.field + ":"}${t.re.source}`);

function sess(texts: string[], name = "", cwd = "D:/proj"): PeekSession {
  return {
    path: "p", cwd, time: "", name, first: texts[0] ?? "", mtime: 0,
    msgs: texts.map((text, i) => ({ role: i % 2 ? "assistant" : "user", text })),
  };
}

test("matchesSession: 不区分大小写，每个词都要命中，名字和 cwd 也算", () => {
  const s = sess(["Hello World", "second Reply"], "My Name");
  assert.ok(matchesSession(s, terms("hello reply"))); // 分散在两条消息里也行
  assert.ok(matchesSession(s, terms('"my name"')));
  assert.ok(matchesSession(s, terms("d:/proj")));
  assert.ok(!matchesSession(s, terms("hello missing")));
  assert.ok(!matchesSession(sess([]), terms("x")));
});

test("普通词：正则元字符按字面匹配", () => {
  const s = sess(["call foo(bar) then a.b[0] and c++ $x"]);
  for (const kw of ["foo(bar)", "a.b[0]", "c++", "$x", '"(bar) then"']) assert.ok(matchesSession(s, terms(kw)), kw);
  assert.ok(!matchesSession(s, terms("a.b[1]")));
  assert.ok(!matchesSession(sess(["axb"]), terms("a.b"))); // . 不是通配
});

test("parseQuery: 小写、去重、@7d 变成时间下限", () => {
  const q = parseQuery("  Foo  @7d bar foo ");
  assert.deepEqual(q.terms.map((t) => t.re.source), ["foo", "bar"]);
  assert.ok(q.terms.every((t) => t.re.flags.includes("i")));
  assert.ok(Math.abs(Date.now() - q.since - 7 * 86400e3) < 5000);
  assert.equal(q.sinceLabel, "近7天");
});

test("parseQuery: 各时间单位，大小写不限", () => {
  assert.equal(parseQuery("@24h").sinceLabel, "近24小时");
  assert.equal(parseQuery("@2w").sinceLabel, "近2周");
  assert.equal(parseQuery("@1m").sinceLabel, "近1个月");
  assert.equal(parseQuery("@1M").sinceLabel, "近1个月");
  assert.ok(parseQuery("@1m").since < parseQuery("@2w").since);
});

test("parseQuery: @0d 不生效，@abc 当普通关键词", () => {
  assert.equal(parseQuery("@0d x").since, 0);
  assert.deepEqual(shape("@0d x"), ["x"]);
  assert.deepEqual(shape("@abc"), ["@abc"]);
});

test("parseQuery: 空字符串", () => {
  assert.deepEqual(parseQuery(""), { terms: [], since: 0, sinceLabel: "" });
  assert.deepEqual(parseQuery("   ").terms, []);
});

test('短语："foo bar" 当一个词，引号里的空白匹配正文里任意空白', () => {
  assert.deepEqual(shape('"foo bar"'), ["foo\\s+bar"]);
  const s = sess(["foo\n  bar", "bar foo"]);
  assert.ok(matchesSession(s, terms('"foo bar"')));
  assert.ok(!matchesSession(s, terms('"bar  foo x"')));
  // 没有引号时 foo bar 是两个词，顺序无关
  assert.ok(matchesSession(sess(["bar then foo"]), terms("foo bar")));
  assert.ok(!matchesSession(sess(["bar then foo"]), terms('"foo bar"')));
});

test("短语：引号不闭合就到结尾，空引号忽略，引号里的特殊字符都按字面", () => {
  assert.deepEqual(shape('"foo bar'), ["foo\\s+bar"]);
  assert.deepEqual(shape('a "" b'), ["a", "b"]);
  assert.deepEqual(shape('" "'), []);
  assert.deepEqual(shape('"-foo" "a|b" "name:x" "/x/"'), ["-foo", "a\\|b", "name:x", "\\/x\\/"]);
  assert.ok(matchesSession(sess(["say a|b"]), terms('"a|b"')));
  assert.ok(!matchesSession(sess(["say a"]), terms('"a|b"')));
  // 引号只在词首算
  assert.deepEqual(shape('foo"bar'), ['foo"bar']);
});

test("OR：a|b 任一命中；空的分支忽略；高亮取同一位置最长的分支", () => {
  assert.ok(matchesSession(sess(["only beta"]), terms("alpha|beta")));
  assert.ok(matchesSession(sess(["only alpha"]), terms("alpha|beta")));
  assert.ok(!matchesSession(sess(["gamma"]), terms("alpha|beta")));
  assert.deepEqual(shape("a||b |c|"), ["a|b", "c"]);
  assert.deepEqual(shape("|"), []);
  assert.equal(highlight("abc", ["ab|abc"].flatMap(terms), theme), `${ON}abc${OFF}`);
  // 和其他词组合仍是 AND
  assert.ok(matchesSession(sess(["alpha x"]), terms("alpha|beta x")));
  assert.ok(!matchesSession(sess(["alpha"]), terms("alpha|beta x")));
});

test("排除：-foo 命中的会话不显示；-- 开头和单个 - 是普通词", () => {
  const a = sess(["alpha only"]);
  const b = sess(["alpha and beta"]);
  assert.ok(matchesSession(a, terms("alpha -beta")));
  assert.ok(!matchesSession(b, terms("alpha -beta")));
  // 排除词也看名字和目录
  assert.ok(!matchesSession(sess(["x"], "beta"), terms("-beta")));
  assert.ok(!matchesSession(sess(["x"], "", "D:/beta"), terms("-beta")));
  // 只有排除词时，没命中的会话全部保留
  assert.ok(matchesSession(a, terms("-beta")));
  assert.deepEqual(shape("--foo -"), ["--foo", "-"]);
  assert.ok(matchesSession(sess(["a --foo b"]), terms("--foo")));
  assert.deepEqual(shape("-"), ["-"]);
});

test("字段：name: / cwd: / dir: / user: / ai: / assistant: 只看对应的地方，大小写不限", () => {
  const s = sess(["ask about tea", "coffee is better"], "tea-session", "D:/work/kitchen");
  assert.deepEqual(shape("name:x cwd:y dir:z user:u ai:a assistant:b"), ["name:x", "cwd:y", "cwd:z", "user:u", "assistant:a", "assistant:b"]);
  assert.deepEqual(shape("NAME:x"), ["name:x"]);
  assert.ok(matchesSession(s, terms("name:tea")));
  assert.ok(!matchesSession(s, terms("name:coffee")));
  assert.ok(matchesSession(s, terms("dir:kitchen")));
  assert.ok(matchesSession(s, terms("cwd:kitchen")));
  assert.ok(!matchesSession(s, terms("cwd:tea")));
  assert.ok(matchesSession(s, terms("user:tea")));
  assert.ok(!matchesSession(s, terms("user:coffee")));
  assert.ok(matchesSession(s, terms("ai:coffee")));
  assert.ok(!matchesSession(s, terms("ai:tea"))); // 名字里的 tea 不算
  // 只剩前缀的词忽略；不认识的前缀是普通词
  assert.deepEqual(shape("name: foo:bar"), ["foo:bar"]);
  assert.ok(matchesSession(sess(["see foo:bar"]), terms("foo:bar")));
});

test("前缀可以叠：-user:foo、name:\"a b\"、-name:/re/", () => {
  assert.deepEqual(shape('-user:"foo bar" name:"a b" -name:/x+/'), ["-user:foo\\s+bar", "name:a\\s+b", "-name:x+"]);
  const s = sess(["foo bar", "foo bar"], "x");
  assert.ok(!matchesSession(s, terms('-user:"foo bar"')));
  assert.ok(matchesSession(sess(["nothing", "foo bar"]), terms('-user:"foo bar"')));
  assert.ok(!matchesSession(s, terms("-name:/x+/")));
});

test("正则：/re/ 按 JS 正则匹配，自动带 i 和 m；写错了退回普通文字；/ 和 // 是普通词", () => {
  assert.deepEqual(shape("/fo+/"), ["fo+"]);
  assert.ok(terms("/fo+/")[0].re.flags.includes("m"));
  const s = sess(["Foooo", "line one\nstart of line two"]);
  assert.ok(matchesSession(s, terms("/fo+/")));
  assert.ok(matchesSession(s, terms("/^start/"))); // m 标志：^ 能对上行首
  assert.ok(!matchesSession(s, terms("/^tart/")));
  assert.ok(matchesSession(s, terms("/fo{2}\\S/")));
  // 非法正则：按字面搜，不抛
  assert.deepEqual(shape("/fo(/"), ["\\/fo\\(\\/"]);
  assert.ok(matchesSession(sess(["path /fo(/ here"]), terms("/fo(/")));
  assert.deepEqual(shape("/ // a/b"), ["\\/", "\\/\\/", "a\\/b"]);
  assert.ok(matchesSession(sess(["a/b"]), terms("a/b")));
});

test("正则：空匹配不算命中，也不会让高亮死循环", () => {
  assert.ok(!matchesSession(sess(["zzz"]), terms("/x*/")));
  assert.ok(matchesSession(sess(["zzxx"]), terms("/x*/"))); // 前面几个位置是空匹配，往后找到 xx
  assert.ok(!anyMatch("zzz", terms("/x*/")));
  assert.equal(highlight("aaa", terms("/x*/"), theme), "aaa");
  assert.equal(highlight("baab", terms("/a*/"), theme), `b${ON}aa${OFF}b`);
  assert.equal(snippet([{ role: "user", text: "zzz" }], roleTerms(terms("/x*/")), 30), undefined);
});

test("同一个词重复出现只算一次；排除和正向、不同字段的同一个词不合并；正则保留大小写", () => {
  assert.deepEqual(shape("a a A"), ["a"]);
  assert.deepEqual(shape("a -a name:a"), ["a", "-a", "name:a"]);
  assert.deepEqual(shape("/\\S/ /\\s/"), ["\\S", "\\s"]); // \S 和 \s 不是同一个词
});

test("anyMatch: 命中任意一个词即可", () => {
  assert.equal(anyMatch("hello world", terms("zzz world")), true);
  assert.equal(anyMatch("hello world", terms("zzz")), false);
  assert.equal(anyMatch("hello", []), false);
  // 复用同一个词多次也稳定（g 标志的 lastIndex 有归零）
  const t = terms("world");
  assert.equal(anyMatch("hello world", t), true);
  assert.equal(anyMatch("hello world", t), true);
  assert.equal(anyMatch("world", t), true);
});

test("roleTerms: 排除词、name: / cwd: 不进正文高亮，user: / ai: 只给对应角色", () => {
  const rt = roleTerms(terms("a -b name:c cwd:d user:e ai:f"));
  assert.deepEqual(rt.user.map((t) => t.re.source), ["a", "e"]);
  assert.deepEqual(rt.assistant.map((t) => t.re.source), ["a", "f"]);
});

test("lineHasMatch: 忽略 ANSI，按可见文本判断", () => {
  assert.ok(lineHasMatch("x \x1b[31mfoo\x1b[39m y", terms("foo")));
  assert.ok(!lineHasMatch("x \x1b[31mfoo\x1b[39m y", terms("31m")));
  assert.ok(!lineHasMatch("foo", []));
});

test("highlight: 大小写不敏感，保留原文大小写", () => {
  assert.equal(highlight("xAy", terms("a"), theme), `x${ON}A${OFF}y`);
  assert.equal(highlight("xay", terms("A"), theme), `x${ON}a${OFF}y`);
});

test("highlight: 同一位置取最长的词，多个词都高亮", () => {
  assert.equal(highlight("abcabc", terms("ab abc"), theme), `${ON}abc${OFF}${ON}abc${OFF}`);
  assert.equal(highlight("foo bar", terms("bar foo"), theme), `${ON}foo${OFF} ${ON}bar${OFF}`);
});

test("highlight: 短语和正则整段高亮", () => {
  assert.equal(highlight("say foo  bar now", terms('"foo bar"'), theme), `say ${ON}foo  bar${OFF} now`);
  assert.equal(highlight("x fooo y", terms("/fo+/"), theme), `x ${ON}fooo${OFF} y`);
});

test("highlight: 小写后长度会变的字符也能高亮，位置不错位", () => {
  // İ (U+0130) 小写后变成两个码元，以前会整行放弃高亮
  assert.equal(highlight("İstanbul foo", terms("foo"), theme), `İstanbul ${ON}foo${OFF}`);
});

test("highlight: 没有关键词或没有命中时原样返回", () => {
  assert.equal(highlight("plain", [], theme), "plain");
  assert.equal(highlight("\x1b[31mplain\x1b[39m", terms("zzz"), theme), "\x1b[31mplain\x1b[39m");
});

test("highlight: 转义序列不参与匹配，命中可以跨过它", () => {
  // 关键词在 ANSI 两侧各一半：序列原样保留，之后把高亮补回来
  assert.equal(highlight("a\x1b[1mb", terms("ab"), theme), `${ON}a\x1b[1m${ON}b\x1b[24m\x1b[39m`);
  assert.equal(highlight("get\x1b[39mHttp", terms("gethttp"), theme), `${ON}get\x1b[39m${ON}Http${OFF}`);
});

test("highlight: 结束时恢复外层的前景色 / 粗体 / 下划线", () => {
  assert.equal(highlight("\x1b[31mfoo bar\x1b[39m", terms("bar"), theme), `\x1b[31mfoo ${ON}bar\x1b[24m\x1b[22m\x1b[31m\x1b[39m`);
  assert.equal(
    highlight("\x1b[38;2;1;2;3mfoo\x1b[39m", terms("foo"), theme),
    `\x1b[38;2;1;2;3m${ON}foo\x1b[24m\x1b[22m\x1b[38;2;1;2;3m\x1b[39m`,
  );
  assert.equal(highlight("\x1b[1m\x1b[4mfoo\x1b[24m\x1b[22m", terms("foo"), theme), `\x1b[1m\x1b[4m${ON}foo\x1b[39m\x1b[24m\x1b[22m`);
  // 背景色的参数不能被当成前景色
  assert.equal(highlight("\x1b[48;2;9;9;9mfoo\x1b[49m", terms("foo"), theme), `\x1b[48;2;9;9;9m${ON}foo${OFF}\x1b[49m`);
});

test("highlight: OSC 超链接里的文字能命中，序列本身不动", () => {
  const open = "\x1b]8;;https://x.y\x1b\\";
  const close = "\x1b]8;;\x1b\\";
  assert.equal(highlight(`${open}doc${close}`, terms("doc"), theme), `${open}${ON}doc${OFF}${close}`);
});

test("snippet: 命中前后截取，被截掉的前文用省略号标出", () => {
  const msgs = [{ role: "user" as const, text: "x".repeat(100) + "\n\nNEEDLE here " + "y".repeat(50) }];
  const s = snippet(msgs, roleTerms(terms("needle")), 30)!;
  assert.equal(s.role, "user");
  assert.ok(s.text.startsWith("…"));
  assert.ok(s.text.toLowerCase().includes("needle"));
  assert.ok(s.text.length <= 31);
  assert.ok(!s.text.includes("\n"));
});

test("snippet: 命中在开头就不加省略号", () => {
  assert.deepEqual(snippet([{ role: "user", text: "needle first" }], roleTerms(terms("needle")), 30), { text: "needle first", role: "user" });
});

test("snippet: 取第一条命中的消息，user: / ai: 只看对应角色", () => {
  const msgs = [
    { role: "user" as const, text: "nothing here" },
    { role: "assistant" as const, text: "second has needle" },
    { role: "user" as const, text: "third has needle too" },
  ];
  assert.deepEqual(snippet(msgs, roleTerms(terms("needle")), 40), { text: "second has needle", role: "assistant" });
  assert.deepEqual(snippet(msgs, roleTerms(terms("user:needle")), 40), { text: "third has needle too", role: "user" });
  assert.equal(snippet(msgs, roleTerms(terms("ai:nothing")), 40), undefined);
});

test("snippet: 没有消息命中返回 undefined；排除词和 name: 不产生片段", () => {
  assert.equal(snippet([{ role: "user", text: "nothing" }], roleTerms(terms("zzz")), 30), undefined);
  assert.equal(snippet([{ role: "user", text: "nothing" }], roleTerms([]), 30), undefined);
  assert.equal(snippet([{ role: "user", text: "nothing" }], roleTerms(terms("-zzz name:nothing")), 30), undefined);
});

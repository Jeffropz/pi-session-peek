import assert from "node:assert/strict";
import { test } from "node:test";
import { detectLang, getLang, messages, msg, setLang } from "../src/i18n.ts";
import { PeekComponent } from "../src/peek-component.ts";
import { parseQuery } from "../src/query.ts";

const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
const strip = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "");

test("中英文的键和占位符一一对应", () => {
  const zhKeys = Object.keys(messages.zh).sort();
  const enKeys = Object.keys(messages.en).sort();
  assert.deepEqual(enKeys, zhKeys);
  for (const k of zhKeys) {
    const holes = (s: string) => (s.match(/\{[a-z]+\}/g) ?? []).sort();
    assert.deepEqual(holes((messages.en as any)[k]), holes((messages.zh as any)[k]), k);
  }
});

test("detectLang: PI_SESSION_PEEK_LANG 优先", () => {
  const sys = () => "zh-CN";
  assert.equal(detectLang({ PI_SESSION_PEEK_LANG: "en", LANG: "zh_CN.UTF-8" }, sys), "en");
  assert.equal(detectLang({ PI_SESSION_PEEK_LANG: "zh-TW" }, () => "en-US"), "zh");
  assert.equal(detectLang({ PI_SESSION_PEEK_LANG: "EN_us" }, sys), "en");
  assert.equal(detectLang({ PI_SESSION_PEEK_LANG: "xx" }, sys), "zh");
});

test("detectLang: LC_ALL > LC_MESSAGES > LANG，C / POSIX 跳过", () => {
  const sys = () => "zh-CN";
  assert.equal(detectLang({ LC_ALL: "en_US.UTF-8", LANG: "zh_CN.UTF-8" }, sys), "en");
  assert.equal(detectLang({ LC_MESSAGES: "zh_CN", LANG: "en_US" }, sys), "zh");
  assert.equal(detectLang({ LANG: "zh_CN.UTF-8" }, () => "en-US"), "zh");
  assert.equal(detectLang({ LANG: "C" }, sys), "zh");
  assert.equal(detectLang({ LC_ALL: "POSIX" }, () => "en-US"), "en");
  assert.equal(detectLang({ LANG: "de_DE.UTF-8" }, sys), "en");
});

test("detectLang: 都没设时看系统区域，认不出来用英文", () => {
  assert.equal(detectLang({}, () => "zh-CN"), "zh");
  assert.equal(detectLang({}, () => "zh-Hant-TW"), "zh");
  assert.equal(detectLang({}, () => "en-US"), "en");
  assert.equal(detectLang({}, () => "ja-JP"), "en");
  assert.equal(detectLang({}, () => { throw new Error("no intl"); }), "en");
});

test("msg: 插值和语言切换", () => {
  const prev = getLang();
  try {
    setLang("zh");
    assert.equal(msg("matchCount", { n: 3, total: 10 }), "  匹配 3/10");
    assert.equal(msg("deleted", { file: "a.jsonl" }), "已删除会话 a.jsonl");
    setLang("en");
    assert.equal(msg("matchCount", { n: 3, total: 10 }), "  3/10 matched");
    assert.equal(msg("deleted", { file: "a.jsonl" }), "Deleted session a.jsonl");
    assert.equal(msg("noMatch"), "No matching sessions");
  } finally {
    setLang(prev);
  }
});

test("英文界面：头部、时间标签、底部提示、预览标签都换成英文", () => {
  const prev = getLang();
  try {
    setLang("en");
    assert.equal(parseQuery("@7d").sinceLabel, "last 7d");
    assert.equal(parseQuery("@24h").sinceLabel, "last 24h");
    assert.equal(parseQuery("@1m").sinceLabel, "last 1mo");
    const s = {
      path: "p", cwd: "D:/x", time: new Date().toISOString(), name: "", first: "hello",
      msgs: [{ role: "user" as const, text: "hello" }, { role: "assistant" as const, text: "world" }],
      searchText: "hello world d:/x", mtime: Date.now(),
    };
    const c: any = new PeekComponent([s], "D:/x", theme, 40, "hello @7d");
    const lines = c.render(120).map(strip);
    assert.ok(lines[0].includes("Session search"));
    assert.ok(lines[0].includes("current dir tree"));
    assert.ok(lines[0].includes("last 7d"));
    assert.ok(lines[0].includes("1/1 matched"));
    assert.ok(lines.some((l: string) => l.includes("👤 You")));
    assert.ok(lines.some((l: string) => l.includes("2 messages")));
    assert.ok(lines.at(-1).includes("Enter open"));
    c.onDelete = async () => true;
    c.handleInput("\x04");
    assert.ok(strip(c.render(120).at(-1)).includes("Delete session"));
  } finally {
    setLang(prev);
  }
});

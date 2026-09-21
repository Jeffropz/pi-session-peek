import assert from "node:assert/strict";
import { test } from "node:test";
import { ANSI_SEQ_RE, ANSI_TAIL_RE, applySgr, isSgr, sanitizeText, splitAnsi, type SgrStyle } from "../src/ansi.ts";

// 序列分词和净化的基本性质。高亮 / 反显 / 解析各自的行为在 query / selection / sessions 的测试里

test("splitAnsi：可见文字和序列交替，拼回去是原样；纯文本只有一段", () => {
  const line = "a\x1b[31mred\x1b[0m \x1b]8;;http://u\x07link\x1b]8;;\x07 z";
  const segs = splitAnsi(line);
  assert.equal(segs.map((s) => s.text).join(""), line);
  assert.deepEqual(segs.map((s) => (s.esc ? "E" : "T")).join(""), "TETETETET");
  assert.deepEqual(splitAnsi("plain"), [{ text: "plain", esc: false }]);
  assert.deepEqual(splitAnsi(""), []);
});

test("isSgr：只有 CSI … m 算样式码", () => {
  assert.ok(isSgr("\x1b[1;31m"));
  assert.ok(!isSgr("\x1b[2J"));
  assert.ok(!isSgr("\x1b]8;;x\x07"));
});

test("ANSI_TAIL_RE：只取行尾连续的序列", () => {
  assert.equal(ANSI_TAIL_RE.exec("ab\x1b[39m\x1b[49m")?.[0], "\x1b[39m\x1b[49m");
  assert.equal(ANSI_TAIL_RE.exec("\x1b[1mab"), null);
});

test("applySgr：0 重置，1/2/22 粗体暗淡，4/24 下划线，30-37/90-97/38;5/38;2 前景色，48 只跳过参数", () => {
  const st: SgrStyle = { fg: "", bold: false, dim: false, underline: false };
  applySgr(st, "\x1b[1;4;31m");
  assert.deepEqual(st, { fg: "\x1b[31m", bold: true, dim: false, underline: true });
  applySgr(st, "\x1b[38;2;1;2;3;48;5;7m");
  assert.equal(st.fg, "\x1b[38;2;1;2;3m");
  applySgr(st, "\x1b[22;24;39m");
  assert.deepEqual(st, { fg: "", bold: false, dim: false, underline: false });
  applySgr(st, "\x1b[2m");
  applySgr(st, "\x1b[m"); // 空参数等于 0
  assert.equal(st.dim, false);
  applySgr(st, "\x1b[2J"); // 不是 SGR，不动
  assert.deepEqual(st, { fg: "", bold: false, dim: false, underline: false });
});

test("不变量：ANSI_SEQ_RE 能匹配的序列 sanitizeText 全都去掉", () => {
  const samples = ["\x1b[1;31m", "\x1b[?25l", "\x1b[<0;3;12M", "\x1b]8;;http://u\x07", "\x1b]52;c;aGk=\x1b\\", "\x1b_Gx\x1b\\"];
  for (const s of samples) {
    assert.deepEqual((`a${s}b`).match(ANSI_SEQ_RE), [s], `SEQ matches ${JSON.stringify(s)}`);
    assert.equal(sanitizeText(`a${s}b`), "ab", `sanitize strips ${JSON.stringify(s)}`);
  }
});

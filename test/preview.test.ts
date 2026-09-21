import assert from "node:assert/strict";
import { test } from "node:test";
import { setLang } from "../src/i18n.ts";
import { buildPreview, initialOffset, nextMatchTarget, type RenderCache } from "../src/preview.ts";
import { parseQuery, roleTerms } from "../src/query.ts";
import type { PeekSession } from "../src/sessions.ts";
import { mdTheme, strip, theme } from "./helpers.ts";

setLang("zh");

// 右栏的纯函数。高亮、工具行、截断提示这些在组件里的整体效果见 peek-component.test.ts

function sess(texts: string[], name = ""): PeekSession {
  return { path: "p", cwd: "D:/proj", time: "", name, first: texts[0] ?? "", mtime: 0, size: 0, msgs: texts.map((text, i) => ({ role: i % 2 ? "assistant" : "user", text })) };
}

const rt = (q: string) => roleTerms(parseQuery(q).terms);

test("nextMatchTarget：跳视口外的下一个 / 上一个命中，到头回绕，没有命中是 undefined", () => {
  const m = [2, 3, 4, 40];
  assert.equal(nextMatchTarget(m, 0, 10, 1), 40); // 同屏的 2、3、4 算一处，直接到 40
  assert.equal(nextMatchTarget(m, 38, 48, 1), 2); // 回绕
  assert.equal(nextMatchTarget(m, 38, 48, -1), 4);
  assert.equal(nextMatchTarget(m, 0, 10, -1), 40); // 往上回绕到最后一个
  assert.equal(nextMatchTarget([], 0, 10, 1), undefined);
});

test("initialOffset：有命中停在首个命中上面两行，没有就到底；短内容是 0", () => {
  assert.equal(initialOffset({ lines: new Array(100).fill(""), matchLines: [30] }, 28), 28);
  assert.equal(initialOffset({ lines: new Array(100).fill(""), matchLines: [1] }, 28), 0);
  assert.equal(initialOffset({ lines: new Array(100).fill(""), matchLines: [] }, 28), 72);
  assert.equal(initialOffset({ lines: ["x"], matchLines: [] }, 28), 0);
});

test("buildPreview：没有会话只有一行提示；有会话时头一行是目录 + 消息数 + 名字，每条消息一个标签", () => {
  const cache: RenderCache = new WeakMap();
  const none = buildPreview(undefined, rt(""), 60, false, theme, mdTheme, cache);
  assert.deepEqual(none, { lines: ["没有匹配的会话"], matchLines: [] });

  const p = buildPreview(sess(["ask", "answer"], "nm"), rt(""), 60, false, theme, mdTheme, cache);
  const lines = p.lines.map(strip);
  assert.equal(lines[0], "D:/proj • 2 条消息 • nm");
  assert.ok(lines.some((l) => l.startsWith("👤 你")));
  assert.ok(lines.some((l) => l.startsWith("🤖 AI")));
  assert.deepEqual(p.matchLines, []);
});

test("buildPreview：关键词按角色记命中行，渲染结果按（消息, 宽度）进缓存", () => {
  const cache: RenderCache = new WeakMap();
  const s = sess(["alpha asks", "alpha answers"]);
  const p = buildPreview(s, rt("ai:alpha"), 60, false, theme, mdTheme, cache);
  assert.equal(p.matchLines.length, 1);
  assert.ok(strip(p.lines[p.matchLines[0]]).includes("alpha answers"));
  assert.ok(cache.has(s.msgs[0]) && cache.has(s.msgs[1]));
  const first = cache.get(s.msgs[1])!.lines;
  buildPreview(s, rt("alpha"), 60, false, theme, mdTheme, cache);
  assert.equal(cache.get(s.msgs[1])!.lines, first, "same width reuses the rendered lines");
  buildPreview(s, rt("alpha"), 70, false, theme, mdTheme, cache);
  assert.notEqual(cache.get(s.msgs[1])!.lines, first, "another width re-renders");
});

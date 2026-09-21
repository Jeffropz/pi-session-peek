import assert from "node:assert/strict";
import { test } from "node:test";
import { DragSelect, type DragHost } from "../src/drag-select.ts";

// 拖选状态机本身。和组件、渲染合在一起的效果（反显位置、复制的文字）在 peek-component.test.ts 里

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function host(previewLength = 100) {
  const state = { lw: 40, rw: 60, H: 10, listOffset: 0, previewOffset: 20, changed: 0 };
  const h: DragHost & { state: typeof state } = {
    state,
    geometry: () => ({ lw: state.lw, rw: state.rw, H: state.H, listOffset: state.listOffset, previewOffset: state.previewOffset }),
    previewLength: () => previewLength,
    setPreviewOffset: (n) => void (state.previewOffset = n),
    changed: () => void state.changed++,
  };
  return h;
}

test("cellAt：行是栏内容的绝对行号并夹在主体内，列夹在栏内；右栏的列从分隔线后算", () => {
  const d = new DragSelect(host());
  assert.deepEqual(d.cellAt("list", 5, 3), { row: 3, col: 5 });
  assert.deepEqual(d.cellAt("list", 99, 99), { row: 9, col: 39 });
  assert.deepEqual(d.cellAt("list", -4, -4), { row: 0, col: 0 });
  assert.deepEqual(d.cellAt("preview", 40 + 3 + 7, 2), { row: 22, col: 7 });
  assert.deepEqual(d.cellAt("preview", 0, 2), { row: 22, col: 0 }); // 拖到左栏也只选右栏的字
});

test("begin → move → release：拖过才是选区；只按不拖是单击，松开后选区作废；没按下的松开不算", () => {
  const d = new DragSelect(host());
  assert.equal(d.release(), false);
  d.begin("preview", 45, 2);
  assert.equal(d.active(), undefined, "not moved yet");
  assert.equal(d.move(45, 2), false, "same cell");
  assert.equal(d.move(50, 4), true);
  assert.deepEqual(d.active(), { pane: "preview", anchor: { row: 22, col: 2 }, focus: { row: 24, col: 7 } });
  assert.equal(d.release(), true);
  assert.ok(d.active(), "selection survives release");
  d.clear();
  assert.equal(d.sel, undefined);

  d.begin("list", 3, 1);
  assert.equal(d.release(), true);
  assert.equal(d.sel, undefined, "click leaves no selection");
});

test("autoScroll：每 tick 滚一行、写回 host、焦点跟到边缘行；到底或松开就停，定时器清掉", async () => {
  const h = host(40); // maxOff = 30
  const d = new DragSelect(h);
  d.begin("preview", 45, 5);
  d.autoScroll(1);
  assert.ok(d.autoScrollTimer);
  await tick(130);
  assert.ok(h.state.previewOffset > 20, "scrolled down");
  assert.equal(d.sel!.focus.row, h.state.previewOffset + h.state.H - 1, "focus on the last visible row");
  assert.ok(h.state.changed > 0);
  assert.equal(d.active() !== undefined, true, "auto-scroll counts as moving");
  d.release();
  assert.equal(d.autoScrollTimer, undefined);
  const stopped = h.state.previewOffset;
  await tick(80);
  assert.equal(h.state.previewOffset, stopped);

  // 已经在底部：第一个 tick 就停
  h.state.previewOffset = 30;
  d.begin("preview", 45, 5);
  d.autoScroll(1);
  await tick(80);
  assert.equal(d.autoScrollTimer, undefined);
  assert.equal(h.state.previewOffset, 30);
  d.autoScroll(0);
  d.dispose();
});

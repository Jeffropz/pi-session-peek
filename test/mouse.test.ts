import assert from "node:assert/strict";
import { test } from "node:test";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { attachMouse, DETACH_GRACE_MS, type MouseHost, type MouseTarget } from "../src/mouse.ts";

// 常规模式的鼠标桥接：开关鼠标上报、用光标位置查询算组件顶行、把 SGR 序列换算成组件内坐标

const ENABLE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const DISABLE = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";
const CPR_QUERY = "\x1b[6n";

const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));
const grace = () => tick(DETACH_GRACE_MS + 30);

function host(mode = "regular") {
  const written: string[] = [];
  const listeners = new Set<(data: string) => any>();
  let renders = 0;
  const h: MouseHost & { written: string[]; feed(data: string): any; renders(): number; listeners(): number } = {
    mode,
    terminal: {
      write: (d) => void written.push(d),
      columns: 120,
      rows: 40,
    },
    addInputListener(l) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    requestRender: () => void renders++,
    written,
    feed(data) {
      let out: any;
      for (const l of listeners) out = l(data);
      return out;
    },
    renders: () => renders,
    listeners: () => listeners.size,
  };
  return h;
}

// result 传 null 表示组件不处理（handleMouse 返回 undefined）
function target(row: number | undefined = 1, result: TuiMouseEventResult | null = { handled: true }) {
  const events: TuiMouseEvent[] = [];
  const t: MouseTarget & { events: TuiMouseEvent[]; row: number | undefined } = {
    events,
    row,
    handleMouse(ev) {
      events.push(ev);
      return result ?? undefined;
    },
    cursorRow() {
      return t.row;
    },
  };
  return t;
}

// 组件顶行在屏幕第 top 行（0 起）：重画 → 查询 → 回复
async function locate(h: ReturnType<typeof host>, t: ReturnType<typeof target>, top: number) {
  t.afterRender?.();
  await tick();
  assert.equal(h.written.at(-1), CPR_QUERY);
  assert.deepEqual(h.feed(`\x1b[${top + (t.row ?? 0) + 1};1R`), { consume: true });
}

test("打开时开鼠标上报，关闭时关掉；全屏模式和 PI_SESSION_PEEK_MOUSE=0 时不介入", async () => {
  const h = host();
  const b = attachMouse(target(), h);
  assert.equal(b.active, true);
  assert.deepEqual(h.written, [ENABLE]);
  assert.equal(h.listeners(), 1);
  b.dispose();
  assert.equal(h.written.at(-1), DISABLE);
  // 关掉之后路上可能还有终端已经发出的鼠标序列，再吃一小会儿
  assert.equal(h.listeners(), 1);
  assert.deepEqual(h.feed("\x1b[<0;5;10M"), { consume: true });
  await grace();
  assert.equal(h.listeners(), 0);
  b.dispose(); // 再调不会重复写
  assert.equal(h.written.filter((w) => w === DISABLE).length, 1);

  const fs = host("fullscreen");
  assert.equal(attachMouse(target(), fs).active, false);
  assert.equal(fs.written.length, 0);
  assert.equal(fs.listeners(), 0);

  const off = host();
  assert.equal(attachMouse(target(), off, { PI_SESSION_PEEK_MOUSE: "0" }).active, false);
  assert.equal(off.written.length, 0);
});

test("重画后发一次光标位置查询，回复被吃掉并算出顶行；没测到之前鼠标事件只吞不发", async () => {
  const h = host();
  const t = target(1);
  attachMouse(t, h);
  assert.deepEqual(h.feed("\x1b[<0;5;10M"), { consume: true });
  assert.equal(t.events.length, 0);
  // 连着重画多次只问一次
  t.afterRender?.();
  t.afterRender?.();
  await tick();
  assert.equal(h.written.filter((w) => w === CPR_QUERY).length, 1);
  // 光标在组件第 1 行、屏幕第 9 行（1 起），顶行就是屏幕第 7 行（0 起）
  assert.deepEqual(h.feed("\x1b[9;3R"), { consume: true });
  h.feed("\x1b[<0;5;10M");
  assert.equal(t.events.length, 1);
  assert.equal(t.events[0].type, "press");
  assert.equal(t.events[0].x, 4);
  assert.equal(t.events[0].y, 9 - 7);
  assert.equal(t.events[0].screenY, 9);
  assert.equal(t.events[0].width, 120);
  assert.equal(t.events[0].height, 40);
});

test("查询在途时又重画了，回复之后再问一次；没有焦点（光标不在组件上）时不问", async () => {
  const h = host();
  const t = target(1);
  attachMouse(t, h);
  t.afterRender?.();
  await tick();
  t.afterRender?.();
  await tick();
  assert.equal(h.written.filter((w) => w === CPR_QUERY).length, 1);
  h.feed("\x1b[9;1R");
  await tick();
  assert.equal(h.written.filter((w) => w === CPR_QUERY).length, 2);
  h.feed("\x1b[9;1R");

  t.row = undefined;
  t.afterRender?.();
  await tick();
  assert.equal(h.written.filter((w) => w === CPR_QUERY).length, 2);
});

test("不是我们问的光标回复和普通按键原样放行", () => {
  const h = host();
  const t = target();
  attachMouse(t, h);
  assert.equal(h.feed("\x1b[9;1R"), undefined);
  assert.equal(h.feed("a"), undefined);
  assert.equal(h.feed("\x1b[A"), undefined);
  assert.equal(t.events.length, 0);
});

test("按下 / 松开换算成 press、release、click；同一格连点 clickCount 1 → 2 → 3 → 1", async () => {
  const h = host();
  const t = target();
  attachMouse(t, h);
  await locate(h, t, 5);
  h.feed("\x1b[<0;3;12M");
  h.feed("\x1b[<0;3;12m");
  assert.deepEqual(
    t.events.map((e) => [e.type, e.button, e.x, e.y, e.clickCount]),
    [
      ["press", "left", 2, 6, undefined],
      ["release", "left", 2, 6, undefined],
      ["click", "left", 2, 6, 1],
    ],
  );
  for (const n of [2, 3, 1]) {
    h.feed("\x1b[<0;3;12M");
    h.feed("\x1b[<0;3;12m");
    assert.equal(t.events.at(-1)?.clickCount, n);
  }
  // 换了格子松开不算点击
  h.feed("\x1b[<0;3;12M");
  h.feed("\x1b[<0;4;12m");
  assert.equal(t.events.at(-1)?.type, "release");
  // 右键也上报，Shift / Ctrl 修饰位解出来
  h.feed("\x1b[<2;3;12M");
  assert.equal(t.events.at(-1)?.button, "right");
  h.feed("\x1b[<20;3;12M");
  assert.equal(t.events.at(-1)?.ctrl, true);
  assert.equal(t.events.at(-1)?.shift, true);
});

test("按着左键移动是 drag；动过之后松开不算点击，回到原格松开也不算", async () => {
  const h = host();
  const t = target();
  attachMouse(t, h);
  await locate(h, t, 5);
  h.feed("\x1b[<0;3;12M");
  h.feed("\x1b[<32;4;12M");
  h.feed("\x1b[<32;6;13M");
  h.feed("\x1b[<32;3;12M");
  h.feed("\x1b[<0;3;12m");
  assert.deepEqual(
    t.events.map((e) => [e.type, e.button, e.x, e.y]),
    [
      ["press", "left", 2, 6],
      ["drag", "left", 3, 6],
      ["drag", "left", 5, 7],
      ["drag", "left", 2, 6],
      ["release", "left", 2, 6],
    ],
  );
  // 没按下时来的移动事件（35 = 不带键）不发
  h.feed("\x1b[<35;4;12M");
  assert.equal(t.events.length, 5);
  // 拖动也让组件重画
  assert.equal(h.renders(), 4);
});

test("滚轮：64 向上 65 向下，按住 Alt 五倍；横向滚轮忽略", async () => {
  const h = host();
  const t = target();
  attachMouse(t, h);
  await locate(h, t, 0);
  h.feed("\x1b[<64;10;5M");
  h.feed("\x1b[<65;10;5M");
  h.feed("\x1b[<72;10;5M");
  h.feed("\x1b[<73;10;5M");
  h.feed("\x1b[<66;10;5M");
  h.feed("\x1b[<67;10;5M");
  assert.deepEqual(
    t.events.map((e) => [e.type, e.button, e.wheelDelta, e.alt]),
    [
      ["wheel", "none", -1, false],
      ["wheel", "none", 1, false],
      ["wheel", "none", -5, true],
      ["wheel", "none", 5, true],
    ],
  );
});

test("组件处理了按下 / 滚轮就请求重画，只处理松开不重画，没处理也不重画", async () => {
  const h = host();
  const t = target();
  attachMouse(t, h);
  await locate(h, t, 0);
  h.feed("\x1b[<64;10;5M");
  assert.equal(h.renders(), 1);
  h.feed("\x1b[<0;3;12M");
  assert.equal(h.renders(), 2);
  h.feed("\x1b[<0;3;12m"); // release 不算，click 算
  assert.equal(h.renders(), 3);

  const quiet = host();
  const q = target(1, null);
  attachMouse(q, quiet);
  await locate(quiet, q, 0);
  quiet.feed("\x1b[<64;10;5M");
  quiet.feed("\x1b[<0;3;12M");
  quiet.feed("\x1b[<0;3;12m");
  assert.equal(q.events.length, 4); // wheel, press, release, click
  assert.equal(quiet.renders(), 0);

  const noRender = host();
  const r = target(1, { handled: true, render: false });
  attachMouse(r, noRender);
  await locate(noRender, r, 0);
  noRender.feed("\x1b[<64;10;5M");
  assert.equal(noRender.renders(), 0);
});

test("关闭时查询还在途：回复到了再摘监听，回复不会漏给 pi；关闭后的鼠标事件也不再发给组件", async () => {
  const h = host();
  const t = target();
  const b = attachMouse(t, h);
  await locate(h, t, 0);
  t.afterRender?.();
  await tick();
  b.dispose();
  assert.equal(h.written.at(-1), DISABLE);
  assert.equal(t.afterRender, undefined);
  assert.deepEqual(h.feed("\x1b[<0;3;12M"), { consume: true });
  assert.equal(t.events.length, 0);
  await grace();
  assert.equal(h.listeners(), 1, "still listening for the in-flight reply");
  assert.deepEqual(h.feed("\x1b[9;1R"), { consume: true });
  await grace();
  assert.equal(h.listeners(), 0);
});

// 走一遍真的 TuiMainScreen：监听在 pi-tui 的输入管线里截鼠标和光标回复，键盘照常到组件
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { setLang } from "../src/i18n.ts";
import { PeekComponent } from "../src/peek-component.ts";
import type { PeekSession } from "../src/sessions.ts";
import { mdTheme, theme } from "./helpers.ts";

function fakeTerminal(columns = 100, rows = 40) {
  const out: string[] = [];
  let onInput: ((data: string) => void) | undefined;
  const term = {
    out,
    input: (d: string) => onInput?.(d),
    start(cb: (data: string) => void) {
      onInput = cb;
    },
    stop() {},
    async drainInput() {},
    write(d: string) {
      out.push(d);
    },
    columns,
    rows,
    kittyProtocolActive: false,
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
  };
  return term;
}

function session(cwd: string, text: string): PeekSession {
  const mtime = Date.now();
  return { path: `${cwd}/${text}.jsonl`, cwd, time: new Date(mtime).toISOString(), name: "", first: text, msgs: [{ role: "user", text }], mtime, size: 0 };
}

test("接在真的 TuiMainScreen 上：重画后问光标，回复不进组件，鼠标按坐标选中，键盘照常过滤", async () => {
  setLang("zh");
  const saved = process.stdout.rows;
  Object.defineProperty(process.stdout, "rows", { value: 40, configurable: true, writable: true });
  const term = fakeTerminal();
  const tui = new TuiMainScreen(term as any, true);
  try {
    const all = [session("D:/a", "first one"), session("D:/b", "second one"), session("D:/c", "third one")];
    const comp: any = new PeekComponent(all, "D:/nowhere", theme, mdTheme, 40, "");
    tui.addChild(comp);
    tui.setFocus(comp);
    tui.start();
    const bridge = attachMouse(comp, tui);
    assert.equal(bridge.active, true);
    await tick(30); // 第一帧
    assert.ok(term.out.includes(ENABLE));
    assert.ok(term.out.includes(CPR_QUERY), "asked for the cursor position after the first render");
    // 常规模式组件从屏幕顶部开始画：光标在搜索框那行，也就是屏幕第 2 行（1 起）
    const typed: string[] = [];
    const origHandle = comp.handleInput.bind(comp);
    comp.handleInput = (d: string) => (typed.push(d), origHandle(d));
    term.input("\x1b[2;5R");
    assert.deepEqual(typed, [], "cursor report never reaches the component");
    // 第 3 项在主体第 4、5 行，即屏幕第 8、9 行（1 起），左栏 x=3
    term.input("\x1b[<0;3;8M");
    term.input("\x1b[<0;3;8m");
    assert.equal(comp.selected, 2);
    assert.deepEqual(typed, []);
    term.input("s");
    assert.deepEqual(typed, ["s"]);
    assert.equal(comp.getQuery(), "s");
    assert.equal(comp.filtered.length, 2);
    await tick(30);
    const asked = term.out.filter((w) => w === CPR_QUERY).length;
    assert.ok(asked >= 2, `re-measured after re-render (asked ${asked})`);
    bridge.dispose();
    assert.equal(term.out.at(-1), DISABLE);
  } finally {
    tui.stop();
    Object.defineProperty(process.stdout, "rows", { value: saved, configurable: true, writable: true });
  }
});

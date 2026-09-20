import type { TuiInputListenerResult, TuiMouseButton, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

// pi 只在全屏模式开鼠标上报，常规模式要自己开：选择器打开时让终端用 SGR 格式上报鼠标（CSI ?1000h ?1006h），
// 在 TUI 的输入监听里截下 \x1b[<b;x;yM / m，换算成组件内的行列交给 handleMouse，关闭时再关掉。
//
// 组件在屏幕上的顶行 pi 自己也不知道：常规模式只做相对光标移动，起始行取决于启动时 shell 的光标停在哪。
// 所以每次重画之后发一个光标位置查询（CSI 6 n），终端回 \x1b[row;colR。硬件光标停在组件里带焦点的
// 输入框那一行，减掉这一行在组件里的偏移就是顶行。全屏模式下 pi-tui 自带鼠标分发，这里什么都不做。
//
// 开了鼠标上报之后终端自己的选文字 / 滚回看历史就不能用了（多数终端按住 Shift 仍可以），
// 不想要的话设 PI_SESSION_PEEK_MOUSE=0。

// 1002：按着键移动也上报，拖选要用；不认 1002 的终端退到 1000 只报按下松开
const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";
const CURSOR_QUERY = "\x1b[6n";
const DOUBLE_CLICK_MS = 500; // 和 pi-tui 全屏模式一样
const QUERY_TIMEOUT_MS = 1000; // 终端不回复就当丢了，允许下次重画再问
const ALT_WHEEL_MULTIPLIER = 5; // 和 pi-tui 一样，按住 Alt 滚快五倍
export const DETACH_GRACE_MS = 150; // 关闭后再听一小会儿：终端可能还有已经发出、在路上的鼠标序列

const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
const CURSOR_REPORT = /^\x1b\[(\d+);(\d+)R$/;

export interface MouseTarget {
  handleMouse(ev: TuiMouseEvent): TuiMouseEventResult | undefined;
  /** 硬件光标在组件内的行号（0 起）；没有焦点时返回 undefined，此时光标不在组件上，测不准 */
  cursorRow(): number | undefined;
  /** 由 attachMouse 赋值，组件每次 render 之后调用 */
  afterRender?: () => void;
}

/** 用到的 TUI 子集，测试里好造假 */
export interface MouseHost {
  readonly mode: string;
  terminal: { write(data: string): void; readonly columns: number; readonly rows: number };
  addInputListener(listener: (data: string) => TuiInputListenerResult): () => void;
  requestRender(): void;
}

export interface MouseBridge {
  /** 常规模式下为 true；全屏模式 pi-tui 自己分发鼠标，这里不介入 */
  readonly active: boolean;
  dispose(): void;
}

function decodeButton(b: number): TuiMouseButton {
  switch (b & 3) {
    case 0:
      return "left";
    case 1:
      return "middle";
    case 2:
      return "right";
    default:
      return "none";
  }
}

export function attachMouse(target: MouseTarget, tui: MouseHost, env: NodeJS.ProcessEnv = process.env): MouseBridge {
  if (tui.mode !== "regular" || !tui.terminal || env.PI_SESSION_PEEK_MOUSE === "0") {
    return { active: false, dispose() {} };
  }

  let top: number | undefined; // 组件顶行在屏幕上的行号（0 起），没测到之前鼠标事件只吞不发
  let inflight: number | undefined; // 已发出、还没收到回复的查询：发出时光标所在的组件内行号
  let dirty = false; // 查询在途时又重画了，回复之后要再问一次
  let scheduled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pressed: { x: number; y: number } | undefined;
  let moved = false; // 按下之后指针换过格没有；换过就不算单击
  let lastClick: { x: number; y: number; at: number; count: number } | undefined;
  let disposed = false;
  let off: (() => void) | undefined;

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const detach = (): void => {
    off?.();
    off = undefined;
  };
  // 关闭后不马上摘监听：查询的回复和路上的鼠标序列都要吃掉，别漏进 pi 的编辑器
  const scheduleDetach = (): void => {
    const t = setTimeout(detach, DETACH_GRACE_MS);
    t.unref?.();
  };
  // 查询结束（收到回复或超时）
  const finishQuery = (): void => {
    inflight = undefined;
    clearTimer();
    if (disposed) scheduleDetach();
    else if (dirty) schedule();
  };
  const query = (): void => {
    scheduled = false;
    if (disposed || inflight !== undefined) return;
    const row = target.cursorRow();
    if (row === undefined) return;
    dirty = false;
    inflight = row;
    tui.terminal.write(CURSOR_QUERY);
    timer = setTimeout(finishQuery, QUERY_TIMEOUT_MS);
    timer.unref?.();
  };
  // 等 pi 把这一帧写完、光标摆好再问
  const schedule = (): void => {
    if (scheduled || disposed) return;
    scheduled = true;
    process.nextTick(query);
  };
  target.afterRender = () => {
    dirty = true;
    schedule();
  };

  off = tui.addInputListener((data): TuiInputListenerResult => {
    const cpr = CURSOR_REPORT.exec(data);
    if (cpr) {
      if (inflight === undefined) return undefined; // 不是我们问的
      top = Number(cpr[1]) - 1 - inflight;
      finishQuery();
      return { consume: true };
    }
    const m = SGR_MOUSE.exec(data);
    if (!m) return undefined;
    if (top === undefined || disposed) return { consume: true };
    const b = Number(m[1]);
    const sx = Number(m[2]) - 1;
    const sy = Number(m[3]) - 1;
    const release = m[4] === "m";
    const base = {
      x: sx,
      y: sy - top,
      screenX: sx,
      screenY: sy,
      width: tui.terminal.columns,
      height: tui.terminal.rows,
      shift: (b & 4) !== 0,
      alt: (b & 8) !== 0,
      ctrl: (b & 16) !== 0,
    };
    let render = false;
    const dispatch = (ev: TuiMouseEvent): void => {
      const r = target.handleMouse(ev);
      if (!r || !(r.handled || r.capture || r.focus)) return;
      // 和 pi-tui 一样：按下、点击、滚轮默认重画，松开默认不重画
      render ||= r.render ?? ev.type !== "release";
    };
    if (b & 64) {
      const dir = (b & 3) === 0 ? -1 : (b & 3) === 1 ? 1 : 0; // 66 / 67 是横向滚轮，不管
      if (!release && dir) {
        dispatch({ ...base, type: "wheel", button: "none", wheelDelta: dir * (base.alt ? ALT_WHEEL_MULTIPLIER : 1) });
      }
    } else {
      const button = decodeButton(b);
      if (b & 32) {
        // 按着键移动。没开 1003，不带键的纯移动不该来，来了也不管
        if (button === "none" || !pressed) return { consume: true };
        if (sx !== pressed.x || sy !== pressed.y) moved = true;
        dispatch({ ...base, type: "drag", button });
      } else if (!release) {
        pressed = { x: sx, y: sy };
        moved = false;
        dispatch({ ...base, type: "press", button });
      } else {
        if (pressed && (sx !== pressed.x || sy !== pressed.y)) moved = true;
        dispatch({ ...base, type: "release", button });
        // 按下松开之间没动过算一次点击；短时间内在同一格连点，次数 1 → 2 → 3 循环
        if (pressed && !moved) {
          const now = Date.now();
          const again = lastClick && now - lastClick.at <= DOUBLE_CLICK_MS && lastClick.x === sx && lastClick.y === sy;
          const count = again && lastClick ? (lastClick.count % 3) + 1 : 1;
          lastClick = { x: sx, y: sy, at: now, count };
          dispatch({ ...base, type: "click", button, clickCount: count });
        }
        pressed = undefined;
      }
    }
    if (render) tui.requestRender();
    return { consume: true };
  });

  // pi 崩了或被杀时终端会留在鼠标模式，之后点一下 shell 里就冒乱码，退出时尽量关掉
  const restore = (): void => {
    try {
      tui.terminal.write(DISABLE_MOUSE);
    } catch {
      // 退出时 stdout 可能已经关了
    }
  };
  process.once("exit", restore);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    process.off("exit", restore);
    target.afterRender = undefined;
    // 选择器开着时切到了全屏模式的话，鼠标已经归 pi-tui 管，别去关
    if (tui.mode === "regular") restore();
    if (inflight === undefined) scheduleDetach();
  };

  tui.terminal.write(ENABLE_MOUSE);
  return { active: true, dispose };
}

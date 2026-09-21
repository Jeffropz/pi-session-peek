import { copyToClipboard, getMarkdownTheme, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { msg } from "./src/i18n.ts";
import { attachMouse } from "./src/mouse.ts";
import { PeekComponent } from "./src/peek-component.ts";
import { deleteSession, renameSession, scanRoot, scanSessions, sessionsDir, type PeekSession } from "./src/sessions.ts";

// 这里只做注册：/peek 命令、--peek / --rp 启动参数，以及把删除 / 重命名 / 分叉注入给组件

let lastQuery = ""; // 进程内记住上次搜索词

export default function (pi: ExtensionAPI) {
  // pi 会把 boolean flag 的值一律强转成 true，所以带关键词的形式只能是 string 类型
  pi.registerFlag("peek", {
    description: msg("flagPeek"),
    type: "string",
  });
  pi.registerFlag("rp", {
    description: msg("flagRp"),
    type: "boolean",
  });

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") return; // 切换会话也会触发 session_start，只在进程启动时打开
    const peek = pi.getFlag("peek");
    const rp = pi.getFlag("rp");
    if (!peek && !rp) return;
    const kw = typeof peek === "string" ? peek.trim() : "";
    const cmd = `/peek${kw ? ` ${kw}` : ""}`;

    // 等 UI 空闲再弹；带了初始 prompt 时 agent 在忙，最后排队到它之后
    const tryOpen = (attempt: number) => {
      try {
        if (ctx.isIdle()) {
          pi.sendUserMessage(cmd, { expandPromptTemplates: true });
        } else if (attempt < 20) {
          setTimeout(() => tryOpen(attempt + 1), 150);
        } else {
          pi.sendUserMessage(cmd, { expandPromptTemplates: true, deliverAs: "followUp" });
        }
      } catch {
        // 扩展已卸载时 API 会抛，忽略
      }
    };
    setTimeout(() => tryOpen(0), 150);
  });

  pi.registerCommand("peek", {
    description: msg("cmdDesc"),
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(msg("needTui"), "error");
        return;
      }

      // 当前正在用的会话不列出来
      const currentFile = ctx.sessionManager.getSessionFile();
      // 扫描范围跟着 pi 实际在用的会话目录走（--session-dir / 环境变量 / settings.json 都在里面）
      const root = scanRoot(ctx.sessionManager.getSessionDir());
      const customDir = root !== sessionsDir() ? root : undefined;
      const all = (await scanSessions(root)).filter((s) => s.path !== currentFile);
      if (!all.length) {
        ctx.ui.notify(msg("noSessions"), "info");
        return;
      }

      const initial = ((args ?? "").trim() || lastQuery) ?? "";
      type Picked = { s: PeekSession; action: "resume" | "fork" } | null;
      const picked = await ctx.ui.custom<Picked>((tui, theme, _kb, done) => {
        const comp = new PeekComponent(all, ctx.cwd, theme, getMarkdownTheme(), process.stdout.rows || 24, initial);
        comp.requestRender = () => tui.requestRender();
        // 常规模式 pi 不开鼠标，自己开；全屏模式 pi-tui 会直接调 comp.handleMouse
        const mouse = attachMouse(comp, tui);
        comp.onDispose = () => mouse.dispose();
        // 鼠标拖选后 Ctrl+C 复制。用 pi 自己的复制：原生剪贴板，不行再退到 OSC 52
        comp.onCopy = async (text) => {
          try {
            await copyToClipboard(text);
            return true;
          } catch {
            return false;
          }
        };
        comp.onResume = (s) => {
          lastQuery = comp.getQuery();
          done({ s, action: "resume" });
        };
        comp.onFork = (s) => {
          lastQuery = comp.getQuery();
          done({ s, action: "fork" });
        };
        comp.onCancel = () => {
          lastQuery = comp.getQuery();
          done(null);
        };
        comp.onDelete = async (s) => {
          // PowerShell / osascript 冷启动要一两秒，超时给宽一点
          const r = await deleteSession(s.path, (cmd, a) => pi.exec(cmd, a, { timeout: 15000 }));
          const file = basename(s.path);
          if (r === "trash") ctx.ui.notify(msg("trashed", { file }), "info");
          else if (r === "rm") ctx.ui.notify(msg("deleted", { file }), "info");
          else ctx.ui.notify(msg("deleteFailed"), "error");
          return r !== false;
        };
        comp.onRename = async (s, name) => {
          let ok = true;
          try {
            renameSession(s.path, name);
          } catch {
            ok = false;
          }
          ctx.ui.notify(ok ? msg("renamed", { name }) : msg("renameFailed"), ok ? "info" : "error");
          return ok;
        };
        return comp;
      });

      if (!picked) return;

      let target = picked.s.path;
      if (picked.action === "fork") {
        // 和 pi --fork 一样：把全部记录复制到新文件，header 里记下 parentSession
        try {
          // 自定义了会话目录时分叉也放进去，别写回默认目录
          const forked = SessionManager.forkFrom(picked.s.path, ctx.cwd, customDir);
          target = forked.getSessionFile() ?? target;
          ctx.ui.notify(msg("forked", { file: basename(target) }), "info");
        } catch (e) {
          ctx.ui.notify(msg("forkFailed", { error: e instanceof Error ? e.message : String(e) }), "error");
          return;
        }
      }

      const result = await ctx.switchSession(target);
      if (result?.cancelled) {
        ctx.ui.notify(msg("switchCancelled"), "info");
      }
    },
  });
}

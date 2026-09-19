import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { PeekComponent } from "./src/peek-component.ts";
import { deleteSession, renameSession, scanSessions, type PeekSession } from "./src/sessions.ts";

// 这里只做注册：/peek 命令、--peek / --rp 启动参数，以及把删除 / 重命名 / 分叉注入给组件

let lastQuery = ""; // 进程内记住上次搜索词

export default function (pi: ExtensionAPI) {
  // pi 会把 boolean flag 的值一律强转成 true，所以带关键词的形式只能是 string 类型
  pi.registerFlag("peek", {
    description: "启动时打开会话搜索预览并预填关键词（--peek=关键词）",
    type: "string",
  });
  pi.registerFlag("rp", {
    description: "启动时打开会话搜索预览（不带关键词）",
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
    description: "搜索历史会话：左右分栏预览、关键词高亮，Enter 进入对话",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/peek 需要在交互模式（TUI）下使用", "error");
        return;
      }

      // 当前正在用的会话不列出来
      const currentFile = ctx.sessionManager.getSessionFile();
      const all = scanSessions().filter((s) => s.path !== currentFile);
      if (!all.length) {
        ctx.ui.notify("没有找到历史会话", "info");
        return;
      }

      const initial = ((args ?? "").trim() || lastQuery) ?? "";
      type Picked = { s: PeekSession; action: "resume" | "fork" } | null;
      const picked = await ctx.ui.custom<Picked>((tui, theme, _kb, done) => {
        const comp = new PeekComponent(all, ctx.cwd, theme, process.stdout.rows || 24, initial);
        comp.requestRender = () => tui.requestRender();
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
          const ok = await deleteSession(s.path, (cmd, a) => pi.exec(cmd, a, { timeout: 4000 }));
          ctx.ui.notify(ok ? `已删除会话 ${basename(s.path)}` : "删除会话失败", ok ? "info" : "error");
          return ok;
        };
        comp.onRename = async (s, name) => {
          let ok = true;
          try {
            renameSession(s.path, name);
          } catch {
            ok = false;
          }
          ctx.ui.notify(ok ? `已重命名为「${name}」` : "重命名失败", ok ? "info" : "error");
          return ok;
        };
        return comp;
      });

      if (!picked) return;

      let target = picked.s.path;
      if (picked.action === "fork") {
        // 和 pi --fork 一样：把全部记录复制到新文件，header 里记下 parentSession
        try {
          const forked = SessionManager.forkFrom(picked.s.path, ctx.cwd);
          target = forked.getSessionFile() ?? target;
          ctx.ui.notify(`已分叉为新会话 ${basename(target)}`, "info");
        } catch (e) {
          ctx.ui.notify(`分叉失败：${e instanceof Error ? e.message : String(e)}`, "error");
          return;
        }
      }

      const result = await ctx.switchSession(target);
      if (result?.cancelled) {
        ctx.ui.notify("切换会话已取消", "info");
      }
    },
  });
}

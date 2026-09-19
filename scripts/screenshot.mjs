// Render docs/screenshot.png from real component output with pi's dark theme. Needs Chrome.
// Usage: npm run screenshot

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import { setLang } from "../src/i18n.ts";
import { PeekComponent } from "../src/peek-component.ts";

process.env.FORCE_COLOR = "3";
setLang("en");

const COLS = 112;
const ROWS = 34;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshot.png");

// theme.js is not in the package exports, so load it by file path. The markdown theme's colour
// functions read the global theme, which is why initTheme() has to run first.
const pkgIndex = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const themeMod = await import(pathToFileURL(join(dirname(pkgIndex), "modes", "interactive", "theme", "theme.js")).href);
themeMod.initTheme("dark", false);
const theme = themeMod.theme;
const mdTheme = themeMod.getMarkdownTheme();

const day = 86400e3;
const mk = (cwd, ago, texts, name = "") => ({
  path: `${cwd}/${ago}.jsonl`,
  cwd,
  time: new Date(Date.now() - ago * day).toISOString(),
  name,
  first: texts[0].replace(/\s+/g, " ").slice(0, 80),
  msgs: texts.map((text, i) => ({ role: i % 2 ? "assistant" : "user", text })),
  searchText: (texts.join(" ") + " " + name + " " + cwd).toLowerCase(),
  mtime: Date.now() - ago * day,
});

const sessions = [
  mk("D:/test", 0.2, [
    "Help me find the pi-session-peek plugin.",
    [
      "Found it.",
      "",
      "- **npm package:** `pi-session-peek@0.1.0`, a Pi extension that searches session history in a two-pane picker, then resumes or forks. [npm](https://www.npmjs.com/package/pi-session-peek)",
      "- **GitHub:** [Jeffropz/pi-session-peek](https://github.com/Jeffropz/pi-session-peek)",
      "",
      "It is already installed as a global Pi extension:",
      "",
      "```text",
      "~/.pi/agent/extensions/session-peek",
      "```",
      "",
      "| Step | What I ran | Result |",
      "| ---: | --- | --- |",
      "| 1 | `npm view pi-session-peek` | 0.1.0 on npm |",
      "| 2 | `ls ~/.pi/agent/extensions` | a `session-peek` folder |",
      "| 3 | `git remote -v` in that folder | same GitHub repo |",
      "",
      "Use it with `/peek`, `/peek keyword`, `pi --rp` or `pi --peek=keyword`.",
    ].join("\n"),
    "How did you find it?",
    [
      "I checked the places Pi extensions live, then verified the installed copy:",
      "",
      "1. Searched the workspace and the Pi docs for `pi-session-peek`. No local hit.",
      "2. Ran `npm view pi-session-peek --json`, which confirmed the package on npm.",
      "3. Listed `~/.pi/agent/extensions/` and saw a `session-peek` directory.",
      "4. Verified that its `package.json` and git remote point at the same repo.",
      "",
      "The only surprise: the folder is named `session-peek`, while the npm package is `pi-session-peek`.",
    ].join("\n"),
    "Create a table and outline your steps for me.",
    [
      "| Step | What I checked | Why it mattered |",
      "| ---: | --- | --- |",
      "| 1 | Exact name in the workspace | Ruled out the current repo |",
      "| 2 | Pi docs for extension locations | Where Pi loads extensions from |",
      "| 3 | npm registry | Confirmed the canonical source |",
      "| 4 | Global extensions directory | Found the installed copy |",
      "| 5 | `package.json` and git remote | Verified it is the same plugin |",
      "",
      "Outline:",
      "",
      "1. Search the exact identifier first.",
      "2. Check the documented auto-discovery paths, not only project files.",
      "3. Query npm for name, version and repository.",
      "4. Verify by `package.json` and git remote, not by folder name.",
    ].join("\n"),
  ], "find the peek plugin"),
  mk("D:/test", 1, [
    "Today's AI highlights",
    [
      "Today's AI highlights:",
      "",
      "- **The AI executive order was postponed** hours before the signing ceremony.",
      "- **Microsoft is in talks to supply Maia AI chips to Anthropic**; no deal has been signed.",
      "- **EY and Microsoft launched a $1B+ enterprise AI initiative** to move clients from pilots to production.",
    ].join("\n"),
  ]),
  mk("D:/work/pi-session-peek", 3, [
    "The preview in pi-session-peek squashes tables into one line. Can it use pi's markdown renderer?",
    "Yes. pi-tui exports the `Markdown` component that pi uses for its own transcript, and pi-coding-agent exports `getMarkdownTheme()`. I switched the preview to it and moved keyword highlighting after rendering, so it no longer breaks links or code fences.",
  ], "markdown preview"),
  mk("C:/Users/me/notes", 6, [
    "Summarize this week's meeting notes",
    "Done. Grouped by project into three sections in notes/2026-09-w3.md.",
  ]),
  mk("D:/work/api-gateway", 9, [
    "Change the gateway rate limit from per-IP to per-user",
    "Switched the key in middleware/ratelimit.go from remoteAddr to claims.sub and added a RATE_LIMIT_BY=user setting.",
  ]),
  mk("D:/work/mobile-app", 15, [
    "Does pi-session-peek work with a project-local extensions folder?",
    "Yes. Drop the package into .pi/extensions/ inside the project and run /reload. Pi auto-discovers it, no settings.json entry needed.",
  ]),
];

const comp = new PeekComponent(sessions, "D:/test", theme, mdTheme, ROWS + 12, "session-peek");
comp.handleInput("\t"); // all projects, so the list is fuller
const lines = comp.render(COLS);

// ANSI -> HTML. Every character gets a fixed terminal-cell width (emoji take two cells), so the
// column separators line up.
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function toHtml(line) {
  let fg = "", bg = "", bold = false, underline = false, dim = false, italic = false;
  let html = "";
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  // Hyperlinks (OSC 8) and the like have no visual effect here; drop them first.
  line = line.replace(/\x1b[\]_][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
  const flush = (text) => {
    for (const ch of text) {
      const w = visibleWidth(ch) >= 2 ? 2 : 1;
      const style = [
        `width:${w}ch`,
        fg && `color:${fg}`,
        bg && `background:${bg}`,
        bold && "font-weight:700",
        italic && "font-style:italic",
        underline && "text-decoration:underline",
        dim && "opacity:.6",
      ].filter(Boolean).join(";");
      html += `<span style="${style}">${ch === " " ? "&nbsp;" : esc(ch)}</span>`;
    }
  };
  for (let m; (m = re.exec(line)); ) {
    flush(line.slice(last, m.index));
    last = m.index + m[0].length;
    const p = m[1].split(";").map(Number);
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === 0) { fg = bg = ""; bold = underline = dim = italic = false; }
      else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 22) { bold = false; dim = false; }
      else if (c === 3) italic = true;
      else if (c === 23) italic = false;
      else if (c === 4) underline = true;
      else if (c === 24) underline = false;
      else if (c === 39) fg = "";
      else if (c === 49) bg = "";
      else if (c === 38 && p[i + 1] === 2) { fg = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`; i += 4; }
      else if (c === 48 && p[i + 1] === 2) { bg = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`; i += 4; }
    }
  }
  flush(line.slice(last));
  return html;
}

const html = `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;background:#101114}
  body{padding:14px}
  pre{margin:0;font:15px/22px "Cascadia Mono","Consolas","Menlo",monospace;color:#d4d4d8;white-space:pre}
  pre span{display:inline-block;overflow:hidden;vertical-align:top;font-family:"Cascadia Mono","Consolas","Menlo","Segoe UI Emoji","Apple Color Emoji",monospace}
</style>
<pre>${lines.map(toHtml).join("\n")}</pre>`;

const work = mkdtempSync(join(tmpdir(), "peek-shot-"));
const htmlPath = join(work, "shot.html");
writeFileSync(htmlPath, html);

const chrome = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => p && existsSync(p));
if (!chrome) {
  console.error("Chrome not found. Set CHROME_PATH and retry.");
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
rmSync(OUT, { force: true });
// Cascadia Mono at 15px is 9px per column. Another monospace font only adds a right margin; nothing gets clipped.
const width = COLS * 9 + 36;
const height = lines.length * 22 + 28;
const r = spawnSync(chrome, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
  `--user-data-dir=${join(work, "profile")}`,
  "--force-device-scale-factor=2",
  `--window-size=${width},${height}`,
  `--screenshot=${OUT}`,
  pathToFileURL(htmlPath).href,
], { stdio: "pipe" });
if (r.error) {
  console.error(r.error.message);
  process.exit(1);
}
// On Windows the Chrome launcher process exits first and a background process writes the file
// a moment later, so wait until the file actually shows up and stops growing.
const deadline = Date.now() + 30000;
let size = 0;
while (Date.now() < deadline) {
  await new Promise((res) => setTimeout(res, 250));
  if (!existsSync(OUT)) continue;
  const now = statSync(OUT).size;
  if (now > 0 && now === size) break;
  size = now;
}
await new Promise((res) => setTimeout(res, 500));
rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
if (!existsSync(OUT) || size === 0) {
  console.error(String(r.stderr) || "Chrome did not write the screenshot.");
  process.exit(1);
}
console.log(`Wrote ${OUT}`);

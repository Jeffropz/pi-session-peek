# 🔍 pi-session-peek — 找到那次对话，接着聊

[![npm](https://img.shields.io/npm/v/pi-session-peek)](https://www.npmjs.com/package/pi-session-peek) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

[English](https://github.com/Jeffropz/pi-session-peek/blob/main/README.md)

按对话内容搜索 [pi](https://pi.dev) 的历史会话，右栏直接读完整对话，然后回到那个会话继续，或者分叉出一个新的。

![pi-session-peek 截图](https://raw.githubusercontent.com/Jeffropz/pi-session-peek/main/docs/screenshot.png)

## ✨ 功能

- `/peek` 或 `/peek 关键词` 打开左右分栏的选择器：左边是会话列表，右边是完整对话。
- 右栏用 pi 自己的 Markdown 渲染器画，标题、带语法高亮的代码块、表格、列表和主界面里的对话一个样子。
- 边打字边过滤，搜的是对话正文和会话名。工作目录只在显式写 `dir:` 时才搜，项目路径里的词不会把整个项目的会话都命中。工具调用的参数和结果不进搜索索引，所以只会命中真正讨论过这个词的会话。
- 空格分隔多个关键词，全部命中才显示；列表里直接显示第一个命中处的片段。
- 支持 `"精确短语"`、`a|b` 任一命中、`-排除`、`name:` / `dir:` / `user:` / `ai:` 限定范围，以及 `/正则/`。
- `@7d`、`@24h`、`@2w`、`@1m` 只看最近活动过的会话。
- 预览里所有命中都高亮，`Ctrl+N` / `Ctrl+P` 在命中间跳。
- `Ctrl+T` 显示 AI 实际做了什么：每次工具调用在对应回复下面占一行灰字（`⚙ bash  git status`、`⚙ edit  src/query.ts`）。默认关闭。
- `Enter` 进入会话，`Ctrl+O` 分叉成新会话，`Ctrl+R` 重命名，`Ctrl+D` 删除。
- `Tab` 在当前目录树和全部项目之间切换。
- `pi --rp` 或 `pi --peek=关键词` 启动时直接打开。
- 会话文件只解析一次，按修改时间缓存，再次打开不用等。

## 📦 安装

```bash
pi install npm:pi-session-peek
```

不装、只试一次：

```bash
pi -e npm:pi-session-peek
```

从 GitHub 装：

```bash
pi install git:github.com/Jeffropz/pi-session-peek
```

pi 扩展以你的用户权限运行，只装信得过的包。

## 🚀 快速开始

在 TUI 模式下输入 `/peek`，直接打字过滤。选中后按 `Enter` 接着聊，或者按 `Ctrl+O` 在一个新分叉里聊，原会话不动。

## 💬 命令

| 命令 | 作用 |
| --- | --- |
| `/peek` | 打开选择器，本次进程内记住上次的关键词 |
| `/peek 关键词` | 带关键词打开 |
| `pi --rp` | 启动 pi 并打开选择器。不接受参数。 |
| `pi --peek=关键词` | 启动 pi 并带关键词打开。`--peek` 必须带值。 |

## ⌨️ 按键

| 按键 | 作用 |
| --- | --- |
| 打字 | 过滤。空格分隔的词都要命中；短语、`-排除`、前缀、正则和 `@7d` 见[搜索语法](#-搜索语法)。 |
| `Tab` | 当前目录树 ↔ 全部项目 |
| `↑` `↓` | 选会话 |
| `PgUp` `PgDn` | 预览翻页 |
| `Ctrl+U` `Ctrl+F` | 预览翻半页 |
| `Shift+↑` `Shift+↓` | 预览滚三行 |
| `Ctrl+N` `Ctrl+P` | 跳到当前屏幕外的下一处 / 上一处命中行，右上角显示「命中 k/n」 |
| `Ctrl+T` | 预览里显示 / 隐藏工具调用。每次调用一行：工具名和主参数（命令、路径、URL、查询词）。不显示结果。 |
| `Enter` | 进入会话 |
| `Ctrl+O` | 分叉出新会话并进入 |
| `Ctrl+R` | 重命名，写入的记录和 `/name` 一样 |
| `Ctrl+D` | 删除，按 `y` 或 `Enter` 确认。只要系统有回收站就优先进回收站（`trash` 命令、Windows 用 PowerShell 进回收站、macOS 用 Finder、Linux 用 `gio trash` / `trash-put`），全都不可用才直接删文件。 |
| `Esc` `Ctrl+C` | 关闭 |

## 🖱️ 鼠标

| 操作 | 作用 |
| --- | --- |
| 点列表里的会话 | 选中 |
| 双击会话 | 进入，和 `Enter` 一样 |
| 在列表上滚滚轮 | 换选中项 |
| 在预览上滚滚轮 | 预览每格滚三行，按住 `Alt` 快五倍 |
| 点头部的范围字样 | 当前目录树 ↔ 全部项目，和 `Tab` 一样 |
| 点搜索框或改名行 | 移动光标 |
| 在某一栏里按住拖动 | 只选这一栏的文字。拖过分隔线或拖出边界，选区仍留在起点那一栏里，按这一栏的宽度换行。 |
| 有选区时按 `Ctrl+C` | 复制到剪贴板。松开鼠标不会自动复制。没有选区时 `Ctrl+C` 仍是关闭；点一下任意位置清掉选区。 |

鼠标上报只在选择器打开时开、关闭时关，pi 的其他界面不受影响。开着的时候终端自带的选文字和滚回看历史不能用，多数终端按住 `Shift` 可以照旧，但那是终端自己的选区，会横跨两栏。不想要鼠标就设 `PI_SESSION_PEEK_MOUSE=0`。pi 的全屏模式下走 pi 自己的鼠标分发，这个变量不起作用。

## 🔎 搜索语法

大小写不敏感，匹配文本中任意位置。空白分隔多个词，每个词都要满足。

| 输入 | 含义 |
| --- | --- |
| `token undefined` | 同时包含 `token` 和 `undefined` 的会话，顺序不限，可以在不同的消息里 |
| `"token undefined"` | 精确短语。引号里的空白可以匹配正文里的任意一段空白，包括换行 |
| `vue\|react` | 包含 `vue` 或 `react` 的会话 |
| `-draft` | 消息和会话名里都不含 `draft` 的会话 |
| `name:auth` | 只在会话名里找。`dir:` 或 `cwd:` 只看工作目录 |
| `user:deploy` | 只看你发的消息。`ai:` 或 `assistant:` 只看回复 |
| `/\bfoo\d+\b/` | JavaScript 正则，大小写不敏感，`^` 和 `$` 匹配行首行尾。空格用 `\s` 代替 |
| `@7d` | 最近 7 天活动过的会话。单位：`h` 小时、`d` 天、`w` 周、`m` 月（按 30 天算） |
| `-user:"not now" ai:/todo\|fixme/ @2w` | 前缀可以叠加，所有条件一起组合 |

引号是万能转义：`"-foo"`、`"a|b"`、`"name:x"`、`"/x/"` 都按字面搜这些字符。正则写错了就当普通文字搜。预览里只高亮正向的词，`name:` / `dir:` 的词不碰对话正文，所以只输入 `name:auth` 时右栏显示完整对话、没有高亮。

索引里有用户和助手的消息和会话名。工作目录只由 `dir:` / `cwd:` 匹配：当前目录树范围下所有会话的路径都带同一段前缀，普通词一碰到路径就会命中全部会话。没有工具调用的参数和结果，`Ctrl+T` 显示的工具行也不参与匹配和高亮。

## 🌐 界面语言

跟随系统语言：区域是 `zh-*` 显示中文，其他显示英文。判断顺序是 `PI_SESSION_PEEK_LANG`，然后 `LC_ALL` / `LC_MESSAGES` / `LANG`，最后是操作系统的区域设置。

强制指定：

```bash
PI_SESSION_PEEK_LANG=en pi
PI_SESSION_PEEK_LANG=zh pi
```

Windows PowerShell 里先执行 `$env:PI_SESSION_PEEK_LANG = "en"` 再启动 pi。语言在扩展加载时读一次，改了之后要重启 pi 或 `/reload`。

## 🚧 限制

- 只支持 TUI 模式。
- 鼠标需要终端支持 SGR 鼠标上报和光标位置回报（`CSI 6 n`）。Windows Terminal、iTerm2、kitty、WezTerm、Alacritty、GNOME Terminal、VS Code 都支持，老式 Windows 控制台不支持。
- 特别长的会话预览只显示最后 500 条消息，更早的命中仍会计数并提示。
- `pi --peek` 不带值会被 pi 在启动时拒绝，不带关键词请用 `pi --rp`。
- pi 默认布局下扫描 `~/.pi/agent/sessions`（或 `$PI_CODING_AGENT_DIR/sessions`）下所有项目的会话。pi 用了自定义会话目录（`--session-dir`、`$PI_CODING_AGENT_SESSION_DIR` 或 settings 里的 `sessionDir`）时只扫描那个目录，分叉也写到那里。

## 🗂️ 目录结构

```text
pi-session-peek/
├── index.ts                 # 注册 /peek 和启动参数，注入删除 / 重命名 / 分叉 / 复制
├── src/
│   ├── peek-component.ts    # 双栏组件：状态、按键和鼠标路由、头尾、双栏拼接
│   ├── preview.ts           # 右栏：按会话生成预览行和命中行、初始滚动位置、Ctrl+N/P 跳转目标
│   ├── list.ts              # 左栏：每个会话两行、视口跟随
│   ├── drag-select.ts       # 拖选状态机：按下 / 拖动 / 松开 / 自动滚动
│   ├── selection.ts         # 选区几何：区间、反显、取文字
│   ├── layout.ts            # 分栏宽度和主体高度
│   ├── sessions.ts          # 扫描解析会话 JSONL，重命名 / 删除
│   ├── query.ts             # 查询解析、匹配、高亮、命中片段
│   ├── mouse.ts             # 常规（非全屏）模式下的鼠标上报
│   ├── ansi.ts              # 转义序列分词、SGR 跟踪、输入净化
│   ├── theme.ts             # 选择器用到的 pi Theme 子集
│   ├── i18n.ts              # 中英文界面文案和语言检测
│   └── text.ts              # 路径、时间、宽度工具
├── scripts/screenshot.mjs   # 可选：用组件渲染输出生成一张合成截图
└── test/                    # node:test 测试
```

## 🛠️ 开发

```bash
npm install
npm test               # node:test，通过 tsx 跑 TS
npm run typecheck      # tsc --noEmit
npm run screenshot     # 可选：用合成渲染覆盖 docs/screenshot.png，需要本机有 Chrome
```

本地开发时把目录路径加到 `~/.pi/agent/settings.json` 的 `extensions` 里，或者直接放进 `~/.pi/agent/extensions/`，然后 `/reload`。

### 发版

推到 `main` 和提 PR 都会在 Ubuntu 和 Windows 上跑 `npm run check`（`.github/workflows/ci.yml`）。推一个 `vX.Y.Z` 的 tag 会触发 `.github/workflows/release.yml`：校验 tag 和 `package.json` 版本一致，再跑一遍检查，通过 [trusted publishing](https://docs.npmjs.com/trusted-publishers/) 发到 npm（不需要 token，自动附带 provenance），最后从 `CHANGELOG.md` 里对应版本的段落生成 GitHub Release。

npm 侧需要一次性配置：包设置 → Trusted Publisher → GitHub Actions，填 owner `Jeffropz`、repository `pi-session-peek`、workflow filename `release.yml`。

发一个版本：

```bash
# 1. 把这版的更新说明写在 CHANGELOG.md 的 "## Unreleased" 下面，并提交
#    （npm version 遇到已跟踪文件有未提交改动会直接拒绝）
# 2. 升版本号（patch / minor / major）
npm version patch
# 3. 提交和 tag 一起推上去，剩下的交给 CI
git push --follow-tags
```

`npm version` 一上来先检查 git 工作区是否干净，不干净就报 `Git working directory not clean.` 退出，所以 `CHANGELOG.md` 在内的所有改动都要先提交（未跟踪的文件不影响）。然后才跑 `package.json` 里声明的钩子：`preversion` 先确认 `CHANGELOG.md` 里有非空的 `## Unreleased` 段落，再跑 `npm run check`，任一不通过就在改动任何文件之前中止；`version` 跑 `scripts/release-changelog.mjs`，把 `## Unreleased` 改成新版本号并 `git add`。然后 npm 把 `package.json`、lockfile 和 `CHANGELOG.md` 一起提交成 `chore: release X.Y.Z`（提交信息定义在 `.npmrc`），并打上 `vX.Y.Z` 的 tag。

## 📄 许可证

MIT，见 [`LICENSE`](./LICENSE)。

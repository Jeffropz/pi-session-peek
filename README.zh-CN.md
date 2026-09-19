# 🔍 pi-session-peek — 找到那次对话，接着聊

[![npm](https://img.shields.io/npm/v/pi-session-peek)](https://www.npmjs.com/package/pi-session-peek) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

[English](https://github.com/Jeffropz/pi-session-peek/blob/main/README.md)

按对话内容搜索 [pi](https://pi.dev) 的历史会话，右栏直接读完整对话，然后回到那个会话继续，或者分叉出一个新的。

![pi-session-peek 截图](https://raw.githubusercontent.com/Jeffropz/pi-session-peek/main/docs/screenshot.png)

## ✨ 功能

- `/peek` 或 `/peek 关键词` 打开左右分栏的选择器：左边是会话列表，右边是完整对话。
- 右栏用 pi 自己的 Markdown 渲染器画，标题、带语法高亮的代码块、表格、列表和主界面里的对话一个样子。
- 边打字边过滤，搜的是对话正文、会话名和工作目录。工具调用的参数和结果不进索引，所以只会命中真正讨论过这个词的会话。
- 空格分隔多个关键词，全部命中才显示；列表里直接显示第一个命中处的片段。
- `@7d`、`@24h`、`@2w`、`@1m` 只看最近活动过的会话。
- 预览里所有命中都高亮，`Ctrl+N` / `Ctrl+P` 在命中间跳。
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
| 打字 | 过滤。空格分隔的词都要命中；`@7d` 等限定时间。 |
| `Tab` | 当前目录树 ↔ 全部项目 |
| `↑` `↓` | 选会话 |
| `PgUp` `PgDn` | 预览翻页 |
| `Ctrl+U` `Ctrl+F` | 预览翻半页 |
| `Shift+↑` `Shift+↓` | 预览滚三行 |
| `Ctrl+N` `Ctrl+P` | 下一个 / 上一个命中 |
| `Enter` | 进入会话 |
| `Ctrl+O` | 分叉出新会话并进入 |
| `Ctrl+R` | 重命名，写入的记录和 `/name` 一样 |
| `Ctrl+D` | 删除，按 `y` 或 `Enter` 确认。有 `trash` 命令就进回收站，否则直接删文件。 |
| `Esc` `Ctrl+C` | 关闭 |

## 🔎 搜索语法

大小写不敏感，匹配文本中任意位置。

| 输入 | 含义 |
| --- | --- |
| `token undefined` | 同时包含 `token` 和 `undefined` 的会话 |
| `@7d` | 最近 7 天活动过的会话。单位：`h` 小时、`d` 天、`w` 周、`m` 月（按 30 天算） |
| `token @2w` | 两者组合 |

索引里有用户和助手的消息、会话名、工作目录。没有工具调用的参数和结果。

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
- 不支持鼠标。pi 只在实验性的全屏模式里开鼠标，这个选择器还没处理鼠标事件。
- 特别长的会话预览只显示最后 500 条消息，更早的命中仍会计数并提示。
- `pi --peek` 不带值会被 pi 在启动时拒绝，不带关键词请用 `pi --rp`。
- 只扫描 `~/.pi/agent/sessions`（或 `$PI_CODING_AGENT_DIR/sessions`）下的会话。

## 🗂️ 目录结构

```text
pi-session-peek/
├── index.ts                 # 注册 /peek 和启动参数，注入删除 / 重命名 / 分叉
├── src/
│   ├── peek-component.ts    # 双栏 TUI 组件
│   ├── sessions.ts          # 扫描解析会话 JSONL，重命名 / 删除
│   ├── query.ts             # 查询解析、高亮、命中片段
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

## 📄 许可证

MIT，见 [`LICENSE`](./LICENSE)。

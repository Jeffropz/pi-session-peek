# 🔍 pi-session-peek — Find That Old Conversation and Jump Back In

[![npm](https://img.shields.io/npm/v/pi-session-peek)](https://www.npmjs.com/package/pi-session-peek) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

[中文说明](https://github.com/Jeffropz/pi-session-peek/blob/main/README.zh-CN.md)

Search your [pi](https://pi.dev) session history by what was actually said, read the whole conversation in a side pane, then resume it or fork it.

![pi-session-peek screenshot](https://raw.githubusercontent.com/Jeffropz/pi-session-peek/main/docs/screenshot.png)

## ✨ Features

- Opens a two-pane picker with `/peek` or `/peek <keyword>`: sessions on the left, the full conversation on the right.
- Renders the conversation with pi's own Markdown renderer, so headings, code blocks with syntax highlighting, tables and lists look the same as in the main transcript.
- Filters as you type across conversation text, session name and working directory. Tool call arguments and results are excluded, so a keyword only matches sessions that actually discussed it.
- Requires every space-separated keyword to match, and shows a snippet around the first hit in the list.
- Limits results to recently active sessions with `@7d`, `@24h`, `@2w` or `@1m`.
- Highlights every hit in the preview and jumps between them with `Ctrl+N` / `Ctrl+P`.
- Resumes with `Enter`, forks into a new session with `Ctrl+O`, renames with `Ctrl+R`, deletes with `Ctrl+D`.
- Toggles between the current directory tree and all projects with `Tab`.
- Starts straight into the picker with `pi --rp` or `pi --peek=<keyword>`.
- Parses each session file once and caches it by mtime, so reopening is instant.

## 📦 Install

```bash
pi install npm:pi-session-peek
```

Try it without installing permanently:

```bash
pi -e npm:pi-session-peek
```

Install from GitHub instead of npm:

```bash
pi install git:github.com/Jeffropz/pi-session-peek
```

Pi extensions run with the Pi process's user permissions, so install only trusted packages.

## 🚀 Quick start

In TUI mode, run `/peek` and start typing. Press `Enter` on a session to continue it, or `Ctrl+O` to continue in a fresh fork and leave the original untouched.

## 💬 Commands

| Command | Purpose |
| --- | --- |
| `/peek` | Open the picker. The previous keyword is remembered for the process. |
| `/peek <keyword>` | Open the picker with the keyword filled in. |
| `pi --rp` | Start pi and open the picker. Takes no argument. |
| `pi --peek=<keyword>` | Start pi and open the picker with the keyword filled in. `--peek` requires a value. |

## ⌨️ Keys

| Key | Action |
| --- | --- |
| type | Filter. Space-separated words must all match; `@7d` and friends limit by time. |
| `Tab` | Current directory tree ↔ all projects |
| `↑` `↓` | Select session |
| `PgUp` `PgDn` | Scroll preview by a page |
| `Ctrl+U` `Ctrl+F` | Scroll preview by half a page |
| `Shift+↑` `Shift+↓` | Scroll preview by three lines |
| `Ctrl+N` `Ctrl+P` | Next / previous hit line outside the current view; the top-right corner shows `hit k/n` |
| `Enter` | Resume the session |
| `Ctrl+O` | Fork the session and open the fork |
| `Ctrl+R` | Rename. Writes the same `session_info` entry as `/name`. |
| `Ctrl+D` | Delete, confirmed with `y` or `Enter`. Moves the file to the system trash whenever one is available (`trash` CLI, then the Windows Recycle Bin via PowerShell, Finder on macOS, `gio trash` / `trash-put` on Linux). Deletes permanently only if none of those work. |
| `Esc` `Ctrl+C` | Close |

## 🔎 Search syntax

The filter is case-insensitive and matches anywhere in the text.

| Input | Meaning |
| --- | --- |
| `token undefined` | Sessions containing both `token` and `undefined` |
| `@7d` | Sessions active in the last 7 days. Units: `h`, `d`, `w`, `m` (30 days). |
| `token @2w` | Both combined |

The search index holds user and assistant messages, the session name and the working directory. It does not hold tool call arguments or tool results.

## 🌐 Language

The interface follows your system language: Chinese on `zh-*` locales, English everywhere else. Detection order is `PI_SESSION_PEEK_LANG`, then `LC_ALL` / `LC_MESSAGES` / `LANG`, then the OS locale.

Force a language:

```bash
PI_SESSION_PEEK_LANG=en pi
PI_SESSION_PEEK_LANG=zh pi
```

On Windows PowerShell: `$env:PI_SESSION_PEEK_LANG = "en"` before starting pi. The language is read once when the extension loads, so change it before starting pi or run `/reload`.

## 🚧 Limitations

- TUI mode only.
- No mouse support. Pi only enables mouse input in its experimental fullscreen mode, and this picker does not handle it yet.
- The preview shows the last 500 messages of very long sessions. Hits in earlier messages are still counted and announced.
- `pi --peek` without a value is rejected by pi at startup. Use `pi --rp` to open without a keyword.
- Only sessions under `~/.pi/agent/sessions` (or `$PI_CODING_AGENT_DIR/sessions`) are scanned.

## 🗂️ Package layout

```text
pi-session-peek/
├── index.ts                 # Registers /peek and the startup flags, injects delete / rename / fork
├── src/
│   ├── peek-component.ts    # The two-pane TUI component
│   ├── sessions.ts          # Scans and parses session JSONL, rename / delete helpers
│   ├── query.ts             # Query parsing, highlighting, hit snippets
│   ├── i18n.ts              # Chinese / English UI strings and locale detection
│   └── text.ts              # Path, time and width helpers
├── scripts/screenshot.mjs   # Optional: renders a synthetic screenshot from component output
└── test/                    # node:test suites
```

## 🛠️ Development

```bash
npm install
npm test               # node:test via tsx
npm run typecheck      # tsc --noEmit
npm run screenshot     # optional: overwrite docs/screenshot.png with a synthetic render (needs Chrome)
```

To load a local checkout, add its path under `extensions` in `~/.pi/agent/settings.json` or drop the folder into `~/.pi/agent/extensions/`, then `/reload`.

### Releasing

Every push to `main` and every pull request runs `npm run check` on Ubuntu and Windows (`.github/workflows/ci.yml`). Pushing a `vX.Y.Z` tag runs `.github/workflows/release.yml`, which checks that the tag matches `package.json`, runs the checks again, publishes to npm through [trusted publishing](https://docs.npmjs.com/trusted-publishers/) (no token needed, provenance attached automatically) and creates a GitHub Release from the matching `CHANGELOG.md` section.

One-time setup on npmjs.com: package settings → Trusted Publisher → GitHub Actions, with owner `Jeffropz`, repository `pi-session-peek`, workflow filename `release.yml`.

To cut a release:

```bash
# 1. make sure the release notes are under "## Unreleased" in CHANGELOG.md (committed or not)
# 2. bump the version (patch / minor / major)
npm version patch
# 3. push the commit together with the tag; CI does the rest
git push --follow-tags
```

`npm version` runs the hooks declared in `package.json`: `preversion` checks that `CHANGELOG.md` has a non-empty `## Unreleased` section and runs `npm run check`, aborting the bump before anything is touched if either fails; `version` runs `scripts/release-changelog.mjs`, which renames `## Unreleased` to the new version and stages the file. npm then commits `package.json`, the lockfile and `CHANGELOG.md` as `chore: release X.Y.Z` (message set in `.npmrc`) and tags it `vX.Y.Z`.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).

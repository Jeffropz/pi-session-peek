# Changelog

## 0.1.0

First release.

- Two-pane picker: session list on the left, full conversation preview on the right.
- Live filtering by conversation text, session name and working directory. Space-separated keywords must all match; `@7d`, `@24h`, `@2w`, `@1m` limit results to recently active sessions.
- Keyword highlighting, hit snippets in the list, Ctrl+N / Ctrl+P to jump between hits.
- Enter resumes, Ctrl+O forks, Ctrl+R renames, Ctrl+D deletes (moves to trash when the `trash` CLI is available).
- Tab toggles between the current directory tree and all projects.
- `/peek [keyword]` command, `--rp` and `--peek=<keyword>` startup flags.
- Chinese and English interface, following the system locale. Override with `PI_SESSION_PEEK_LANG=zh|en`.

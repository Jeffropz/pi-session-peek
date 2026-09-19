# Changelog

## Unreleased

- Ctrl+N / Ctrl+P now jump between hit lines instead of hit messages. Several hits inside one long reply used to collapse into a single stop, so the preview appeared not to move. Hits already on screen are skipped, and the top-right corner shows the current hit as `hit k/n`.

## 0.2.0

- The preview renders messages with pi's own Markdown renderer: headings, bold, inline code, syntax-highlighted code blocks, tables with borders and cell wrapping, lists, quotes and links now look the same as in the main transcript.
- Keyword highlighting is applied on top of the rendered lines, so it no longer breaks links or code blocks. A keyword that is split across a wrapped line is not highlighted at that spot; hit counting and Ctrl+N / Ctrl+P are unaffected.

## 0.1.0

First release.

- Two-pane picker: session list on the left, full conversation preview on the right.
- Live filtering by conversation text, session name and working directory. Space-separated keywords must all match; `@7d`, `@24h`, `@2w`, `@1m` limit results to recently active sessions.
- Keyword highlighting, hit snippets in the list, Ctrl+N / Ctrl+P to jump between hits.
- Enter resumes, Ctrl+O forks, Ctrl+R renames, Ctrl+D deletes (moves to trash when the `trash` CLI is available).
- Tab toggles between the current directory tree and all projects.
- `/peek [keyword]` command, `--rp` and `--peek=<keyword>` startup flags.
- Chinese and English interface, following the system locale. Override with `PI_SESSION_PEEK_LANG=zh|en`.

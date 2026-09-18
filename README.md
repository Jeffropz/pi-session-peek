# pi-session-peek

搜索 [pi](https://pi.dev) 的历史会话，左边选、右边看完整对话，Enter 回到那个会话继续聊。

## 安装

```bash
pi install git:github.com/Jeffropz/pi-session-peek
```

也可以直接把仓库放到 `~/.pi/agent/extensions/session-peek/`，然后 `/reload`。

## 用法

```
/peek                 打开
/peek 关键词          带关键词打开
pi --rp               启动 pi 时直接打开
pi --peek=关键词      启动时带关键词打开
```

搜索框里空格分隔多个词表示都要命中；`@7d`、`@24h`、`@2w`、`@1m` 只看最近活动过的会话。搜的是对话正文、会话名和工作目录，不包括工具调用的输入输出。

| 按键 | 作用 |
|------|------|
| `Tab` | 当前目录树 / 全部项目 |
| `↑` `↓` | 选会话 |
| `PgUp` `PgDn` | 预览翻页 |
| `Ctrl+U` `Ctrl+F` | 预览翻半页 |
| `Shift+↑` `Shift+↓` | 预览滚 3 行 |
| `Ctrl+N` `Ctrl+P` | 下一个 / 上一个命中 |
| `Enter` | 进入会话 |
| `Ctrl+O` | 从这个会话分叉出新会话再进入 |
| `Ctrl+R` | 重命名（和 `/name` 效果一样） |
| `Ctrl+D` | 删除，`y` 或 `Enter` 确认；有 `trash` 命令就进回收站 |
| `Esc` `Ctrl+C` | 关闭 |

## English

Search pi session history in a two-pane picker. Type to filter (space-separated words must all match, `@7d` limits to recent sessions), `Enter` to resume, `Ctrl+O` to fork, `Ctrl+R` to rename, `Ctrl+D` to delete, `Tab` to toggle between the current directory tree and all projects. Install with `pi install git:github.com/Jeffropz/pi-session-peek`. The UI text is Chinese.

## License

MIT © Jeffropz

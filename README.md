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
pi --peek             启动 pi 时直接打开
pi --peek=关键词      启动时带关键词打开
pi --rp               同 --peek
```

搜的是对话正文、会话名和工作目录，不包括工具调用的输入输出。

| 按键 | 作用 |
|------|------|
| `Tab` | 当前目录 / 全部项目 |
| `↑` `↓` | 选会话 |
| `PgUp` `PgDn` | 预览翻页 |
| `Ctrl+U` `Ctrl+D` | 预览翻半页 |
| `Shift+↑` `Shift+↓` | 预览滚 3 行 |
| `Ctrl+N` `Ctrl+P` | 下一个 / 上一个命中 |
| `Enter` | 进入会话 |
| `Esc` | 关闭 |

## English

Search pi session history in a two-pane picker: type to filter, `Enter` to resume, `Tab` to toggle between the current directory and all projects. Install with `pi install git:github.com/Jeffropz/pi-session-peek`. The UI text is Chinese.

## License

MIT © Jeffropz

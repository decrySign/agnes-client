# 长任务与后台终端

## 前台 vs 后台

| | 前台 `run_terminal` | 后台 `run_terminal` + `background: true` |
| --- | --- | --- |
| 返回时机 | 等进程结束 / 超时 / 被停止 | 立刻返回 `terminal_id` |
| 超时 | `timeout_ms`（最长 5 分钟） | 无工具级超时；用 `await_terminal` 等待 |
| 聊天「停止」 | 会 `killTree` 杀掉进程 | **不会**杀后台进程 |
| 适用 | 短命令、测试、一次性脚本 | 长编译、dev server、watch |

## 工具

- `run_terminal`：可选 `background`（默认 false）。后台启动后请用下面三个工具跟进。
- `await_terminal`：`terminal_id` + 可选 `timeout_ms`。等到退出或超时；AbortSignal（聊天停止）只取消等待，不杀进程。
- `read_terminal`：非阻塞，读出自上次以来的新输出。
- `stop_terminal`：显式杀掉该后台任务。
- `list_terminals`：列出当前会话的后台终端（只读，可并行）。

## 停止语义

- **聊天 Stop / `stopConv`**：只中止本轮 Agent（AbortSignal）。后台终端继续跑，下一轮可用同一 `terminal_id` 继续 `read` / `await` / `stop`。
- **`stop_terminal`**：杀掉指定 `terminal_id`。
- **删除会话 / 级联删除工作区**：`disposeConversation` / `disposeBgTerminalsForConv` 清理该会话的全部后台任务。
- **进程退出 / 服务关闭**：清理全部后台任务。

## 恢复

下一轮开始时，若本会话还有后台任务，系统提示里会带一行清单；也可调用 `list_terminals`。用返回的 `terminal_id` 继续读输出或等待结束。

## 限制

- 输出缓冲约 200KB，超出后截断并停止该进程（结果里有 `…(truncated)`）。
- 同时运行的后台任务最多 8 个（进程级）。
- 命令审批规则与前台相同。

## 尽力而为

后台任务登记在服务进程内存里：服务重启后句柄失效，操作系统里可能仍有孤儿进程，需要时请手动结束。

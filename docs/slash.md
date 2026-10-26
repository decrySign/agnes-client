# 斜杠命令

输入框以 `/` 开头可选斜杠命令。命令在本地处理，**不会**把命令原文发给模型（`/plan` 带后文时只发后文）。

## 命令一览

| 命令 | 作用 |
| --- | --- |
| `/help` | 列出全部命令与中文说明 |
| `/plan` / `/plan off` | 打开/关闭计划模式（仅 Agent）；可带后文一并发送 |
| `/mcp` | 查看 MCP 服务器连接状态与工具数 |
| `/status` | 当前模式、计划开关、忙闲、模型、工作区 |
| `/clear` | 在**当前**工作区/模式下新开一条对话并删除刚清空的那条（其它会话不动） |
| `/new` | 同 `/clear` 新开同模式/同工作区对话，但**保留**当前这条 |
| `/model` | 列出可用模型；`/model <模型id>` 切换当前对话模型（生成中拒绝） |
| `/compact` | 准备压缩发给模型的上下文；需再输入 `/compact confirm` |
| `/compact confirm` | 执行压缩：写入 `conv.summary.*` 摘录缓存，**不删界面消息** |

## 长任务：`/compact`

长对话里工具输出会把上下文撑满。自动压缩有时不够及时，可用：

1. `/compact` — 看到确认提示  
2. `/compact confirm` — 调用 `POST /api/conversations/:id/compact`  

压缩只影响**发给模型**的那一份；聊天记录仍在。正在生成时会拒绝，请先停止。

后台终端断线续跑等能力是下一阶段，不在本版斜杠命令里。

## 未知命令

形如 `/foo` 的未知命令会显示本地提示，**不会**当作用户消息发出。路径（如 `/Users/...`）仍可正常发送。

## 实现位置

- 权威解析：`packages/agent/src/slash.ts`（`parseComposerCommand` / `listSlashCommands` / `dispatchSlashCommand`）
- 界面镜像：`packages/ui/src/ChatPane.tsx`（不引用 `@agnes/agent`，两处需保持一致）

# 子 Agent 步骤持久化

子 Agent（`task`）运行时的工具步骤会：

1. 实时经 SSE `tool_start` / `tool_end`（带 `parent`）画在当前会话
2. 整轮结束后写入对应 tool 消息的 `attachments.sub_steps`
3. 刷新 / 重开会话时由 `groupTranscript` 读回，并嵌在父 `task` 步骤下

父模型仍只看到子 Agent 的最终结论文本，子步骤不进入模型上下文。
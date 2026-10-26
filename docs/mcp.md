# MCP 工具（Model Context Protocol）

Agnes 通过本地 **stdio** 进程接入 MCP 服务器（与 Cursor / Claude Desktop 同类配置）。不走 HTTP，和 Clash fake-ip 无关。

## 配置位置（合并；同名时工作区覆盖数据目录）

1. `{数据目录}/mcp.json`（桌面端设置里能看到数据目录路径）
2. `{工作区}/.agnes/mcp.json`

格式与 Cursor / Claude 兼容：

```json
{
  "mcpServers": {
    "demo": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"],
      "env": {},
      "disabled": false
    }
  }
}
```

- `command` / `args`：启动命令（必填 command）
- `env`：额外环境变量（字符串）
- `disabled: true`：不启动，状态为 disconnected
- `cwd`：可选工作目录
- `framing`：可选。默认 `content-length`（与 Claude 时代客户端 / 本仓库 checker fixture 一致）。官方 `@modelcontextprotocol/sdk` 起的服务器用当前 MCP 规范的换行分隔 JSON，请设 `"framing": "newline"`。

## 工具命名

模型看到的工具名是 `mcp__{server}__{tool}`。server / tool 里非 `[A-Za-z0-9_]` 的字符会换成 `_`。

## 子 Agent

**子 Agent（depth>0）可以使用 MCP 工具**，与主 Agent 相同。只读子任务也会带上 MCP（v1 不做只读过滤）。

## 状态

设置 → MCP：`connected` / `disconnected` / `error`，以及工具数量。也可 `GET /api/mcp`。改配置后点「重新加载」或 `POST /api/mcp/reload`，或重启客户端。

## 安全

- MCP 子进程以**当前用户权限**运行，能做该用户能做的事。只添加你信任的服务器。
- 工具结果与环境变量**不会**被写入日志；stderr 会被丢弃，避免密钥泄漏。
- 单个服务器启动失败不会拖垮其它服务器或整个应用。

## 手动冒烟

1. 把上面的示例写进数据目录 `mcp.json`（或用 checker 的 mock：`checker/mcp-fixtures/configs/valid.json`）。
2. 重启或点「重新加载」。
3. 新开 Agent 对话，让模型调用 `mcp__…` 工具。
4. 跑检查：`cd packages\server` 后 `tsx ..\..\checker\agent\mcp-check.ts`（可加 `MCP_FORCE_PRODUCT=1`）。

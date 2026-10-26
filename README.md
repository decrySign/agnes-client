# Agnes Client（开源演示壳）

自备 [Agnes](https://www.agnes-ai.com/) Token Plan 的 `AGNES_API_KEY`，在本机跑对话 / Agent / 图像 / 视频的桌面与网页壳。

**English summary:** Bring-your-own Agnes API key. Local Electron + optional web UI. Custom OpenAI/Anthropic-compatible providers for chat. No commercial card-key auth, no hosted relay, no operator admin console. MIT licensed.

## 能给什么 / 不给什么

| 给 | 不给 |
| --- | --- |
| 自备 Agnes `AGNES_API_KEY` 本机直连 | 卡密激活 / 续期 / 公测领卡 |
| 自定义模型对接（见下节） | 运营后台 |
| 本地对话 + Agent（读写工作区、终端仅桌面） | 任何商业中转（如 `ai-api` 一类授权中转） |
| 出图 / 出视频（走自备 Agnes 密钥） | 写死的生产更新源 / 授权域名 |

正式商业桌面端（发卡、中转、运营）闭源另发，与本仓无关。

## 为什么开源

当 WorkBuddy 一类产品的积分不再免费时，有人更愿意自备约每月 30 元（约 \$4）的 Agnes Plan，自己在本机跑 Agent。开源这个精简壳是为了：

- 降低「自带密钥自建」的门槛
- 用可见源码建立信任
- **同时不暴露**闭源商业产品里的发卡授权、中转与运营后台

## 和正式发卡版的区别

| | 本开源仓 | 正式商业桌面端（闭源另发） |
| --- | --- | --- |
| 模型调用 | 本机直连 Agnes API（`AGNES_API_KEY`）；对话还可接自定义提供方 | 可走厂商授权中转 |
| 发卡 / 试用领取 | **不含** | 含 |
| 运营后台 | **不含** | 含 |
| 更新源 / 授权域名 | **不写死任何生产域名** | 厂商托管 |
| 协议 | MIT | 闭源发行 |

本仓**不提供**官方发卡与中转服务。密钥只放在你自己的 `.env` 或 Electron `safeStorage`，**切勿提交到 Git**。

## 适用场景

- WorkBuddy 等产品积分收紧后，想自建 Agent 工作台
- 已有 Agnes Token Plan，希望本地对话 + 读写工作区 + 终端（仅桌面）
- 想把对话接到自己的 OpenAI 兼容 / Anthropic 兼容接口，同时保留 Agnes 出图出视频
- 二次开发 / 学习 Agent 工具循环，不想绑死某家发卡体系

## 环境准备

- Node.js 22+（推荐 24）
- pnpm 10
- 一份 Agnes Token Plan / API Key（[Agnes 文档](https://www.agnes-ai.com/zh-Hans/docs/overview)）——出图 / 出视频以及默认 Agnes 对话需要它

```bash
pnpm install
cp .env.example .env
```

在 `.env` 里填写：

- `AGNES_API_KEY`（必填，若要用 Agnes 默认对话或图像 / 视频）
- 可选：`AGNES_BASE_URL`（默认 `https://apihub.agnes-ai.com/v1`）
- 保持 `LICENSE_SERVER_URL` 为空（本仓默认本机权威，直连你的密钥）

## 本地开发

```bash
# 网页 UI + API
pnpm dev
# UI http://127.0.0.1:5173   API http://127.0.0.1:8787

# 桌面端（Electron 自启本机后端，勿与上面抢 8787）
pnpm desktop:dev
```

其它常用命令：

```bash
pnpm typecheck
pnpm check:agent
pnpm desktop:pack          # 可选：打本地 zip（不会写死生产更新源）
```

桌面端会把 API Key 存进系统凭据（Windows DPAPI / Electron `safeStorage`），对话与工作区记录在本机 SQLite。

配置了本地 `AGNES_API_KEY` 且未设置远程授权地址时，本仓会自动授予本机操作者权限，**不必再走发卡激活**。

## 自定义模型（桌面端）

桌面客户端支持把**对话**接到你自己的模型提供方（不经过 Agnes）。入口：

**设置 → 模型 → 自定义模型**

每个提供方填写：

| 字段 | 说明 |
| --- | --- |
| ID / 名称 | 列表里显示用的标识与名称 |
| API 地址 | 兼容接口的 Base URL |
| 协议 | `openai-completions` / `openai-responses` / `anthropic-messages` |
| 密钥 | 该提供方自己的 API Key（加密存在本机，见下） |
| 模型目录 | 该地址下可用的模型 ID 列表（可手填；也可用探测） |

说明：

- 自定义提供方的密钥落盘时加密：打包桌面端走 Electron `safeStorage`（Windows 上为 DPAPI）；开发模式则用数据目录内的本地密钥箱，拷走库文件 alone 不会直接带走明文。
- 之后**新建对话**可在输入框下方换成这些自定义模型；它们走你填的地址，**不占用 Agnes 的对话次数**。
- **出图 / 出视频仍使用自备的 Agnes `AGNES_API_KEY`**（自定义提供方目前只管对话）。
- 后端对应接口：`POST/PUT/DELETE /api/providers`、`POST /api/providers/probe`（桌面本机权威模式下可用）。

网页版默认模型由部署方 `.env` 决定，不提供上述「自定义模型」面板。

## 仓库结构

- `packages/agnes-sdk` — Agnes HTTP 客户端
- `packages/agent` — 工具循环 / 工作区沙箱
- `packages/server` — 本机 Hono + SQLite（权威模式）+ `/api/providers`
- `packages/ui` — 对话与 Agent UI
- `apps/web` — Vite 网页壳
- `apps/desktop` — Electron 壳

## 安全提醒

- 不要把真实密钥、`.env`、`*.sqlite`、私钥提交进仓库
- 不要把本演示壳重新接上任何商业发卡中转后，再声称「官方开源版」
- 公开服务前请自行评估鉴权、CORS 与工作区路径风险；默认面向本机使用

## 贡献

改代码请开分支并提 PR，**不要直推 `main`**。详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 协议

[MIT](./LICENSE)

## 声明

本仓库由社区 / 维护者提供的**演示与自建模板**，与任何商业发卡、授权中转、运营后台无关；也不保证与闭源正式版功能一一对应。
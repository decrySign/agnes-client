# 开发与测试（开源演示仓）

## 分支与提交

- 默认分支建议 `main`
- 不要提交 `.env`、密钥、`data/`、`*.sqlite`、`checker/`、`apps/desktop/release/`

## 本地命令

```bash
pnpm install
cp .env.example .env   # 填写 AGNES_API_KEY
pnpm dev               # 网页 UI :5173 + API :8787
pnpm desktop:dev       # Electron（勿与 pnpm dev 抢 8787）
pnpm typecheck
pnpm check:agent
pnpm check:hardening
```

## 当前定位

- 本机权威：`LICENSE_SERVER_URL` 为空，模型直连你的 `AGNES_API_KEY`
- 不含卡密授权、不含商业中转、不含运营后台
- 配置本地密钥后，状态接口会授予本机操作者权限，无需卡密流程

## 不要做的事

- 不要把生产授权域名或真实密钥写进仓库
- 不要做人为压 CPU 的压力测试（共享开发机上尤其禁止）
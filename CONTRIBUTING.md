# 贡献指南

感谢关注本开源演示仓（[decrySign/agnes-client](https://github.com/decrySign/agnes-client)）。

## 怎么改代码

1. **从最新 `main` 开分支**（不要在 `main` 上直接改并推送）。
2. 完成本地修改、自测（如 `pnpm typecheck`）。
3. **推送到功能分支**，在 GitHub 上 **向 `main` 提 Pull Request**。
4. 审查通过后，由维护者 **合并 PR** 进 `main`。

## 不要做的事

- **不要直推 `main`**（仓库已启用分支保护 / ruleset，直推会被拒绝）。
- **不要 force-push** 到 `main`，也不要删除 `main`。
- 不要把真实密钥、`.env`、私钥、发卡 / 中转 / 运营后台相关内容提交进本仓。

## PR 建议

- 标题写清改了什么（中英文均可）。
- 说明动机与验证方式；小改动也可一句话说完。
- 个人维护仓审批人数可为 0，但仍须走 PR，不能跳过合并流程。

## License

贡献内容默认按本仓 [MIT](./LICENSE) 授权。

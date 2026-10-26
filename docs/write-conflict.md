# 同文件并发写冲突

同一工作区允许多个会话并行（目录级 `withWorkspaceLock` 串行落盘）。为避免 `write_file` 基于过期内容整文件覆盖：

- `read_file` 会记录本会话读到的文件 snap（mtime + size）
- 自动写入前若 snap 已变 → **拒绝**并提示重新 `read_file`
- 若未读过但其他会话刚写过同一路径 → **仍写入**，结果中附带冲突提示

suggest 模式下原文比对失败仍走原有 `stale` / 409 路径。
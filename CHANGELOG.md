# 变更日志

本文件记录 LiveFlow 的显著变更，格式参考 Keep a Changelog，版本号遵循语义化版本。

到 `v1.0.0` 之前，公共接口仍可能发生破坏性变化。

## [未发布]

### 新增

- 仓库骨架：工具链、CI、类型契约与目录结构。
- 公开类型契约：`Clock`、`LivePlayerAdapter`、`DanmakuMessage`、`RealtimeOverlayEvent`、
  renderer contract、诊断事件与错误类型。
- `CONTRACT_VERSION` 常量，用于调用方与引擎的一次性契约校验。

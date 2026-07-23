# 错误类型参考

全部公开错误继承 `LiveFlowError`，并提供稳定的 `code`。错误信息用于开发诊断，不应直接展示
给最终用户。

## 共享与连续性

| 类型                                    | `code`                                |
| --------------------------------------- | ------------------------------------- |
| `ContractVersionMismatchError`          | `contract-version-mismatch`           |
| `AssetResolutionError`                  | `asset-resolution-failed`             |
| `CapacityExceededError`                 | `capacity-exceeded`                   |
| `InvalidContinuityPolicyError`          | `invalid-continuity-policy`           |
| `InvalidPlaybackMetricsError`           | `invalid-playback-metrics`            |
| `PreparedSourceGenerationMismatchError` | `prepared-source-generation-mismatch` |
| `SourceTransitionError`                 | `source-{phase}-failed`               |

连续性控制器还会在播放速率更新或销毁聚合失败时抛出带
`playback-rate-update-failed`、`controller-cleanup-failed` 的 `LiveFlowError`。

## 弹幕

| 类型                               | `code`                          |
| ---------------------------------- | ------------------------------- |
| `InvalidDanmakuConfigurationError` | `invalid-danmaku-configuration` |
| `InvalidDanmakuMessageError`       | `invalid-danmaku-message`       |
| `NonMonotonicDanmakuClockError`    | `non-monotonic-danmaku-clock`   |
| `DanmakuRendererError`             | `danmaku-renderer-failed`       |

## 实时事件

| 类型                               | `code`                          |
| ---------------------------------- | ------------------------------- |
| `InvalidOverlayEventError`         | `invalid-overlay-event`         |
| `InvalidOverlayConfigurationError` | `invalid-overlay-configuration` |
| `OverlayCapacityError`             | `overlay-capacity-exceeded`     |
| `OverlayDestroyedError`            | `overlay-destroyed`             |
| `OverlayRenderError`               | `overlay-render-failed`         |
| `OverlaySchedulingError`           | `overlay-scheduling-failed`     |
| `OverlayCleanupError`              | `overlay-cleanup-failed`        |

## 播放器 adapter

`PlayerAdapterError` 用稳定操作码区分失败：

| 类别             | `code`                                                                                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话与代际       | `duplicate-media-generation`、`unknown-prepared-source`、`media-session-unavailable`、`player-adapter-destroyed`                                                                                                             |
| 创建、交接与播放 | `media-prepare-failed`、`media-subscribe-failed`、`media-activation-failed`、`media-play-failed`、`media-discard-failed`、`media-release-failed`                                                                             |
| 媒体控制         | `media-pause-failed`、`media-mute-failed`、`media-volume-failed`、`playback-rate-failed`、`invalid-media-volume`、`invalid-playback-rate`、`media-metrics-failed`                                                            |
| 原生 video       | `native-video-surface-required`、`invalid-native-video`、`native-video-stage-failed`、`native-video-stage-cleanup-failed`、`native-video-subscribe-failed`、`native-video-unsubscribe-failed`、`native-video-cleanup-failed` |
| ArtPlayer-like   | `artplayer-surface-required`、`artplayer-container-missing`、`artplayer-mutex-failed`、`artplayer-create-failed`、`artplayer-subscribe-failed`、`artplayer-unsubscribe-failed`、`artplayer-cleanup-failed`                   |
| 聚合清理         | `player-adapter-cleanup-failed`                                                                                                                                                                                              |

它不保留播放器原始错误，也不包含 source URL。

建议按 `instanceof LiveFlowError` 识别错误族，按 `code` 聚合；不要依赖英文
`message` 文案。

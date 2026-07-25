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

## 多路宫格

| 类型                          | `code`                     |
| ----------------------------- | -------------------------- |
| `InvalidMultiviewLayoutError` | `invalid-multiview-layout` |

瓦片数超过 `maxTiles` 时抛出共享的 `CapacityExceededError`（`capacity-exceeded`），资源名为
`multiview-tiles`。详见[多路宫格布局](./multiview.md)。

## 播放器控件显隐

| 类型                                        | `code`                                    |
| ------------------------------------------- | ----------------------------------------- |
| `InvalidChromeVisibilityConfigurationError` | `invalid-chrome-visibility-configuration` |
| `ChromeVisibilityPinUnderflowError`         | `chrome-visibility-pin-underflow`         |
| `ChromeVisibilityDestroyedError`            | `chrome-visibility-destroyed`             |

listener 数量和 `pin` 深度达到上限时抛出共享的 `CapacityExceededError`。

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

## 脱敏的失败原因

`SourceTransitionError.reason` 只携带上游错误的类名（如 `AbortError`、`NotAllowedError`、
`NotSupportedError`），由 `sanitizeErrorName()` 产出：非 `Error`、或类名不匹配
`/^[A-Za-z]{1,64}$/` 时一律记为 `unknown`。

上游 `message` 永远不会传播，`cause` 也不会挂载 —— 播放器与传输层的错误信息经常内嵌
完整签名媒体 URL。调用方需要区分失败类型时读 `reason`，不要试图解析 `message`。

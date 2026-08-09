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

连续性控制器在销毁期间或销毁后继续调用需要活动状态的方法时，抛出带
`controller-destroyed` 的 `LiveFlowError`。播放速率更新或销毁聚合失败分别使用
`playback-rate-update-failed`、`controller-cleanup-failed`。

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
计时器清理失败时抛出带 `chrome-visibility-cleanup-failed` 的 `LiveFlowError`，其余状态仍会
完成收口，后续 `destroy()` 可以重试该 timer。

## 页面可见性来源

`createDocumentPageActivity()` 绑定或解绑 `visibilitychange` 失败时，分别抛出带
`page-activity-subscribe-failed`、`page-activity-unsubscribe-failed` 的 `LiveFlowError`。
失败的解绑仍保留内部 handle，再次调用同一退订函数可以重试。

## 播放器 adapter

`PlayerAdapterError` 用稳定操作码区分失败：

| 类别             | `code`                                                                                                                                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话与代际       | `duplicate-media-generation`、`unknown-prepared-source`、`media-session-unavailable`、`player-adapter-cleanup-pending`、`player-adapter-destroyed`                                                                                             |
| 创建、交接与播放 | `media-prepare-failed`、`media-subscribe-failed`、`media-activation-failed`、`media-play-failed`、`media-play-autoplay-blocked`、`media-play-browser-suspended`、`media-commit-cleanup-failed`、`media-discard-failed`、`media-release-failed` |
| 媒体控制         | `media-controls-read-failed`、`media-pause-failed`、`media-mute-failed`、`media-volume-failed`、`media-seek-failed`、`playback-rate-failed`、`invalid-media-volume`、`invalid-playback-rate`、`media-metrics-failed`                           |
| 原生 video       | `native-video-surface-required`、`invalid-native-video`、`native-video-subscribe-failed`、`native-video-unsubscribe-failed`、`native-video-cleanup-failed`                                                                                     |
| ArtPlayer-like   | `artplayer-surface-required`、`artplayer-container-missing`、`artplayer-mutex-failed`、`artplayer-create-failed`、`artplayer-subscribe-failed`、`artplayer-unsubscribe-failed`、`artplayer-cleanup-failed`                                     |
| DPlayer-like     | `dplayer-surface-required`、`dplayer-container-missing`、`dplayer-create-failed`、`dplayer-subscribe-failed`、`dplayer-unsubscribe-failed`、`dplayer-cleanup-failed`                                                                           |
| Video.js-like    | `videojs-surface-required`、`videojs-host-missing`、`videojs-video-missing`、`videojs-create-failed`、`videojs-subscribe-failed`、`videojs-unsubscribe-failed`、`videojs-cleanup-failed`                                                       |
| XGPlayer-like    | `xgplayer-surface-required`、`xgplayer-root-missing`、`xgplayer-media-missing`、`xgplayer-create-failed`、`xgplayer-subscribe-failed`、`xgplayer-unsubscribe-failed`、`xgplayer-cleanup-failed`                                                |
| 聚合清理         | `player-adapter-cleanup-failed`                                                                                                                                                                                                                |

它不保留播放器原始错误，也不包含 source URL。

建议按 `instanceof LiveFlowError` 识别错误族，按 `code` 聚合；不要依赖英文
`message` 文案。

## 脱敏的失败原因

`SourceTransitionError.reason` 由 `sanitizeErrorName()` 从固定安全 allowlist 生成：
`AbortError`、`AggregateError`、`Error`、`EvalError`、`InvalidStateError`、`NetworkError`、
`NotAllowedError`、`NotSupportedError`、`OperationError`、`QuotaExceededError`、`RangeError`、
`ReferenceError`、`SecurityError`、`SyntaxError`、`TypeError`、`URIError`。非 `Error`、读取
`name` 失败或名称不在列表中时一律记为 `unknown`。

上游 `message` 永远不会传播，`cause` 也不会挂载 —— 播放器与传输层的错误信息经常内嵌
完整签名媒体 URL。调用方需要区分失败类型时读 `reason`，不要试图解析 `message`。

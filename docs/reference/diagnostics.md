# 指标与诊断码参考

三个引擎都通过 `onDiagnostic` 输出限频结构事件，并通过 `getMetrics()` 输出累计计数与当前
深度。

## Continuity

稳定诊断码：

- `stale-playback-event`
- `prepared-source-discarded`
- `prepared-source-cleanup-failed`
- `stall-detected`
- `catchup-started`
- `catchup-stopped`
- `metrics-sample-failed`
- `invalid-playback-metrics`
- `playback-rate-update-failed`
- `nonrecoverable-playback-error`
- `recovery-requested`
- `recovery-exhausted`
- `recovery-listener-missing`
- `recovery-listener-failed`
- `media-reveal-failed`
- `media-control-restore-failed`
- `media-frame-cancel-failed`
- `media-unsubscribe-failed`
- `media-release-failed`
- `playback-listener-failed`

状态指标通过 `getSnapshot()` 获取：`state`、`generation` 与
`automaticRecoveryCount`。

## Danmaku

稳定诊断码：

- `metadata-discarded`
- `identities-truncated`
- `color-discarded`
- `renderer-failed`
- `clock-failed`
- `measurement-failed`
- `frame-budget-exceeded`

metrics 包含接收、展示、丢弃、等待深度、可见数量、单帧超预算、metadata 丢弃和按原因
分类的丢弃计数。

## Overlay

稳定诊断码：

- `overlay-event-deduped`
- `overlay-event-expired`
- `overlay-event-dropped`
- `overlay-budget-suppressed`
- `overlay-presentation-changed`
- `overlay-render-failed`
- `overlay-scheduling-failed`
- `overlay-cleanup-failed`

引擎 metrics 包含接收、接受、展示、完整与紧凑展示、去重、过期、丢弃、预算拒绝、渲染
失败、等待深度和可见数量。协调器 metrics 另外记录 grant 申请、升级、降级、释放与当前
全局占用。

相同诊断码受速率限制，因此累计数量应以 metrics 为准，诊断用于解释状态变化。

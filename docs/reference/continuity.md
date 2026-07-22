# Continuity API

本文是 LiveFlow 连续性模块的接口参考，面向需要把自有播放器和取流逻辑接入
LiveFlow 的前端开发者。它描述当前已实现的公共契约，不包含平台取流、媒体解码、
播放器 UI 或具体播放器 adapter 的实现方式。

## 入口

```ts
import { CONTRACT_VERSION } from '@babywbx/liveflow'
import { createContinuityController, type LivePlayerAdapter } from '@babywbx/liveflow/continuity'
```

根入口只提供共享类型、错误类型和 `CONTRACT_VERSION`。连续性控制器必须从
`@babywbx/liveflow/continuity` 子路径加载。

## 创建控制器

```ts
const controller = createContinuityController({
  adapter,
  contractVersion: CONTRACT_VERSION,
  onRecoveryRequest(request) {
    // Resolve a fresh source, then call controller.setSource(source).
  },
  onDiagnostic(event) {
    diagnostics.write(event)
  },
})
```

创建时会校验 `contractVersion`。不匹配会立即抛出
`ContractVersionMismatchError`，不会尝试猜测兼容方式。

### `ContinuityControllerOptions`

| 字段                | 类型                        | 必填 | 说明                                     |
| ------------------- | --------------------------- | ---- | ---------------------------------------- |
| `adapter`           | `LivePlayerAdapter`         | 是   | 播放器 adapter；控制器拥有其销毁生命周期 |
| `contractVersion`   | `number`                    | 是   | 调用方编译时绑定的 `CONTRACT_VERSION`    |
| `clock`             | `Clock`                     | 否   | 单调时钟；省略时使用浏览器时钟           |
| `policy`            | `Partial<ContinuityPolicy>` | 否   | 覆盖保守默认策略                         |
| `onRecoveryRequest` | `(request) => void`         | 否   | 请求调用方解析并提交新源                 |
| `onDiagnostic`      | `(event) => void`           | 否   | 接收有速率限制的结构化诊断               |

省略 `onRecoveryRequest` 不会静默停在 `recovering`。需要恢复时，控制器会发出
`recovery-listener-missing` 诊断并进入 `waiting-reopen`。

## 控制器方法

### `setSource(source)`

开始一个新媒体 generation：

1. generation 加一并进入 `resolving`；
2. 调用 `adapter.prepare()`；
3. 调用 `adapter.commit()`；
4. 调用 `adapter.play()`；
5. 等待当前 generation 的 `first-frame` 事件后进入 `playing`。

返回的 Promise 在 `play()` 完成后结束，不等待 `first-frame`。从开始 prepare 到首帧
共享 `sourceWarmupTimeoutMs` 超时。超时后迟到的 prepared source 会被 discard，不能提交。

调用方切换画质、CDN、签名 URL 或媒体代际时都调用 `setSource()`。连续性接口没有
`setQuality()` 或 `setCdn()`；线路和画质解析权始终属于调用方。

### `getSnapshot()`

同步返回：

```ts
interface ContinuitySnapshot {
  readonly state: ContinuityState
  readonly generation: number
  readonly automaticRecoveryCount: number
}
```

快照不包含媒体 URL，避免诊断或 UI 状态意外泄露签名参数。

### `subscribe(listener)`

监听快照变化，返回退订函数。同一控制器最多保留 32 个不同 listener；达到上限会抛出
`CapacityExceededError`。listener 抛错不会改变控制器状态。

### `destroy()`

停止控制器，取消全部计时器、退订 adapter 事件并销毁 adapter。重复调用返回同一个
Promise。清理步骤会尽最大努力全部执行；任一步失败时，完成其余清理后抛出脱敏的
`LiveFlowError`，错误码为 `controller-cleanup-failed`。

## 状态

| 状态             | 含义                                            |
| ---------------- | ----------------------------------------------- |
| `idle`           | 尚未设置源                                      |
| `resolving`      | 正在 prepare 当前 generation                    |
| `warming`        | 已 prepare，等待当前 generation 首帧            |
| `playing`        | 当前 generation 已产生首帧                      |
| `degraded`       | 检测到 waiting、stall、错误或持续高尾距         |
| `recovering`     | 已发出一次有界恢复请求                          |
| `waiting-reopen` | 自动恢复耗尽、不可恢复，或没有可用恢复 listener |
| `stopped`        | 控制器已销毁                                    |

`ERROR` 不等于平台离线。连续性状态不解释主播是否开播，也不会修改调用方的平台状态。

## `LivePlayerAdapter`

```ts
interface LivePlayerAdapter {
  prepare(source: LiveSource, generation: number): Promise<PreparedSource>
  commit(prepared: PreparedSource, generation: number): Promise<void>
  discard(prepared: PreparedSource): Promise<void>
  play(): Promise<void>
  pause(): void
  setMuted(muted: boolean): void
  setVolume(volume: number): void
  setPlaybackRate(rate: number): void
  getMetrics(): PlaybackMetrics
  subscribe(listener: PlaybackEventListener): () => void
  destroy(): Promise<void>
}
```

Adapter 必须遵守以下顺序与所有权规则：

- `prepare()` 不应提前替换调用方当前可见的媒体；
- `PreparedSource` 的内部资源由 adapter 拥有；
- `commit()` 必须使用传入 generation 拒绝过期提交；
- `discard()` 必须可安全释放未提交或已过期的 prepared source；
- 每个 `PlaybackEvent` 必须带产生它的 generation；
- `destroy()` 与退订函数必须可重复、安全调用；
- 错误不得包含完整签名 URL、Cookie 或 token。

控制器会拒绝旧 generation 的事件和迟到 prepare 结果，但 adapter 仍须在自己的
`commit()` seam 阻止已经开始的旧提交覆盖新媒体。

## 播放指标与追帧

`getMetrics()` 返回：

```ts
interface PlaybackMetrics {
  currentTimeSeconds: number
  bufferedAheadSeconds: number
  liveEdgeDistanceSeconds: number
  playbackRate: number
  stalledSince: number | null
  droppedFrames: number | null
}
```

控制器每 500 ms 采样一次：

- 非有限值、负时间、未来的 `stalledSince` 和非法丢帧计数会被拒绝并进入明确恢复；
- 尾距超过目标窗口且前向缓冲至少 1 秒时，使用 `catchupRate` 柔性追帧；
- 非紧急速率变更之间至少间隔 1 秒；
- 前向缓冲不足、waiting、stall 或错误会立即恢复 `1.0x`；
- 尾距连续 2 秒超过硬阈值时，请求调用方恢复源，不直接操作平台线路；
- `stalledSince` 持续至少 400 ms 时进入 stall 恢复。

## 默认策略

| 字段                          |  默认值 |
| ----------------------------- | ------: |
| `targetLatencySeconds`        |     `2` |
| `softCatchupThresholdSeconds` |   `0.6` |
| `hardResyncThresholdSeconds`  |     `8` |
| `catchupRate`                 |  `1.04` |
| `recoveryCooldownMs`          | `30000` |
| `sourceWarmupTimeoutMs`       |  `8000` |
| `reopenGraceMs`               | `90000` |
| `maxAutomaticRecoveries`      |     `4` |

非法数值或互相矛盾的阈值会在创建时抛出
`InvalidContinuityPolicyError`。`reopenGraceMs` 已进入契约，但当前连续性 MVP 不负责把
平台状态判定为离线；调用方仍拥有最终离线展示时机。

## 恢复请求

```ts
interface ContinuityRecoveryRequest {
  readonly reason: 'stall' | 'latency' | 'playback-error' | 'source-timeout'
  readonly generation: number
  readonly attempt: number
}
```

恢复请求受 `recoveryCooldownMs` 和 `maxAutomaticRecoveries` 限制。短暂恢复播放不会清空
同一 generation 的恢复次数，也不会绕过控制器级冷却。恢复 listener 调用 `setSource()`
时，计数会跨 generation 保留，直到替换源产生首帧才清零，因此连续换源失败无法绕过
上限。调用方通常在 listener 中重新解析签名和候选线路，再把选择结果交给
`setSource()`。

## 错误

| 错误                                          | 条件                                          |
| --------------------------------------------- | --------------------------------------------- |
| `ContractVersionMismatchError`                | 调用方契约版本不匹配                          |
| `InvalidContinuityPolicyError`                | 策略字段非法                                  |
| `SourceTransitionError`                       | `prepare`、`commit`、`discard` 或 `play` 失败 |
| `PreparedSourceGenerationMismatchError`       | adapter 返回了错误 generation                 |
| `InvalidPlaybackMetricsError`                 | adapter 返回了非法播放指标                    |
| `CapacityExceededError`                       | listener 或内部时钟句柄达到固定上限           |
| `LiveFlowError` / `controller-cleanup-failed` | 销毁期间有 adapter 清理失败                   |

`SourceTransitionError` 只暴露 phase 和 generation，不保留上游 `cause`，也不包含
`LiveSource.url`。

## 诊断

当前稳定诊断码包括：

- `stale-playback-event`
- `prepared-source-discarded`
- `stall-detected`
- `catchup-started`
- `catchup-stopped`
- `metrics-sample-failed`
- `invalid-playback-metrics`
- `nonrecoverable-playback-error`
- `recovery-requested`
- `recovery-exhausted`
- `recovery-listener-missing`
- `recovery-listener-failed`

同一诊断码最多每秒发出一次；控制器最多保留 32 个诊断码的速率状态。诊断 detail
只包含标量，不包含 source、URL 或原始播放器错误。

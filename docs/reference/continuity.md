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
已经 commit 但尚未产生首帧的候选源也会在超时、下一次换源或销毁时释放。

调用方切换画质、CDN、签名 URL 或媒体代际时都调用 `setSource()`。连续性接口没有
`setQuality()` 或 `setCdn()`；线路和画质解析权始终属于调用方。

### `getSnapshot()`

同步返回：

```ts
interface ContinuitySnapshot {
  readonly state: ContinuityState
  readonly generation: number
  readonly automaticRecoveryCount: number
  readonly healthySince: number | null
  readonly suspension: PlaybackSuspension | null
}
```

快照不包含媒体 URL，避免诊断或 UI 状态意外泄露签名参数。

`healthySince` 是当前健康连播开始时的时钟读数，离开 `playing` 立即回到 `null`。调用方
用它判断「播放真的健康了」，而不是把「地址取到了」当成成功 —— 后者会让重试退避永远
停留在第一档，形成固定间隔的重取风暴。

`suspension` 非空表示**浏览器主动拒绝了播放**，媒体本身已经就绪：

```ts
type PlaybackSuspensionReason = 'browser-suspended' | 'autoplay-blocked'
```

- `browser-suspended`：`play()` 抛 `AbortError`。Chrome 会在页面不可见时暂停静音的纯视频
  播放以省电，这不是流故障，重连没有意义。
- `autoplay-blocked`：`play()` 抛 `NotAllowedError`，需要一次用户手势。

两种情况都进入 `suspended` 状态，`setSource()` **正常 resolve**，已 commit 的候选源不会
被丢弃。传入 `pageActivity` 时页面重新可见会自动续播；否则调用方在用户手势里调用
`resume()`。

### `resume()`

在 `suspended` 状态下重试 `play()`。不处于挂起状态时是空操作。仍被拒绝则保持挂起，
等待下一次可见性变化或 `resume()`。

### `cancelRecovery(generation)`

撤回一次恢复请求：调用方查完发现这一路不需要换源时调用它，把这次恢复占用的次数还回去，
并清掉控制器级冷却。同时丢弃当前尚未发出的待发恢复。

只在**调用方决定不响应**这次请求时调用。正常响应恢复请求的方式仍然是 `setSource()`，
计数会在替换源产生首帧时清零，两条路径不要混用。

三种情况是空操作，不抛错：generation 不是当前代际、当前没有待撤回的恢复请求、控制器
已销毁。最后一条是刻意的：调用方常在异步查完之后才做决定，那时组件可能已经卸载。

撤回不改变连续性状态。流是否恢复由播放事件决定，控制器不会因为一次撤回就假定播放正常。

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
| `suspended`      | 浏览器拒绝播放（省电暂停或自动播放策略）        |
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
- `commit()` 只把 prepared source 设为隐藏候选，必须使用传入 generation 拒绝过期提交；
- 候选源产生首帧后，adapter 先原子替换可见媒体，再发出该 generation 的
  `first-frame`；
- `discard()` 必须幂等释放未提交、已过期或尚未出首帧的候选源；
- `destroy()` 释放当前可见媒体与所有内部候选，但 `discard()` 仍须能处理销毁后才返回的
  迟到 `PreparedSource`；
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
| `maxGapJumpSeconds`           |    `30` |
| `stallNudgeSeconds`           |   `0.1` |
| `maxStallSeeksPerSource`      |     `3` |

非法数值或互相矛盾的阈值会在创建时抛出
`InvalidContinuityPolicyError`。`reopenGraceMs` 已进入契约，但当前连续性 MVP 不负责把
平台状态判定为离线；调用方仍拥有最终离线展示时机。

## 卡顿先解救，再换源

重开一路源要花掉数秒，而相当一部分卡顿只是播放头需要挪一下。适配器可选实现
`seek(seconds)`，控制器在 `stall` 与 `latency` 两种恢复真正发起之前会先尝试解救：

- **缓冲出现空洞**：`getMetrics()` 返回 `strandedGapSeconds` 时，说明播放头落在两段缓冲
  之间的空洞里。这种情况尾距指标看起来很大，实际却永远等不到数据。控制器跳到下一段
  起点之后 `stallNudgeSeconds` 处；空洞超过 `maxGapJumpSeconds` 则放弃，交给换源。
- **段内冻结**：播放头仍在有效缓冲段内、前方也有数据却不前进时，推进
  `stallNudgeSeconds`。

每个源最多尝试 `maxStallSeeksPerSource` 次，用尽后按原路径请求恢复。解救成功后流自身的
`playing` 事件会取消待发的恢复请求；没能救活则在下一个防抖窗口继续，直到次数耗尽。
适配器未实现 `seek` 时该机制整体跳过，行为与之前一致。

## 恢复请求

```ts
interface ContinuityRecoveryRequest {
  readonly reason: 'stall' | 'latency' | 'playback-error' | 'source-timeout'
  readonly generation: number
  readonly attempt: number
}
```

恢复请求受 `recoveryCooldownMs` 和 `maxAutomaticRecoveries` 限制。短暂恢复播放不会清空
同一 generation 的恢复次数，也不会绕过控制器级冷却。但替换源产生首帧意味着上一次恢复
真的成功了，此时冷却计时一并清零：**成功的恢复不该继续节流后面一次不相干的故障**。
否则一路流在恢复后正常播放数秒、再次出问题时，会白等完整个冷却窗口才被处理。恢复 listener 调用 `setSource()`
时，计数会跨 generation 保留，直到替换源产生首帧才清零，因此连续换源失败无法绕过
上限。调用方通常在 listener 中重新解析签名和候选线路，再把选择结果交给
`setSource()`。

恢复请求不强制以 `setSource()` 收尾。调用方解析新线路要花时间，等结果回来时这一路可能
已经自己恢复了，此时换源反而是一次多余的黑屏。这种情况调用 `cancelRecovery(generation)`
把次数还回去：**没有真正发生的恢复不应该消耗恢复预算**。否则一路反复自愈的流会在播放
完全正常的情况下被推进 `waiting-reopen`。

## 错误

| 错误                                            | 条件                                          |
| ----------------------------------------------- | --------------------------------------------- |
| `ContractVersionMismatchError`                  | 调用方契约版本不匹配                          |
| `InvalidContinuityPolicyError`                  | 策略字段非法                                  |
| `SourceTransitionError`                         | `prepare`、`commit`、`discard` 或 `play` 失败 |
| `PreparedSourceGenerationMismatchError`         | adapter 返回了错误 generation                 |
| `InvalidPlaybackMetricsError`                   | adapter 返回了非法播放指标                    |
| `CapacityExceededError`                         | listener 或内部时钟句柄达到固定上限           |
| `LiveFlowError` / `playback-rate-update-failed` | adapter 拒绝播放速度更新                      |
| `LiveFlowError` / `controller-cleanup-failed`   | 销毁期间有 adapter 清理失败                   |

`SourceTransitionError` 暴露 phase、generation 和脱敏后的 `reason`，不保留上游 `cause`，
也不包含 `LiveSource.url`。`reason` 只取上游错误的类名（如 `NotSupportedError`），且必须
匹配 `/^[A-Za-z]{1,64}$/`，否则记为 `unknown` —— 上游 `message` 可能内嵌签名 URL，永远
不会传播。

被判定为挂起的 `AbortError` 与 `NotAllowedError` 不再抛 `SourceTransitionError`，改为进入
`suspended` 状态。

## 诊断

当前稳定诊断码包括：

- `stale-playback-event`
- `prepared-source-discarded`
- `prepared-source-cleanup-failed`
- `stall-detected`
- `stall-seek`
- `catchup-started`
- `catchup-stopped`
- `metrics-sample-failed`
- `invalid-playback-metrics`
- `playback-rate-update-failed`
- `nonrecoverable-playback-error`
- `recovery-requested`
- `recovery-cancelled`
- `recovery-exhausted`
- `recovery-listener-missing`
- `recovery-listener-failed`

同一诊断码最多每秒发出一次；控制器最多保留 32 个诊断码的速率状态。诊断 detail
只包含标量，不包含 source、URL 或原始播放器错误。

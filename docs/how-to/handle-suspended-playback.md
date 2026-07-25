# 处理被浏览器拒绝的播放

浏览器会在两种情况下拒绝 `play()`，它们都**不是**流故障，重连没有意义：

- **省电暂停**：Chrome 在页面不可见时暂停静音的纯视频播放，`play()` 抛 `AbortError`，
  消息大意是「video-only background media was paused to save power」；
- **自动播放策略**：没有用户手势且未静音时 `play()` 抛 `NotAllowedError`。

连续性控制器把这两种拒绝归入 `suspended` 状态：`setSource()` 正常 resolve，已经 commit
的候选源不会被丢弃，也不会消耗自动恢复次数。

## 自动续播

传入 `pageActivity`，页面重新可见时控制器自己重试 `play()`：

```ts
import { createContinuityController } from '@babywbx/liveflow/continuity'
import { createDocumentPageActivity } from '@babywbx/liveflow/page-activity'

const controller = createContinuityController({
  adapter,
  contractVersion: CONTRACT_VERSION,
  pageActivity: createDocumentPageActivity(),
})
```

`createDocumentPageActivity()` 只在 `subscribe()` 时才绑定 `visibilitychange`，最后一个
订阅者退订后自动解绑；订阅者上限 16，超限抛 `CapacityExceededError`。

需要自定义可见性来源（例如 IntersectionObserver 或宿主应用自己的前后台状态）时，实现
`PageActivitySource` 即可：

```ts
interface PageActivitySource {
  isHidden(): boolean
  subscribe(listener: (hidden: boolean) => void): () => void
}
```

## 需要用户手势时

`autoplay-blocked` 无法靠可见性恢复，必须由一次真实用户手势触发：

```ts
const snapshot = controller.getSnapshot()
if (snapshot.suspension?.reason === 'autoplay-blocked') {
  // 渲染一个「点击继续播放」按钮，并在其 click 处理里调用：
  await controller.resume()
}
```

`resume()` 在非挂起状态下是空操作；仍被拒绝则保持挂起，等待下一次机会。

## 不要把挂起当失败

调用方常见的错误是：看到播放没起来就重新取流地址、重建播放器。挂起状态下媒体已经就绪，
重建只会浪费带宽并可能触发上游限流。判断是否需要重连请读 `snapshot.state` 与
`snapshot.suspension`，判断播放是否真的健康请读 `snapshot.healthySince`。

相关参考：[连续性 API](../reference/continuity.md)、[错误](../reference/errors.md)。

# 配置过载与丢弃策略

LiveFlow 在过载时丢弃实时内容，不扩大队列。调整上限前，先观察 metrics 里的队列深度和
丢弃原因。

## 弹幕

```ts
const engine = createDanmakuEngine({
  contractVersion: CONTRACT_VERSION,
  renderer,
  viewport,
  limits: {
    maxPending: 120,
    maxVisible: 48,
    maxPoolSize: 64,
    maxIntakePerSecond: 90,
    maxDisplayPerSecond: 40,
    maxMountsPerFrame: 6,
  },
  policy: {
    maxPendingAgeMs: 6_000,
    maxLaneWaitMs: 1_500,
  },
})
```

先降低 `maxPendingAgeMs` 和 `maxLaneWaitMs`，避免旧消息积压；再按页面面积调整
`maxVisible`。`maxPoolSize` 必须不小于 `maxVisible`。不要只扩大 `maxPending`。

重点观察：

- `droppedByReason.inputRate`：输入速率超过单实例预算；
- `pendingCapacity`：队列饱和；
- `noLane`：页面轨道不足；
- `frameBudgetOverruns`：renderer 单帧成本过高。

## 实时事件

```ts
const overlay = createOverlayEngine({
  contractVersion: CONTRACT_VERSION,
  instanceId: 'primary',
  container,
  limits: {
    maxPending: 24,
    maxVisible: 1,
    maxDedupeEntries: 96,
    maxEventLifetimeMs: 20_000,
  },
})
```

高优先级事件会替换等待队列中的低优先级事件。去重表满时新键直接丢弃，不淘汰仍处于窗口的
旧键。

不要把 dropped 当成错误重放。它表示调用方提供的实时输入超过当前页面可平稳展示的预算。

# 为多播放器配置共享动画预算

每个 overlay 实例都有自己的有界队列，但页面总动画成本需要一个显式共享协调器。

```ts
const coordinator = createOverlayBudgetCoordinator({
  maxInstances: 9,
  maxActiveCards: 3,
  maxFullCards: 1,
  maxHighCostAnimations: 1,
})
```

把同一个 coordinator 交给页面内的所有实例：

```ts
const overlays = playerSlots.map((slot, index) =>
  createOverlayEngine({
    contractVersion: CONTRACT_VERSION,
    instanceId: slot.id,
    instanceState: {
      weight: playerSlots.length - index,
      focused: index === 0,
      visible: true,
    },
    coordinator,
    container: slot.overlay,
  }),
)
```

焦点变化时更新状态：

```ts
for (const [index, overlay] of overlays.entries()) {
  overlay.updateInstance({
    focused: index === focusedIndex,
    visible: visibleIndexes.has(index),
  })
}
```

协调器会在 `full`、`compact` 和 `suppressed` 之间重新分配已有卡片。应用不需要销毁并重建
播放器或 overlay 实例。

页面卸载顺序：

```ts
for (const overlay of overlays) {
  overlay.destroy()
}
coordinator.destroy()
```

销毁后 `registeredInstances`、`activeCards`、`activeFull` 和 `activeHighCost` 都应为零。

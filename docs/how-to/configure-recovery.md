# 配置弱网恢复策略

连续性策略在创建控制器时一次性传入。只覆盖需要改变的字段，其余字段使用保守默认值。

```ts
const controller = createContinuityController({
  adapter,
  contractVersion: CONTRACT_VERSION,
  policy: {
    targetLatencySeconds: 2,
    softCatchupThresholdSeconds: 0.8,
    catchupRate: 1.03,
    hardResyncThresholdSeconds: 9,
    recoveryCooldownMs: 30_000,
    maxAutomaticRecoveries: 4,
  },
  onRecoveryRequest(request) {
    queueSourceRefresh(request)
  },
})
```

## 调整柔性追帧

`targetLatencySeconds + softCatchupThresholdSeconds` 是开始柔性追帧的边界。缓冲安全时，
控制器把播放速度提高到 `catchupRate`；回到目标尾距后恢复 `1.0x`。

`catchupRate` 不宜为了快速追赶而大幅提高。过高速度会造成听感明显变化，也会快速消耗前向
缓冲。

## 调整硬恢复

尾距持续超过 `hardResyncThresholdSeconds` 时，控制器发出 `latency` 恢复请求。LiveFlow
不会自己选择 CDN 或画质；listener 重新解析候选源后调用 `setSource()`。

`recoveryCooldownMs` 限制恢复频率，`maxAutomaticRecoveries` 限制一条连续恢复链的尝试
次数。换源失败不会重置次数，只有替换 generation 真正产生首帧才算恢复成功。

## 处理恢复请求

listener 应快速返回，把解析工作交给调用方自己的异步流程：

```ts
onRecoveryRequest(request) {
  void refreshSource(request).then((source) => controller.setSource(source))
}
```

刷新失败必须由调用方记录并决定是否重试。不要在 listener 中建立无上限循环；控制器的恢复
次数只约束它发出的请求，不能约束调用方自行创建的任务。

解析结果回来时这一路可能已经自己恢复了。这种情况不要调用 `setSource()`，改为撤回：

```ts
void refreshSource(request).then((source) => {
  if (controller.getSnapshot().state === 'playing') {
    controller.cancelRecovery(request.generation)
    return
  }
  void controller.setSource(source)
})
```

撤回把这次占用的恢复次数还回去，并清掉冷却。漏掉这一步时，一路反复自愈的流会在播放
完全正常的情况下耗尽 `maxAutomaticRecoveries` 并进入 `waiting-reopen`。

## 平台离线判断

连续性状态中的 `degraded`、`recovering` 和 `waiting-reopen` 都不代表主播离线。平台状态
仍由调用方的状态源决定，不能用媒体错误直接结束直播场次。

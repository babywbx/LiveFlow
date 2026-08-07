# 弹幕调度参考

`@babywbx/liveflow/danmaku` 提供与平台协议和 DOM 解耦的实时弹幕调度器。调度器只接收调用方
已经投影为通用模型的消息，并负责有界排队、限速、轨道防碰撞、暂停与恢复。

## 创建引擎

```ts
import { CONTRACT_VERSION } from '@babywbx/liveflow'
import { createDanmakuEngine, type DanmakuRenderer } from '@babywbx/liveflow/danmaku'

const engine = createDanmakuEngine({
  contractVersion: CONTRACT_VERSION,
  renderer,
  viewport: { width: 1280, height: 720 },
  onDiagnostic(event) {
    reportDiagnostic(event.code)
  },
})
```

`renderer` 是唯一渲染接缝。核心在每帧先通过 `measure()` 批量测量候选消息，再通过一次
`render()` 交付挂载、位移和卸载命令。调用方不需要也不应为每条消息建立独立动画循环。

`contractVersion` 必须等于根入口导出的 `CONTRACT_VERSION`。创建时不匹配会立即抛出
`ContractVersionMismatchError`，不会尝试兼容猜测或创建调度资源。

传入 `clock` 可以替换单调时钟，主要用于确定性测试。自定义时钟的 `now()` 不得倒退。

## `DanmakuEngine`

```ts
interface DanmakuEngine {
  push(message: DanmakuMessage): DanmakuPushResult
  getMetrics(): DanmakuMetrics
  pause(): void
  resume(): void
  resize(viewport: DanmakuViewport, policy?: Partial<DanmakuPolicy>): void
  destroy(): void
}
```

- `push()` 同步校验并复制输入。返回 `accepted: true` 表示消息进入有界等待队列；不保证最终
  一定展示，因为消息仍可能过期或因持续无可用轨道而丢弃。
- `getMetrics()` 返回计数器快照，不暴露内部可变集合。
- `pause()` 停止唯一的帧调度器；重复暂停安全。
- `resume()` 平移可见消息和等待消息的时间基准，暂停时间不会消耗展示时长。
- `resize()` 立即更新视口和轨道数量。缩小视口时，超出新轨道范围的可见消息会被卸载。
  传入第二个参数可同时改写策略，常见于字号变化导致轨道高度必须跟着变：省去销毁重建引擎，
  在途消息除放不下的以外都会保留。省略该参数时沿用当前策略；非法数值照常抛
  `InvalidDanmakuConfigurationError`。
- `destroy()` 取消帧任务并清空全部有界集合。重复销毁安全。销毁后的其他调用会抛错。

引擎在空闲且没有等待消息时不申请动画帧。

## 消息模型

```ts
interface DanmakuMessage {
  id: string
  receivedAt: number
  text: string
  mode: 'scroll' | 'top' | 'bottom'
  priority: number
  color?: string
  sender?: {
    displayName?: string
  }
  identities?: readonly DanmakuIdentity[]
  metadata?: Readonly<Record<string, unknown>>
}

interface DanmakuIdentity {
  kind: string
  label: string
  level?: number
  variant?: string
  assetKey?: string
}
```

`id` 在一条消息处于等待或可见状态期间应当唯一。`receivedAt` 只参与同优先级消息的稳定
排序；内部过期、限速和动画始终使用注入的单调时钟。

`kind`、`variant` 和 `assetKey` 都是调用方定义的无平台语义字符串。多个身份保持为独立
节点；引擎不会从某种身份推断另一种身份，也不会让身份等级改变整条正文的颜色。

正文颜色只接受 `#rgb` 或 `#rrggbb`。其他颜色被省略并产生限频诊断。DOM 渲染器还会独立
执行对比度检查。

## 输入清洗

下列结构错误会抛出 `InvalidDanmakuMessageError`：

- 空或过长的 `id`；
- 非有限数或负数的 `receivedAt`；
- 空正文、未知模式或非整数优先级；
- 越界的昵称、身份字段、等级或资源键。

正文超过 `maxTextLength` 时不进入队列，`push()` 返回 `text-too-long`。

身份数量超过 `maxBadgesPerMessage` 时稳定保留最前面的身份，其余身份被省略并产生诊断。

`metadata` 只允许有限数、字符串、布尔值、`null`、数组和普通记录。引擎递归复制并检查：

- 总键数；
- 最大嵌套深度；
- UTF-8 JSON 字节数。

循环引用、读取异常、非法值或任一预算超限时，只省略整块 `metadata`，不会丢弃正文；
`metadataDiscarded` 指标随之增加。引擎本身从不读取清洗后的 metadata。

## 默认上限

| 字段                  | 默认值 |
| --------------------- | -----: |
| `maxPending`          |    200 |
| `maxVisible`          |     80 |
| `maxPoolSize`         |     96 |
| `maxTextLength`       |    500 |
| `maxBadgesPerMessage` |      4 |
| `maxMountsPerFrame`   |      8 |
| `maxMetadataKeys`     |     16 |
| `maxMetadataDepth`    |      2 |
| `maxMetadataBytes`    |   2048 |
| `maxIntakePerSecond`  |    120 |
| `maxDisplayPerSecond` |     60 |

`maxPoolSize` 不得小于 `maxVisible`。所有上限必须是正安全整数。

## 默认调度策略

| 字段                    |   默认值 | 含义                                       |
| ----------------------- | -------: | ------------------------------------------ |
| `laneHeight`            |    32 px | 轨道基准高度                               |
| `laneGap`               |    12 px | 同轨滚动消息的最小安全距离                 |
| `scrollPixelsPerSecond` | 140 px/s | 滚动速度                                   |
| `fixedDurationMs`       |  4000 ms | 顶部和底部消息的展示时长                   |
| `maxPendingAgeMs`       |  8000 ms | 最长等待时间                               |
| `maxLaneWaitMs`         |  2000 ms | 因无轨道、显示限速或可见上限等待的最长时间 |
| `duplicateWindowMs`     |   500 ms | 普通短消息去重窗口                         |
| `frameBudgetMs`         |     8 ms | 单帧预算诊断阈值                           |

顶部、底部和滚动消息共享物理轨道占用检查，因此不会在同一垂直区域互相覆盖。顶部消息从
上向下选择轨道，底部消息从下向上选择轨道。滚动消息只有在前一条尾部越过安全距离后才会
进入相同轨道。

等待队列满时，引擎先比较优先级，再使用由消息 ID 计算的稳定采样顺序。高优先级消息可以
替换较低优先级消息；相同输入集合产生相同的普通消息保留结果。队列绝不会因突发输入扩容。

## 指标

`getMetrics()` 返回：

- `received`：通过基本结构校验、进入接收处理的数量；
- `displayed`：成功分配轨道并挂载的数量；
- `dropped`：全部丢弃数量；
- `pendingDepth`、`visible`：当前等待深度和可见数量；
- `frameBudgetOverruns`：单帧超过预算的次数；
- `metadataDiscarded`：被清洗掉的 metadata 数量；
- `droppedByReason`：按重复、过期、限速、容量、轨道和测量失败分类的计数。

## 错误与诊断

配置无效抛出 `InvalidDanmakuConfigurationError`，消息结构无效抛出
`InvalidDanmakuMessageError`，时钟倒退抛出 `NonMonotonicDanmakuClockError`。渲染器同步
调用失败会转换为 `DanmakuRendererError`；帧回调中的失败会停止后续调度，并通过
`renderer-failed` 诊断显式上报，下一次公开调用会抛出保存的错误。

诊断使用共享的 `DiagnosticEvent`，固定包含 `scope: 'danmaku'`、稳定 `code` 和 `level`。
可选 `detail` 只包含受限的标量字段，不会暴露原消息或 metadata。诊断按代码每秒最多上报
一次，诊断代码表最多保留 16 项。诊断回调自身抛错不会破坏引擎。

## 浏览器基线

调度核心可以在无 DOM 的环境导入。DOM 渲染路径支持 Chrome / Edge 111、Safari / iOS
Safari 16.4 和 Firefox 128。

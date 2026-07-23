# Realtime Overlay API

本文是 LiveFlow 实时事件叠加层的接口参考，面向需要展示付费留言、礼物、身份里程碑和
自定义结构事件的前端开发者。它不描述平台字段投影、普通弹幕轨道、礼物素材获取或播放器
UI。

## 入口

```ts
import {
  CONTRACT_VERSION,
  createOverlayBudgetCoordinator,
  createOverlayEngine,
} from '@babywbx/liveflow/overlay'
```

叠加层必须从 `@babywbx/liveflow/overlay` 子路径加载。模块求值时不会访问 DOM、创建
计时器或注册全局监听器。

## 创建事件引擎

```ts
const overlay = createOverlayEngine({
  contractVersion: CONTRACT_VERSION,
  instanceId: 'primary-player',
  clock,
  container,
})
```

创建时校验 `contractVersion`。版本不匹配会立即抛出
`ContractVersionMismatchError`，不会进入逐事件热路径。

### `OverlayEngineOptions`

| 字段              | 类型                       | 必填 | 说明                                       |
| ----------------- | -------------------------- | ---- | ------------------------------------------ |
| `contractVersion` | `number`                   | 是   | 调用方编译时绑定的 `CONTRACT_VERSION`      |
| `instanceId`      | `string`                   | 是   | 协调器中的稳定实例标识                     |
| `clock`           | `Clock`                    | 否   | 与 `receivedAt` 同一时间域的可注入单调时钟 |
| `instanceState`   | `OverlayInstanceState`     | 否   | 初始权重、焦点和可见性                     |
| `coordinator`     | `OverlayBudgetCoordinator` | 否   | 页面级显式共享的跨实例预算                 |
| `limits`          | `Partial<OverlayLimits>`   | 否   | 覆盖引擎默认上限                           |
| `defaultRenderer` | `OverlayRenderer`          | 条件 | 没有 `container` 时必须提供                |
| `container`       | `HTMLElement`              | 条件 | 创建默认安全 renderer 的挂载容器           |
| `assetResolver`   | `AssetResolver`            | 否   | 默认 renderer 的 `assetKey → URL` 解析器   |
| `onError`         | `(error: Error) => void`   | 否   | 接收调度、渲染和清理错误                   |
| `onDiagnostic`    | `(event) => void`          | 否   | 接收有速率限制的结构化诊断                 |

省略 `clock` 时使用浏览器的 `performance.now()` 与 `setTimeout()`。`container` 和
`defaultRenderer` 至少提供一个。引擎拥有默认 renderer 以及通过 `registerRenderer()`
注册的 renderer，并在销毁时统一释放。空闲且无事件时不创建持续 RAF。

## 结构事件

```ts
interface RealtimeOverlayEvent {
  id: string
  dedupeKey?: string
  kind: string
  receivedAt: number
  priority: number
  durationMs: number
  nodes: readonly OverlayNode[]
}
```

`receivedAt` 必须来自注入时钟的时间域，不得是 Unix 墙钟。`durationMs` 同时受正数校验和
`maxEventLifetimeMs` 上限约束。

`OverlayNode` 有四种结构：

```ts
type OverlayNode =
  | { type: 'text'; role: string; text: string }
  | { type: 'identity'; identity: DanmakuIdentity }
  | { type: 'asset'; role: string; assetKey: string; alt: string }
  | { type: 'metric'; role: string; label: string; value: string }
```

LiveFlow 不解释 `kind`、`role` 或身份语义。平台 adapter 负责把原始字段投影成这些节点，
不得把整条事件重新拼成约定格式的文本。

### 合成事件示例

付费留言：

```ts
overlay.submit({
  id: 'paid-1',
  kind: 'paid-message',
  receivedAt: clock.now(),
  priority: 80,
  durationMs: 8_000,
  nodes: [
    { type: 'identity', identity: { kind: 'member', label: '示例成员' } },
    { type: 'metric', role: 'value', label: '支持', value: '99' },
    { type: 'text', role: 'body', text: '这是一条合成留言。' },
  ],
})
```

礼物：

```ts
overlay.submit({
  id: 'gift-1',
  dedupeKey: 'gift-sequence-1',
  kind: 'gift',
  receivedAt: clock.now(),
  priority: 40,
  durationMs: 4_000,
  nodes: [
    { type: 'text', role: 'name', text: '合成礼物' },
    { type: 'metric', role: 'quantity', label: '数量', value: '3' },
  ],
})
```

身份里程碑：

```ts
overlay.submit({
  id: 'milestone-1',
  kind: 'milestone',
  receivedAt: clock.now(),
  priority: 20,
  durationMs: 3_000,
  nodes: [{ type: 'identity', identity: { kind: 'supporter', label: '新里程碑', level: 2 } }],
})
```

这些示例只包含合成数据，不对应任何平台协议或真实用户。

## `OverlayEngine`

### `submit(event)`

同步校验并复制结构事件，返回以下状态之一：

| 状态        | 含义                                 |
| ----------- | ------------------------------------ |
| `displayed` | 已获得预算并开始展示                 |
| `queued`    | 已进入有界等待队列                   |
| `deduped`   | 同一去重键仍在窗口内                 |
| `expired`   | 事件到达时已经超过最大生命周期       |
| `dropped`   | 队列、去重表或跨实例预算没有可用容量 |

非法字段抛出 `InvalidOverlayEventError`。引擎不会截断、猜测或把非法事件转换成空卡片。

等待队列满时，新事件只有在优先级严格高于当前最低优先级事件时才会替换它。历史积压到期后
直接丢弃，不通过缩短展示时长或加速动画追赶。

没有 `dedupeKey` 时使用带命名空间的 `id` 作为去重键。去重表达到固定容量时，新键会被
丢弃，而不是淘汰仍在窗口内的旧键。

### `registerRenderer(kind, renderer)`

为一个 `kind` 注册 renderer，返回幂等退订句柄。同一 `kind` 不能重复注册；达到
`maxRenderers` 后抛出 `OverlayCapacityError`。

退订会停止后续路由，但 renderer 仍由引擎持有到 `destroy()`，避免正在展示的卡片被提前
破坏。renderer 注册总量在引擎生命周期内同样受 `maxRenderers` 限制。

未注册 `kind` 使用默认安全 renderer。

### `updateInstance(state)`

更新实例权重、焦点或可见性，并同步给共享预算协调器。焦点和权重变化会重新分配已有
`full` / `compact` grant；隐藏实例的活跃 grant 会变为 `suppressed` 并立即释放全局预算。

### `getMetrics()`

同步返回累计计数和当前深度：

```ts
interface OverlayMetrics {
  received: number
  accepted: number
  displayed: number
  fullDisplayed: number
  compactDisplayed: number
  deduped: number
  expired: number
  dropped: number
  budgetDenied: number
  renderFailed: number
  pendingDepth: number
  visible: number
}
```

### `destroy()`

取消全部展示计时器，销毁活跃卡片、预算 grant、实例注册和所有 renderer，并清空队列与
去重表。重复调用安全。清理步骤会全部尝试；任一步失败时，完成其余清理后抛出
`OverlayCleanupError`。

## Renderer

```ts
interface OverlayRenderer {
  render(event: RealtimeOverlayEvent, presentation: OverlayPresentation): Destroyable
  destroy(): void
}
```

`render()` 返回当前卡片的幂等销毁句柄。共享预算发生变化时，引擎会销毁旧句柄，再用新的
`presentation` 重新渲染同一结构事件。

`createSafeOverlayRenderer(container, options)` 提供默认 DOM 实现：

- 所有上游文本只写入 `textContent`；
- 不接受 HTML；
- `compact` 只渲染第一个结构节点；
- `asset` 只能通过调用方的 `AssetResolver` 获取 URL；
- 解析器缺失或返回 `null` 时省略整个资源节点；
- 解析结果只接受相对或绝对的 HTTP、HTTPS 与 Blob URL；非法 URL、其他协议或 resolver
  抛错时同样省略资源节点；
- renderer 不注入样式，也不在模块求值时访问 DOM。

自定义 renderer 必须遵守相同的文本、资源和销毁约束。

## 跨实例预算

协调器必须由页面显式创建和共享，不存在模块级全局单例：

```ts
const coordinator = createOverlayBudgetCoordinator({
  maxInstances: 9,
  maxActiveCards: 3,
  maxFullCards: 1,
  maxHighCostAnimations: 1,
})
```

### 注册实例

```ts
const registration = coordinator.register({
  instanceId: 'primary-player',
  weight: 10,
  focused: true,
  visible: true,
})

registration.update({ focused: false })
registration.destroy()
```

实例表固定受 `maxInstances` 限制。重复 ID、非法权重或超过容量会抛出类型化错误。

### 申请 grant

```ts
const grant = coordinator.request('primary-player', {
  priority: 80,
  highCost: false,
})
```

`grant.presentation` 为：

| 值           | 含义                                 |
| ------------ | ------------------------------------ |
| `full`       | 完整卡片，占用一个活跃卡和完整卡预算 |
| `compact`    | 紧凑提示，只占用一个活跃卡预算       |
| `suppressed` | 不展示，不占用任何活跃预算           |

协调器按焦点、调用方权重、事件优先级和申请顺序排序。完整 grant 同时受
`maxFullCards` 与 `maxHighCostAnimations` 限制；其余可见实例在活跃卡预算内降为
`compact`。页面隐藏、实例退订或协调器销毁会回收其活跃 grant。

`grant.subscribe(listener)` 监听已有 grant 的展示级别变化，最多允许 8 个 listener。
`grant.destroy()` 幂等释放预算。

### 预算指标

`getMetrics()` 返回：

```ts
interface OverlayBudgetMetrics {
  requests: number
  fullGranted: number
  compactGranted: number
  suppressed: number
  promoted: number
  downgraded: number
  released: number
  registeredInstances: number
  activeCards: number
  activeFull: number
  activeHighCost: number
}
```

`activeCards` 永远不超过 `maxActiveCards`，`activeFull` 永远不超过 `maxFullCards`，
`activeHighCost` 永远不超过 `maxHighCostAnimations`。

## 默认上限

| 字段                 | 默认值 |
| -------------------- | -----: |
| `maxPending`         |     32 |
| `maxVisible`         |      1 |
| `maxNodesPerEvent`   |      8 |
| `maxTextLength`      |    512 |
| `maxLabelLength`     |     64 |
| `maxKeyLength`       |    128 |
| `maxRenderers`       |     32 |
| `maxDedupeEntries`   |    128 |
| `dedupeWindowMs`     |  15000 |
| `maxEventLifetimeMs` |  30000 |

所有数字都在创建时校验。非法、非有限、非正数或相互矛盾的预算会抛出
`InvalidOverlayConfigurationError`。

## 错误

| 错误                               | 条件                                |
| ---------------------------------- | ----------------------------------- |
| `ContractVersionMismatchError`     | 调用方契约版本不匹配                |
| `InvalidOverlayEventError`         | 事件或结构节点字段非法              |
| `InvalidOverlayConfigurationError` | 上限、实例状态或协调器请求非法      |
| `OverlayCapacityError`             | renderer、listener 或实例表达到上限 |
| `OverlayDestroyedError`            | 销毁后继续操作引擎、协调器或注册    |
| `OverlayRenderError`               | renderer 抛错；通过 `onError` 报告  |
| `OverlaySchedulingError`           | 展示计时器或 grant 监听注册失败     |
| `OverlayCleanupError`              | 销毁或卡片回收期间有清理步骤失败    |

渲染和调度错误会增加非正常指标，并通过 `onError` 报告；不会伪装成成功展示。错误不包含
结构节点内容、资源 URL、Cookie 或 token。

## 诊断

当前稳定诊断码包括：

- `overlay-event-deduped`
- `overlay-event-expired`
- `overlay-event-dropped`
- `overlay-budget-suppressed`
- `overlay-presentation-changed`
- `overlay-render-failed`
- `overlay-scheduling-failed`
- `overlay-cleanup-failed`

所有事件的 `scope` 均为 `overlay`。同一诊断码最多每秒发出一次，最多保留 32 个诊断码
的速率状态。detail 只使用 `reason` 或 `presentation` 等有界标量，不包含事件节点和资源
URL。诊断回调抛错不会改变引擎状态。

## 与普通弹幕的关系

实时事件引擎不导入、提交或检查普通弹幕队列。普通滚动弹幕拥有独立的队列、轨道和生命周期，
不会因为事件卡等待预算而阻塞。调用方如需更高层的页面资源协调，应在两个独立引擎之外组合。

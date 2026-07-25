<div align="center"><a name="readme-top"></a>

# LiveFlow

浏览器侧直播播放连续性与实时叠加层工具库。<br/>
媒体连续性、结构化弹幕、实时事件卡，三个互相独立的有界引擎。

[English](./README.en.md) · [报告问题][github-issues-link] · [更新日志][changelog-link] · [文档][docs-link]

<!-- SHIELD GROUP -->

[![][github-stars-shield]][github-stars-link]
[![][github-forks-shield]][github-forks-link]
[![][github-issues-shield]][github-issues-link]
[![][github-license-shield]][github-license-link]<br/>
[![][github-contributors-shield]][github-contributors-link]
[![][github-lastcommit-shield]][github-lastcommit-link]
[![][github-ci-shield]][github-ci-link]
[![][node-shield]][node-link]

</div>

<details>
<summary><kbd>目录</kbd></summary>

#### TOC

- [✨ 特性](#-特性)
- [📋 边界](#-边界)
- [📦 安装](#-安装)
- [🚀 快速开始](#-快速开始)
- [🧩 入口](#-入口)
- [📖 接口](#-接口)
- [🔧 配置](#-配置)
- [🔍 关键行为](#-关键行为)
- [🌐 浏览器基线](#-浏览器基线)
- [📚 文档](#-文档)
- [🛠 开发](#-开发)
- [❓ 常见问题](#-常见问题)
- [📝 许可证](#-许可证)

####

<br/>

</details>

## ✨ 特性

- **无闪烁换源。** 候选媒体实例隐藏预热，由 generation 计数器门禁，首帧到达时原子交接，失败
  则回退到原实例。
- **播放连续性。** 柔性追帧、卡顿防抖，恢复请求受冷却时间和硬性次数上限双重约束。
- **结构化弹幕。** 灯牌、等级、昵称和正文各自保持独立 DOM 节点，身份语义不会被拍平成一段
  格式化文本。
- **有界实时事件。** 优先级、去重、过期、按 `kind` 注册的 renderer registry，以及一个不使用
  `innerHTML` 的安全 DOM renderer。
- **跨实例预算。** 四路或九路播放网格通过页面显式创建的协调器，共享完整卡片与高成本动画的
  全局上限。
- **天然延迟加载。** 根入口、三个引擎和两个播放器 adapter 都是独立 ESM 子路径，用户不开始
  播放就不下载任何一个。
- **零运行时依赖。** 模块求值不触碰 DOM、计时器和全局对象，因此在服务端渲染环境导入核心入口
  是安全的。

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 📋 边界

LiveFlow 解决两类问题：在弱网、短断流、换线路、换画质和媒体代际变化时让直播播放尽量连续；
以及在直播画面上以有界、可扩展的方式展示实时弹幕和结构化事件卡。

它不绑定任何播放器。原生 `<video>` 与 ArtPlayer-like seam 只是两个可选 adapter，位于同一个
`LivePlayerAdapter` 接口之后。

**非目标。** LiveFlow 不实现推流、转码、录制、媒体分发、取流地址解析、平台签名、平台弹幕
协议、后端代理、消息持久化、HLS / FLV / DASH 解码、完整播放器 UI、礼物素材，也不承担框架层的
状态管理。平台状态始终属于调用方，由调用方投影成下文的通用模型。

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 📦 安装

LiveFlow 从 Git 仓库分发，不发布到 npm。构建产物 `dist/` 已提交进仓库，因此以 Git 依赖安装时
消费方不需要任何安装期构建步骤。

依赖声明保持跟踪 `main`：

```json
{
  "dependencies": {
    "@babywbx/liveflow": "git+https://github.com/babywbx/LiveFlow.git#main"
  }
}
```

```bash
pnpm install
```

锁文件会记录本次解析到的准确提交，因此冻结安装不会自行漂移。需要跟进上游时显式升级：

```bash
pnpm update @babywbx/liveflow   # 验证应用后提交锁文件
pnpm install --frozen-lockfile  # 生产与 CI
```

> \[!IMPORTANT\]
> 依赖声明保持 `#main`。声明负责表达跟踪策略，锁文件负责记录已验证的实际提交；把声明手工改写
> 成某个 commit SHA 会破坏这个分工。

完整说明见[以 Git 依赖安装](./docs/how-to/install-from-git.md)。

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 🚀 快速开始

### 原生 `<video>` 连续性

用户真正开始播放之前，不下载任何模块：

```ts
async function startLive(video: HTMLVideoElement, url: string): Promise<void> {
  const [{ CONTRACT_VERSION }, continuity, nativeVideo] = await Promise.all([
    import('@babywbx/liveflow'),
    import('@babywbx/liveflow/continuity'),
    import('@babywbx/liveflow/native-video'),
  ])

  const adapter = nativeVideo.createNativeVideoAdapter({ video })
  const controller = continuity.createContinuityController({
    adapter,
    contractVersion: CONTRACT_VERSION,
    onRecoveryRequest(request) {
      void resolveFreshSource(request).then((source) => controller.setSource(source))
    },
  })

  await controller.setSource({ url, kind: 'live' })
}
```

切换画质、切换线路、刷新签名和媒体代际变化，全部通过 `setSource()` 开启新的 generation。接口
里没有 `setQuality()` 或 `setCdn()`，线路解析权始终属于调用方。

### 结构化弹幕

```ts
const [{ CONTRACT_VERSION }, danmaku, dom] = await Promise.all([
  import('@babywbx/liveflow'),
  import('@babywbx/liveflow/danmaku'),
  import('@babywbx/liveflow/danmaku/dom'),
])

const renderer = dom.createDomDanmakuRenderer({
  container,
  backgroundColor: '#000000',
  assetResolver: { resolve: (assetKey) => assets.get(assetKey) ?? null },
})

const engine = danmaku.createDanmakuEngine({
  contractVersion: CONTRACT_VERSION,
  renderer,
  viewport: { width: 1280, height: 720 },
})

engine.push({
  id: 'message-1',
  receivedAt: performance.now(),
  text: '这是一条合成消息。',
  mode: 'scroll',
  priority: 0,
  sender: { displayName: '合成观众' },
  identities: [{ kind: 'member', label: '合成灯牌', level: 7 }],
})
```

### 实时事件卡

```ts
const { CONTRACT_VERSION, createOverlayEngine } = await import('@babywbx/liveflow/overlay')

const overlay = createOverlayEngine({
  contractVersion: CONTRACT_VERSION,
  instanceId: 'primary-player',
  container,
})

overlay.submit({
  id: 'paid-1',
  kind: 'paid-message',
  receivedAt: performance.now(),
  priority: 80,
  durationMs: 8_000,
  nodes: [
    { type: 'identity', identity: { kind: 'member', label: '合成成员' } },
    { type: 'metric', role: 'value', label: '支持', value: '99' },
    { type: 'text', role: 'body', text: '这是一条合成留言。' },
  ],
})
```

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 🧩 入口

每个引擎和 adapter 都是独立 ESM 子路径。根入口只导出共享契约，绝不静态加载引擎或播放器运行时。

| 子路径                            | 内容                                     |   gzip | 预算 |
| --------------------------------- | ---------------------------------------- | -----: | ---: |
| `@babywbx/liveflow`               | `CONTRACT_VERSION`、共享类型与类型化错误 |      — |    — |
| `@babywbx/liveflow/continuity`    | 连续性控制器与播放器 adapter 契约        | 4.1 KB | 6 KB |
| `@babywbx/liveflow/danmaku`       | 有界弹幕调度核心                         | 4.9 KB | 7 KB |
| `@babywbx/liveflow/danmaku/dom`   | 安全结构化 DOM renderer 与颜色工具       | 2.8 KB | 4 KB |
| `@babywbx/liveflow/overlay`       | 实时事件引擎与共享预算协调器             | 5.6 KB | 8 KB |
| `@babywbx/liveflow/chrome`        | 播放器控件显隐控制器（空闲隐藏与常驻）   | 1.4 KB | 2 KB |
| `@babywbx/liveflow/multiview`     | 多路宫格布局数学与网格轨道声明           | 0.9 KB | 2 KB |
| `@babywbx/liveflow/native-video`  | 原生 `<video>` adapter                   | 3.0 KB | 4 KB |
| `@babywbx/liveflow/page-activity` | 页面可见性来源（省电暂停续播）           | 0.5 KB | 2 KB |
| `@babywbx/liveflow/artplayer`     | 零静态播放器依赖的 ArtPlayer-like seam   | 3.0 KB | 4 KB |

体积由 `pnpm size:check` 压缩后 gzip 实测，超过预算列即 CI 失败。四个核心子路径合并实测
15.7 KB，冻结上限 20 KB。

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 📖 接口

### 共享契约 —— `@babywbx/liveflow`

```ts
import { CONTRACT_VERSION, LiveFlowError } from '@babywbx/liveflow'
```

`CONTRACT_VERSION` 当前为 `1`。每个引擎工厂都接收它，创建时不匹配立即抛出
`ContractVersionMismatchError`，运行时不做任何兼容猜测。

根入口同时导出 `Clock`、`Destroyable` / `AsyncDestroyable`、`DiagnosticEvent` 和共享错误类：

```ts
interface Clock {
  now(): number
  setTimeout(handler: () => void, delayMs: number): number
  clearTimeout(handle: number): void
  requestFrame(handler: (timestampMs: number) => void): number
  cancelFrame(handle: number): void
}

interface DiagnosticEvent {
  scope: 'continuity' | 'danmaku' | 'overlay'
  code: string
  level: 'debug' | 'info' | 'warn'
  generation?: number
  detail?: Readonly<Record<string, string | number | boolean>>
}
```

`now()` 必须单调不倒退。诊断是限频的运行状态信号，不是逐消息数据管道；`detail` 只承载受限
标量，不含媒体 URL、原始消息或平台 payload。参考：[共享契约](./docs/reference/shared.md)、
[指标与诊断码](./docs/reference/diagnostics.md)。

### 连续性 —— `@babywbx/liveflow/continuity`

```ts
import { createContinuityController } from '@babywbx/liveflow/continuity'

interface ContinuityController {
  setSource(source: LiveSource): Promise<void>
  getSnapshot(): ContinuitySnapshot
  subscribe(listener: ContinuitySnapshotListener): () => void
  destroy(): Promise<void>
}
```

| 字段                | 类型                        | 必填 | 说明                                  |
| ------------------- | --------------------------- | ---- | ------------------------------------- |
| `adapter`           | `LivePlayerAdapter`         | 是   | 由控制器拥有，随控制器一起销毁        |
| `contractVersion`   | `number`                    | 是   | 调用方编译时绑定的 `CONTRACT_VERSION` |
| `clock`             | `Clock`                     | 否   | 单调时钟，省略时使用浏览器时钟        |
| `policy`            | `Partial<ContinuityPolicy>` | 否   | 覆盖保守默认策略                      |
| `onRecoveryRequest` | `(request) => void`         | 否   | 请求调用方解析并提交新源              |
| `onDiagnostic`      | `(event) => void`           | 否   | 接收有速率限制的结构化诊断            |

`setSource()` 先让 generation 加一，再依次执行 `prepare()` → `commit()` → `play()`，并等待本代的
`first-frame` 事件。返回的 Promise 在 `play()` 完成后结束，不等待首帧。整段预热共享同一个
`sourceWarmupTimeoutMs` 超时；迟到的 prepared source 会被 discard，永远无法提交。

`getSnapshot()` 返回 `{ state, generation, automaticRecoveryCount }`，刻意不包含媒体 URL，避免
签名参数泄露进 UI 状态或诊断。`subscribe()` 最多保留 32 个不同 listener，超出抛出
`CapacityExceededError`；listener 抛错不会改变控制器状态。

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

> \[!NOTE\]
> `ERROR` 不等于主播离线。连续性状态不解释平台状态，也不会修改调用方的平台状态。

恢复请求携带 `{ reason, generation, attempt }`，其中 `reason` 为 `'stall' | 'latency' |
'playback-error' | 'source-timeout'`。恢复次数跨 generation 保留，直到替换源真正产生首帧才清零，
因此连续换源失败无法绕过上限。参考：[Continuity API](./docs/reference/continuity.md)。

### 播放器适配器 —— `LivePlayerAdapter`

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

适配器必须遵守：`prepare()` 不替换当前可见媒体；`commit()` 用传入 generation 拒绝过期提交；先
原子显示候选实例，**再**发出 `first-frame`；`discard()` 与 `destroy()` 幂等；每个 `PlaybackEvent`
都带产生它的 generation；错误中不出现完整签名 URL、Cookie 或 token。

库内提供两个实现：

```ts
import { createNativeVideoAdapter } from '@babywbx/liveflow/native-video'
import { createArtPlayerAdapter } from '@babywbx/liveflow/artplayer'
```

`createNativeVideoAdapter({ video })` 在同一父节点创建隐藏候选 video，复制 `controls`、
`playsInline` 和 `className`，首帧时交换可见性 —— 浏览器支持 `requestVideoFrameCallback` 时使用
真实帧回调，否则退回 `playing` 事件。候选实例在交接前始终静音，避免新旧实例同时出声。调用方
保留传入节点的 DOM 所有权，适配器创建的节点则一律由适配器删除。

`createArtPlayerAdapter({ player, createPlayer })` 不静态导入任何播放器包。调用方提供一个很小的
`ArtPlayerLike` 包装（底层 `video`、`on` / `off`、`setMutex(false)`、`destroy()`，以及可选的
`container` 与 `overlayContainer`），外加一个每次返回独立实例的工厂。两个适配器都支持注入自定义
surface，其 `reveal` 必须同步且原子。参考：[播放器适配器](./docs/reference/adapters.md)、
[实现自定义播放器适配器](./docs/how-to/custom-player-adapter.md)。

### 弹幕 —— `@babywbx/liveflow/danmaku`

```ts
import { createDanmakuEngine } from '@babywbx/liveflow/danmaku'

interface DanmakuEngine {
  push(message: DanmakuMessage): DanmakuPushResult
  getMetrics(): DanmakuMetrics
  pause(): void
  resume(): void
  resize(viewport: DanmakuViewport): void
  destroy(): void
}
```

引擎接收 `{ contractVersion, renderer, viewport }`，以及可选的 `clock`、`limits`、`policy` 和
`onDiagnostic`。`renderer` 是唯一渲染接缝：核心每帧先批量 `measure()`，再用一次 `render()` 交付
挂载、位移和卸载。调用方不需要为每条消息建立动画循环；引擎空闲时根本不申请动画帧。

```ts
interface DanmakuMessage {
  id: string
  receivedAt: number
  text: string
  mode: 'scroll' | 'top' | 'bottom'
  priority: number
  color?: string
  sender?: { displayName?: string }
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

`kind`、`variant` 和 `assetKey` 都是调用方定义、无平台语义的字符串。多个身份保持独立节点；引擎
不会从一种身份推断另一种，也不会让身份等级改变整条正文的颜色。正文颜色只接受 `#rgb` 或
`#rrggbb`。

`push()` 同步校验并复制输入。`accepted: true` 只表示消息进入有界等待队列，不保证一定展示 ——
它仍可能过期或始终等不到可用轨道。结构性错误抛出 `InvalidDanmakuMessageError`；正文超长则以
`text-too-long` 原因拒绝。超量身份会被截断，`metadata` 整块丢弃，但正文绝不会被静默吞掉。

`getMetrics()` 返回 `received`、`displayed`、`dropped`、`pendingDepth`、`visible`、
`frameBudgetOverruns`、`metadataDiscarded`，以及按重复、过期、限速、容量、无轨道和测量失败分类的
`droppedByReason`。参考：[弹幕调度](./docs/reference/danmaku.md)。

### DOM 渲染器 —— `@babywbx/liveflow/danmaku/dom`

```ts
import { createDomDanmakuRenderer } from '@babywbx/liveflow/danmaku/dom'
```

模块导入阶段不访问 DOM，节点与可选的媒体查询监听器只在调用工厂时创建。渲染器把自己的绝对定位
图层挂到容器上，使用 `pointer-events: none`、`overflow: hidden` 和 `aria-hidden="true"`，因此既不
拦截播放器操作，也不会让屏幕阅读器持续朗读动画消息。每条消息拆成独立的安全文本节点：

```text
.liveflow-danmaku__message
  .liveflow-danmaku__identity[data-kind]
    .liveflow-danmaku__identity-asset
    .liveflow-danmaku__identity-label
  .liveflow-danmaku__sender
  .liveflow-danmaku__delimiter
  .liveflow-danmaku__text
```

活动节点与池节点总数不超过 `maxPoolSize`，达到上限抛出 `CapacityExceededError`，而不是继续申请
节点。每帧顺序固定：回收已结束节点 → 在 `DocumentFragment` 中批量准备新节点 → 一次挂载 →
批量写入 `transform: translate3d(...)`。

同一入口还导出 `normalizeHexColor()`、`contrastRatio()` 和 `resolveAccessibleTextColor()`，按 WCAG
相对亮度公式与传入的 `backgroundColor` 计算对比度，低于 4.5 时回退到 `fallbackTextColor`。图片
只能由 `assetResolver.resolve(assetKey)` 提供，且只接受相对或绝对的 HTTP、HTTPS 与 Blob URL。未
显式传入 `reducedMotion` 时，渲染器监听 `(prefers-reduced-motion: reduce)`，开启后消息固定在轨道
中央。参考：[DOM 弹幕渲染器](./docs/reference/danmaku-dom.md)、
[自定义身份渲染](./docs/how-to/custom-identity.md)。

### 实时叠加层 —— `@babywbx/liveflow/overlay`

```ts
import {
  createOverlayBudgetCoordinator,
  createOverlayEngine,
  createSafeOverlayRenderer,
} from '@babywbx/liveflow/overlay'

interface OverlayEngine {
  submit(event: unknown): OverlaySubmitResult
  registerRenderer(kind: string, renderer: OverlayRenderer): Destroyable
  updateInstance(state: OverlayInstanceStateUpdate): void
  getMetrics(): OverlayMetrics
  destroy(): void
}
```

引擎必填 `contractVersion`、`instanceId`，以及 `container` 与 `defaultRenderer` 二选一；`clock`、
`instanceState`、`coordinator`、`limits`、`assetResolver`、`onError` 和 `onDiagnostic` 可选。
`submit()` 刻意接收 `unknown` 并自行校验结构，因此调用方无法用类型断言跳过校验。事件由四种结构
节点组成，LiveFlow 不解释其中任何一种的语义：

```ts
type OverlayNode =
  | { type: 'text'; role: string; text: string }
  | { type: 'identity'; identity: DanmakuIdentity }
  | { type: 'asset'; role: string; assetKey: string; alt: string }
  | { type: 'metric'; role: string; label: string; value: string }
```

| `submit()` 状态 | 含义                                 |
| --------------- | ------------------------------------ |
| `displayed`     | 已获得预算并开始展示                 |
| `queued`        | 已进入有界等待队列                   |
| `deduped`       | 同一去重键仍在窗口内                 |
| `expired`       | 事件到达时已经超过最大生命周期       |
| `dropped`       | 队列、去重表或跨实例预算没有可用容量 |

非法字段抛出 `InvalidOverlayEventError` —— 非法事件绝不会变成一张空卡片。等待队列满时，只有严格
更高优先级的新事件才能替换当前最低优先级事件；历史积压直接丢弃，不通过缩短展示时长追赶。

`createSafeOverlayRenderer(container, options)` 是默认渲染器：上游文本只写入 `textContent`，
`compact` 只渲染第一个结构节点，资源只经调用方的 `AssetResolver` 解析，解析缺失或 URL 非法时省略
整个节点而不是猜测。

跨实例预算是显式对象，不存在模块级全局单例：

```ts
const coordinator = createOverlayBudgetCoordinator({
  maxInstances: 9,
  maxActiveCards: 3,
  maxFullCards: 1,
  maxHighCostAnimations: 1,
})

const registration = coordinator.register({
  instanceId: 'primary-player',
  weight: 10,
  focused: true,
  visible: true,
})
```

grant 的 `presentation` 取 `full`、`compact` 或 `suppressed`，按焦点、调用方权重、事件优先级和
申请顺序排序。`activeCards`、`activeFull` 与 `activeHighCost` 永远不超过各自配置的上限。参考：
[Realtime Overlay API](./docs/reference/overlay.md)、
[配置多播放器共享预算](./docs/how-to/shared-overlay-budget.md)。

### 多路宫格 —— `@babywbx/liveflow/multiview`

```ts
import {
  multiviewGridBox,
  multiviewGridSpec,
  multiviewGridTracks,
} from '@babywbx/liveflow/multiview'

const spec = multiviewGridSpec(7) // { columns: 3, rows: 3, placeholders: 2 }
const box = multiviewGridBox({ stage, spec, gap: 12 }) // 恒为 16:9 的瓦片，整体落在舞台内
const tracks = multiviewGridTracks(spec) // { gridTemplateColumns, gridTemplateRows }
```

一组无状态纯函数：把瓦片数量映射成网格阶梯，按固定宽高比算出居中的瓦片盒，并给出与之匹配的 CSS
轨道声明。默认上限九路，`maxTiles` 可由调用方提高；瓦片数超过上限抛出 `CapacityExceededError`，
不会静默截断。舞台为空或间距吃掉全部空间时返回零盒 —— 那是「没有可用空间」而不是失败；非法参数
一律抛出 `InvalidMultiviewLayoutError`。

> \[!IMPORTANT\]
> 列轨道与行轨道必须一起写进样式。只声明列时行轨道是隐式 `auto`，占位元素会撑高所在行，瓦片不再
> 保持 16:9，视频两侧出现黑边。瓦片盒的数学只有在行轨道同样均分时才成立，因此两条轨道由同一个
> 返回值给出。

参考：[多路宫格布局](./docs/reference/multiview.md)。

### 错误

全部公开错误继承 `LiveFlowError`，并带稳定 `code`。用 `instanceof LiveFlowError` 识别错误族，按
`code` 聚合；不要依赖 `message` 文案。

| 错误                                    | `code`                                |
| --------------------------------------- | ------------------------------------- |
| `ContractVersionMismatchError`          | `contract-version-mismatch`           |
| `CapacityExceededError`                 | `capacity-exceeded`                   |
| `AssetResolutionError`                  | `asset-resolution-failed`             |
| `InvalidContinuityPolicyError`          | `invalid-continuity-policy`           |
| `InvalidPlaybackMetricsError`           | `invalid-playback-metrics`            |
| `PreparedSourceGenerationMismatchError` | `prepared-source-generation-mismatch` |
| `SourceTransitionError`                 | `source-{phase}-failed`               |
| `InvalidDanmakuMessageError`            | `invalid-danmaku-message`             |
| `InvalidOverlayEventError`              | `invalid-overlay-event`               |
| `OverlayCapacityError`                  | `overlay-capacity-exceeded`           |
| `InvalidMultiviewLayoutError`           | `invalid-multiview-layout`            |
| `PlayerAdapterError`                    | 按操作区分的稳定错误码                |

包含配置、时钟、渲染、调度与清理错误的完整表格见[错误类型](./docs/reference/errors.md)。

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 🔧 配置

所有默认值都偏保守，所有上限都在创建时校验。非法、非有限或互相矛盾的取值会抛出类型化配置错误，
而不是被悄悄夹紧到合法范围。

**连续性策略** —— `DEFAULT_CONTINUITY_POLICY`：

| 字段                          | 默认值 | 字段                     |  默认值 |
| ----------------------------- | -----: | ------------------------ | ------: |
| `targetLatencySeconds`        |    `2` | `recoveryCooldownMs`     | `30000` |
| `softCatchupThresholdSeconds` |  `0.6` | `sourceWarmupTimeoutMs`  |  `8000` |
| `hardResyncThresholdSeconds`  |    `8` | `reopenGraceMs`          | `90000` |
| `catchupRate`                 | `1.04` | `maxAutomaticRecoveries` |     `4` |

**弹幕上限与调度策略** —— `DEFAULT_DANMAKU_LIMITS`、`DEFAULT_DANMAKU_POLICY`：

| 上限                  | 默认值 | 策略                    |     默认值 |
| --------------------- | -----: | ----------------------- | ---------: |
| `maxPending`          |  `200` | `laneHeight`            |    `32` px |
| `maxVisible`          |   `80` | `laneGap`               |    `12` px |
| `maxPoolSize`         |   `96` | `scrollPixelsPerSecond` | `140` px/s |
| `maxTextLength`       |  `500` | `fixedDurationMs`       |     `4000` |
| `maxBadgesPerMessage` |    `4` | `maxPendingAgeMs`       |     `8000` |
| `maxMountsPerFrame`   |    `8` | `maxLaneWaitMs`         |     `2000` |
| `maxIntakePerSecond`  |  `120` | `duplicateWindowMs`     |      `500` |
| `maxDisplayPerSecond` |   `60` | `frameBudgetMs`         |        `8` |

`metadata` 另外受 `maxMetadataKeys`（`16`）、`maxMetadataDepth`（`2`）和 `maxMetadataBytes`
（`2048`）约束。

**实时事件上限** —— `DEFAULT_OVERLAY_LIMITS`：

| 字段               | 默认值 | 字段                 |  默认值 |
| ------------------ | -----: | -------------------- | ------: |
| `maxPending`       |   `32` | `maxRenderers`       |    `32` |
| `maxVisible`       |    `1` | `maxDedupeEntries`   |   `128` |
| `maxNodesPerEvent` |    `8` | `dedupeWindowMs`     | `15000` |
| `maxTextLength`    |  `512` | `maxEventLifetimeMs` | `30000` |

操作指南：[配置弱网恢复](./docs/how-to/configure-recovery.md)、
[配置过载策略](./docs/how-to/configure-overload.md)、
[转发诊断事件](./docs/how-to/forward-diagnostics.md)。

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 🔍 关键行为

**Generation 门禁。** 每次换源生成新 generation。旧 generation 的 promise、事件和计时器不得改变
当前状态；适配器还必须在自己的 `commit()` seam 拒绝过期提交，防止已经开始的旧交接覆盖新媒体。

**可证明的有界性。** 等待队列、可见集合、DOM 节点池、文本长度、徽章数、metadata 键数与深度、
每帧挂载数、收发速率和实例注册表都有固定上限。过载时按优先级丢弃 —— 绝不通过扩大队列来「保全」
所有消息。

**失败必须响。** 无法解析、越界和契约不匹配一律抛类型化错误，不会静默降级成看起来正常的空结果；
渲染失败通过 `onError` 和指标上报，不会被计成一次成功展示。

**干净销毁。** `destroy()` 之后不残留任何帧回调、计时器、Observer 或事件监听器，重复调用安全。
清理会尽最大努力执行每一步，任一步失败则在完成其余清理后抛出聚合错误。

**渲染安全。** 上游数据绝不经 `innerHTML` 渲染。文本只走 `textContent`，图片只通过调用方提供的
`assetKey → URL` 解析器加载，错误与诊断中不出现签名媒体 URL、Cookie 或 token。

**不产出 sourcemap。** 构建不生成 `.map` 文件，产物中不出现 `sourceMappingURL` 或
`sourcesContent`，CI 门禁会卡住任何回退。

背景阅读：[架构与边界](./docs/explanation/architecture.md)、
[Generation 门禁](./docs/explanation/generation-gating.md)、
[有界实时性](./docs/explanation/bounded-realtime.md)、
[结构化身份](./docs/explanation/structured-identities.md)。

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 🌐 浏览器基线

| 浏览器              | 最低版本 |
| ------------------- | -------: |
| Chrome / Edge       |      111 |
| Safari / iOS Safari |     16.4 |
| Firefox             |      128 |

浏览器测试在 Chromium、Firefox 和 WebKit 上运行，覆盖安全 DOM 输出、reduced motion、resize、暂停
恢复、容器换位、重复挂载、四路与九路真实 DOM 上限以及销毁行为，不需要移动模拟器。

核心入口在没有 DOM 的环境同样可以求值，因此服务端渲染和构建步骤中导入是安全的。DOM、播放器和
动画资源只在调用对应工厂时才创建。

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 📚 文档

公开文档位于 [`docs/`](./docs/reference/shared.md)，分为教程、操作指南、参考和说明四类。

| 教程                                                          | 操作指南                                                             |
| ------------------------------------------------------------- | -------------------------------------------------------------------- |
| [十分钟接入原生 video](./docs/tutorials/native-video.md)      | [以 Git 依赖安装](./docs/how-to/install-from-git.md)                 |
| [显示结构化弹幕](./docs/tutorials/structured-danmaku.md)      | [配置弱网恢复](./docs/how-to/configure-recovery.md)                  |
| [注册实时事件 renderer](./docs/tutorials/overlay-renderer.md) | [配置过载策略](./docs/how-to/configure-overload.md)                  |
|                                                               | [自定义身份渲染](./docs/how-to/custom-identity.md)                   |
|                                                               | [实现自定义播放器适配器](./docs/how-to/custom-player-adapter.md)     |
|                                                               | [转发诊断事件](./docs/how-to/forward-diagnostics.md)                 |
|                                                               | [配置多播放器共享预算](./docs/how-to/shared-overlay-budget.md)       |
|                                                               | [运行耐久压力测试](./docs/how-to/run-soak.md)                        |
|                                                               | [处理被浏览器拒绝的播放](./docs/how-to/handle-suspended-playback.md) |

| 参考                                                | 说明                                                       |
| --------------------------------------------------- | ---------------------------------------------------------- |
| [共享契约](./docs/reference/shared.md)              | [架构与边界](./docs/explanation/architecture.md)           |
| [Continuity API](./docs/reference/continuity.md)    | [Generation 门禁](./docs/explanation/generation-gating.md) |
| [弹幕调度](./docs/reference/danmaku.md)             | [有界实时性](./docs/explanation/bounded-realtime.md)       |
| [DOM 弹幕渲染器](./docs/reference/danmaku-dom.md)   | [结构化身份](./docs/explanation/structured-identities.md)  |
| [Realtime Overlay API](./docs/reference/overlay.md) |                                                            |
| [多路宫格布局](./docs/reference/multiview.md)       |                                                            |
| [播放器控件显隐](./docs/reference/chrome.md)        |                                                            |
| [播放器适配器](./docs/reference/adapters.md)        |                                                            |
| [指标与诊断码](./docs/reference/diagnostics.md)     |                                                            |
| [错误类型](./docs/reference/errors.md)              |                                                            |

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 🛠 开发

需要 Node.js `>=22.5.0` 与 pnpm `11.16.0`。

| 目的           | 命令                                     |
| -------------- | ---------------------------------------- |
| 全量校验       | `pnpm check`                             |
| 类型检查       | `pnpm typecheck`                         |
| 格式化         | `pnpm format` / `pnpm format:check`      |
| Lint           | `pnpm lint`                              |
| 单元与集成测试 | `pnpm test`                              |
| 浏览器测试     | `pnpm test:browser`                      |
| 耐久测试       | `SOAK_DURATION_MS=300000 pnpm test:soak` |
| 构建产物       | `pnpm build`                             |
| 体积预算       | `pnpm size:check`                        |

`pnpm check` 聚合格式检查、类型检查、lint、文档链接检查、测试、构建、体积预算和示例构建，是事实上
的 CI 门禁，每次提交前必须本地跑通。由于 `dist/` 随仓库分发，改动 `src/` 后必须重新构建，并把
产物一起提交。

示例工程只读取本地媒体文件并生成合成消息，不上传所选文件，也不连接任何直播平台：

```bash
pnpm --filter liveflow-examples dev
```

参与边界见 [CONTRIBUTING.md](./CONTRIBUTING.md)；安全问题请按 [SECURITY.md](./SECURITY.md) 的流程
私下报告。

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## ❓ 常见问题

<details>
<summary><kbd>Q: 为什么不发布到 npm？</kbd></summary>

<br/>

本项目以 Git 依赖安装，构建产物 `dist/` 已提交进仓库。否则消费方从 Git 安装时会在自己的构建机上
现场解析本仓库的 devDependencies 并执行 `prepare`，工具链漂移会直接搞挂一次本来没有任何改动的
生产构建。产物随仓库走可以完全绕开这个风险面，而且消费方指向的提交早已在 `main` 上跑过 CI。

</details>

<details>
<summary><kbd>Q: 核心会带进播放器运行时吗？</kbd></summary>

<br/>

不会。根包不声明任何运行时依赖，核心入口也不 import 播放器、解码器、Node 内建模块或 UI 框架。播放器
适配器位于独立子路径，只有调用方显式导入时才会下载。

</details>

<details>
<summary><kbd>Q: 能配合 React、Vue 或 Svelte 使用吗？</kbd></summary>

<br/>

可以。LiveFlow 与框架无关：它只暴露接收 DOM 容器、返回带 `destroy()` 对象的普通工厂函数。在框架
提供的生命周期钩子里创建引擎，在卸载时销毁即可。

</details>

<details>
<summary><kbd>Q: 过载时为什么丢消息而不是扩大队列？</kbd></summary>

<br/>

无界队列会把一次流量尖峰变成无界内存和无界延迟，而一条迟到三十秒才出现的直播消息，比根本不出现
更糟。因此每个队列都有固定上限，过载时按优先级丢弃，并把丢弃原因记进指标。

</details>

<details>
<summary><kbd>Q: 服务端渲染时导入核心安全吗？</kbd></summary>

<br/>

安全。模块求值不创建 style、RAF、Worker、Observer 或全局监听器，也不访问 DOM。只有 DOM 渲染器和
默认适配器 surface 需要浏览器环境，且只在调用工厂时才需要。

</details>

<details>
<summary><kbd>Q: 出现错误状态是不是代表主播下播了？</kbd></summary>

<br/>

不是。连续性状态只描述媒体健康度。LiveFlow 从不判断直播是否结束，这个判断和它的展示时机始终属于
调用方应用。

</details>

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 📝 许可证

Copyright © 2026-present [Babywbx][profile-link].<br/>
本项目基于 [MIT](./LICENSE) 许可证发布。

<!-- LINK GROUP -->

[back-to-top]: https://img.shields.io/badge/-BACK_TO_TOP-151515?style=flat-square
[changelog-link]: ./CHANGELOG.md
[docs-link]: ./docs/reference/shared.md
[github-ci-link]: https://github.com/babywbx/LiveFlow/actions/workflows/ci.yml
[github-ci-shield]: https://img.shields.io/github/actions/workflow/status/babywbx/LiveFlow/ci.yml?branch=main&label=CI&labelColor=black&style=flat-square
[github-contributors-link]: https://github.com/babywbx/LiveFlow/graphs/contributors
[github-contributors-shield]: https://img.shields.io/github/contributors/babywbx/LiveFlow?color=c4f042&labelColor=black&style=flat-square
[github-forks-link]: https://github.com/babywbx/LiveFlow/network/members
[github-forks-shield]: https://img.shields.io/github/forks/babywbx/LiveFlow?color=8ae8ff&labelColor=black&style=flat-square
[github-issues-link]: https://github.com/babywbx/LiveFlow/issues
[github-issues-shield]: https://img.shields.io/github/issues/babywbx/LiveFlow?color=ff80eb&labelColor=black&style=flat-square
[github-lastcommit-link]: https://github.com/babywbx/LiveFlow/commits/main
[github-lastcommit-shield]: https://img.shields.io/github/last-commit/babywbx/LiveFlow?labelColor=black&style=flat-square
[github-license-link]: ./LICENSE
[github-license-shield]: https://img.shields.io/github/license/babywbx/LiveFlow?color=white&labelColor=black&style=flat-square
[github-stars-link]: https://github.com/babywbx/LiveFlow/stargazers
[github-stars-shield]: https://img.shields.io/github/stars/babywbx/LiveFlow?color=ffcb47&labelColor=black&style=flat-square
[node-link]: https://github.com/babywbx/LiveFlow/blob/main/package.json
[node-shield]: https://img.shields.io/badge/node-%3E%3D22.5.0-369eff?labelColor=black&style=flat-square
[profile-link]: https://github.com/babywbx

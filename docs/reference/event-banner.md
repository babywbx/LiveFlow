# 事件横幅呈现器

本文是 LiveFlow 事件横幅呈现器的接口参考，面向需要在直播画面上叠加「一整条横幅」的前端
开发者：横幅由调用方提供的一张底图、一行文本和一套布局规格组成。它不描述平台字段投影、
横幅素材来源、素材版本管理，也不定义任何业务语义 —— 呈现器不知道横幅代表什么。

它与 [Realtime Overlay API](./overlay.md) 的分工是：叠加层引擎负责校验、去重、排队和跨
实例预算；呈现器只负责把一条已经获得展示档位的内容画到 DOM 上。

## 入口

```ts
import {
  createDomBannerSurface,
  createEventBannerPresenter,
} from '@babywbx/liveflow/overlay/banner'
```

模块求值时不访问 DOM、不创建计时器、不注册全局监听器。测量用的 canvas 在第一次测量时才
惰性创建。

## 快速开始

```ts
const presenter = createEventBannerPresenter({
  surface: createDomBannerSurface(container),
  layout: {
    width: 720,
    height: 140,
    textTop: 57,
    textLeft: 94,
    maxTextWidth: 510,
    fontSizes: [28, 26, 24, 22],
    fontFamily: 'system-ui, sans-serif',
    outlineColor: '#6b3e00',
  },
  assetResolver,
  onAssetError(error) {
    console.warn(error.code, error.assetKey)
  },
})

const handle = presenter.present(
  {
    text: '合成示例：一行横幅文本',
    label: '合成示例横幅',
    assetKey: 'banner-artwork:1',
    assetAlt: '合成横幅底图',
  },
  'full',
)

handle.destroy()
```

`present()` 返回当前横幅的幂等销毁句柄，签名与 `OverlayRenderer.render()` 对齐，可以直接
包成一个 renderer 注册给叠加层引擎：

```ts
const renderer: OverlayRenderer = {
  render: (event, presentation) => presenter.present(project(event), presentation),
  destroy: () => {
    presenter.destroy()
  },
}
```

`project()` 由调用方实现：把平台事件的结构节点投影成 `BannerContent`。呈现器不解析
`OverlayNode`，也不认识 `kind` 和 `role`。

## 布局规格

```ts
interface BannerLayout {
  width: number
  height: number
  textTop: number
  textLeft: number
  maxTextWidth: number
  fontSizes: readonly number[]
  fontFamily: string
  fontWeight?: string
  textColor?: string
  outlineColor?: string
  outlineWidth?: number
  maxWidthPercent?: number
  bottomPercent?: number
  zIndex?: number
}
```

| 字段              | 必填 | 默认值      | 说明                                              |
| ----------------- | ---- | ----------- | ------------------------------------------------- |
| `width`           | 是   | —           | 设计稿画布宽度，作为所有百分比几何的基准          |
| `height`          | 是   | —           | 设计稿画布高度，决定 `aspect-ratio`               |
| `textTop`         | 是   | —           | 文本框顶边在画布中的纵向位置                      |
| `textLeft`        | 是   | —           | 文本框左边在画布中的横向位置                      |
| `maxTextWidth`    | 是   | —           | 文本框最大宽度，`textLeft + maxTextWidth ≤ width` |
| `fontSizes`       | 是   | —           | 严格递减的字号阶梯，最多 8 级                     |
| `fontFamily`      | 是   | —           | 字体族，同时用于测量与渲染                        |
| `fontWeight`      | 否   | `'700'`     | 字重，同时用于测量与渲染                          |
| `textColor`       | 否   | `'#FFFFFF'` | 文本颜色                                          |
| `outlineColor`    | 否   | 无描边      | 描边色，省略时不写描边样式                        |
| `outlineWidth`    | 否   | `2`         | 描边宽度，单位与画布同为设计稿像素                |
| `maxWidthPercent` | 否   | `92`        | 横幅相对容器的最大宽度百分比                      |
| `bottomPercent`   | 否   | `12`        | 横幅底边相对容器高度的位置                        |
| `zIndex`          | 否   | `30`        | 横幅层级                                          |

所有几何值都是**调用方的设计稿数值**，库不内置任何画布尺寸、文本基线或主题表。非有限、
非正数或互相矛盾的字段在创建时抛出 `InvalidOverlayConfigurationError`。

`width` 同时是容器查询基准：完整档位的根节点写入 `container-type: inline-size`，文本字号
以 `cqw` 表达，因此横幅在任意容器宽度下等比缩放。

## 内容

```ts
interface BannerContent {
  text: string
  label?: string
  assetKey?: string
  assetAlt?: string
}
```

| 字段       | 说明                                                          |
| ---------- | ------------------------------------------------------------- |
| `text`     | 横幅正文，写入前折叠连续空白并 `trim()`，只渲染一行           |
| `label`    | 无障碍标签，省略时回退到 `text`                               |
| `assetKey` | 底图键，交给调用方的 `AssetResolver` 解析，省略即没有底图     |
| `assetAlt` | 底图替代文本，省略时底图按装饰性处理并写 `aria-hidden="true"` |

文本长度受 `maxTextLength` 约束（默认 512，上限 1024），`assetKey` 固定不超过 128 字符。
空文本或超限文本抛出 `InvalidOverlayEventError`，不会被静默截断成一条看起来正常的横幅。

## 呈现档位

`present(content, presentation)` 接受 [`OverlayPresentation`](./overlay.md#跨实例预算)：

| 档位         | 行为                                                 |
| ------------ | ---------------------------------------------------- |
| `full`       | 底图 + 按阶梯自适应的文本，写入完整布局几何          |
| `compact`    | 无底图的紧凑单行，文本使用阶梯最小字号并以省略号收尾 |
| `suppressed` | 不创建任何节点、不挂载、不排帧，返回一个幂等的空句柄 |

以下情况会把 `full` 降级为 `compact`：

- 内容没有 `assetKey`（视为调用方没有底图，不算失败，不触发回调）；
- 没有配置 `assetResolver`，但内容带 `assetKey`；
- 解析器抛错、返回 `null`，或返回的 URL 协议不在 `http:` / `https:` / `blob:` 内；
- 底图已经挂载但加载失败 —— 此时就地移除底图并改写为紧凑样式，不重挂节点。

除第一种情况外，每次降级都会用 `AssetResolutionError` 调用一次 `onAssetError`，回调本身
抛错会被吞掉，不影响横幅生命周期。降级是**有记录的失败**，不是「看起来正常」。

根节点带 `data-liveflow-event-banner="full" | "compact"`，文本节点带
`data-liveflow-event-banner-text`，调用方可以据此叠加自己的皮肤。

## 文本自适应

按 `fontSizes` 从大到小依次测量，第一个不超过 `maxTextWidth` 的字号胜出。全部放不下时，
在最小字号上对**字素簇**做二分查找，保留最长的能容纳省略号的前缀，并把完整文本写入
`title` 属性。

纯函数版本可以单独使用：

```ts
const fit = fitBannerText(text, maxTextWidth, fontSizes, measure)
// { text: string; fontSize: number; truncated: boolean }
```

`measure` 返回非有限值或负数时抛出 `InvalidOverlayConfigurationError`；连省略号都放不下
时同样抛出，因为这属于布局配置错误而不是内容问题。

## 渲染面

呈现器不直接持有 DOM，而是通过一个渲染面完成全部节点操作：

```ts
interface BannerSurface {
  readonly baseUrl: string
  createElement(kind: 'root' | 'text'): BannerElement
  createImage(): BannerImageElement
  mount(element: BannerElement): void
  measureText(text: string, fontSize: number, font: BannerFont): number
}

interface BannerElement {
  setAttribute(name: string, value: string): void
  setStyle(property: string, value: string): void
  setText(text: string): void
  append(child: BannerElement): void
  remove(): void
  isMounted(): boolean
}

interface BannerImageElement extends BannerElement {
  setSource(url: string): void
  onLoadError(listener: () => void): void
}
```

`createDomBannerSurface(container, options?)` 是浏览器实现：

- `root` 映射为 `<section>`，`text` 映射为 `<span>`，图片映射为 `<img>`；
- `setText()` 只写 `textContent`，`setStyle()` 只走 `CSSStyleDeclaration.setProperty()`；
  整个契约里**没有任何写 HTML 的通道**；
- `append()` 只接受同一渲染面创建的元素，否则抛出 `InvalidOverlayConfigurationError`；
- `remove()` 通过 `AbortSignal` 撤销该节点上的监听器；
- `baseUrl` 取自 `document.baseURI`，用于解析相对素材 URL；
- 默认测量在第一次调用时创建一块离屏 canvas；拿不到 2D 上下文时退回按字符宽度估算。
  传入 `options.measureText` 可以完全替换测量实现。

自定义渲染面必须遵守同样的约束：不接受 HTML，不自行拉取素材，`remove()` 之后不再触发
回调。

## 有界性

| 资源            | 上界                                   |
| --------------- | -------------------------------------- |
| 活动横幅数      | `maxActiveBanners`，默认 2，硬上限 8   |
| 常驻 DOM 节点数 | 活动横幅数 × 3（根、底图、文本）       |
| 待处理帧回调数  | 每条活动横幅最多 1 个，随横幅一起取消  |
| 文本长度        | `maxTextLength`，默认 512，硬上限 1024 |
| 字号阶梯长度    | `MAX_BANNER_FONT_STEPS`，8             |
| 单次测量次数    | 阶梯长度 + `log2(字素数)` 次二分       |
| 素材键长度      | 128 字符                               |

活动集合满时，最旧的横幅先被移除：取消它的帧回调、从渲染面卸载、释放句柄。因此每次
`present()` 最多挂载一个节点树，节点总数与调用频率无关。

超出 `maxActiveBanners` 或 `maxTextLength` 硬上限的配置在创建时抛出
`InvalidOverlayConfigurationError`，不会被悄悄夹到上限值。

## 动画与无障碍

入场动画只有一步：挂载前写入起始状态，挂载后在下一帧切到终态，帧回调由注入的 `Clock`
调度（省略 `clock` 时使用 `requestAnimationFrame`）。`reducedMotion: true` 时完全跳过 ——
既不写 `opacity` / `transition`，也不排任何帧。

根节点固定带 `role="status"`、`aria-live="polite"` 和来自 `label` 的 `aria-label`；底图在
没有 `assetAlt` 时写 `aria-hidden="true"`，避免读屏重复播报。

## `destroy()`

取消所有待处理帧、卸载所有活动横幅、拒绝后续 `present()`。重复调用安全。销毁后调用
`present()` 抛出 `OverlayDestroyedError`。

渲染面由调用方拥有，呈现器只移除自己创建的节点，不会清空容器。

## 错误

| 错误                               | 条件                                               |
| ---------------------------------- | -------------------------------------------------- |
| `InvalidOverlayConfigurationError` | 布局、上限、测量结果或渲染面元素非法               |
| `InvalidOverlayEventError`         | 内容文本、标签或素材键为空、超长                   |
| `OverlayDestroyedError`            | 销毁后继续调用 `present()`                         |
| `AssetResolutionError`             | 素材解析或加载失败，经 `onAssetError` 报告而非抛出 |

错误信息只包含字段名与素材键，不包含横幅文本、完整素材 URL、Cookie 或 token。

## 安全

- 上游文本只经 `setText()` 写入 `textContent`，不存在 HTML 解析路径；
- 图片只加载调用方 `AssetResolver` 返回的 URL，且协议必须是 `http:` / `https:` / `blob:`；
- 布局中的颜色和字体族由调用方配置，经 `setProperty()` 写入，非法值被浏览器丢弃；
- 呈现器不读取 Cookie、不发起网络请求、不注册全局监听器。

## 浏览器基线

Chrome / Edge 111、Safari / iOS Safari 16.4、Firefox 128。完整档位依赖容器查询单位
`cqw` 与 `container-type`，字素切分依赖 `Intl.Segmenter`，监听器撤销依赖 `AbortSignal`，
上述版本均已支持。

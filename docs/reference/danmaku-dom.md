# DOM 弹幕渲染器参考

`@babywbx/liveflow/danmaku/dom` 提供 `DanmakuRenderer` 的安全 DOM 实现。模块导入时不访问
DOM；只有调用 `createDomDanmakuRenderer()` 才创建节点和可选的媒体查询监听器。

```ts
import { createDomDanmakuRenderer } from '@babywbx/liveflow/danmaku/dom'

const renderer = createDomDanmakuRenderer({
  container,
  maxPoolSize: 96,
  maxBadgesPerMessage: 4,
  backgroundColor: '#000000',
  fallbackTextColor: '#ffffff',
  assetResolver: {
    resolve(assetKey) {
      return assets.get(assetKey) ?? null
    },
  },
})
```

渲染器把自己的绝对定位图层挂到 `container`。调用方应确保容器已建立定位上下文，例如设置
`position: relative`。图层使用 `pointer-events: none`、`overflow: hidden` 和
`aria-hidden="true"`，不会拦截播放器操作，也不会让屏幕阅读器持续朗读动画消息。

## 结构

每条消息使用以下独立安全文本节点：

```text
.liveflow-danmaku__message
  .liveflow-danmaku__identity[data-kind]
    .liveflow-danmaku__identity-asset
    .liveflow-danmaku__identity-label
  .liveflow-danmaku__sender
  .liveflow-danmaku__delimiter
  .liveflow-danmaku__text
```

身份、昵称、分隔符和正文不会拼成 HTML。所有上游文本只赋给 `textContent`。默认身份节点
把 `label` 和可选的 `Lv.n` 渲染为胶囊内容，使灯牌、用户等级与正文保持不同视觉语义。
样式类只提供结构接缝；产品侧负责最终的字体、背景、边框和间距。

## 节点池与批量写入

活动消息根节点和空闲池根节点的总数不超过 `maxPoolSize`。达到上限时抛出
`CapacityExceededError`，不会继续创建节点。每个渲染帧按以下顺序执行：

1. 卸载并回收已结束节点；
2. 在 `DocumentFragment` 中批量准备新增节点；
3. 一次挂载 fragment；
4. 批量写入已有节点的 `transform: translate3d(...)`。

测量复用一个隐藏 probe，并且每次最多处理 `maxMeasurementsPerFrame` 条消息。默认值是 8。
渲染器不创建 RAF 或每消息计时器；动画节奏完全由调度核心的单一帧循环控制。

## 颜色

`resolveAccessibleTextColor()` 只接受十六进制颜色，并按 WCAG 相对亮度公式计算正文与背景的
对比度。默认最低比值是 4.5。请求颜色无效或不达标时使用 `fallbackTextColor`，默认白色。

同一入口还导出：

- `normalizeHexColor()`；
- `contrastRatio()`；
- `resolveAccessibleTextColor()`。

这些函数不访问 DOM。

## 资源解析

图片只能由 `assetResolver.resolve(assetKey)` 返回。渲染器不会把消息字段直接当作 URL。
解析结果只允许相对或绝对的 HTTP、HTTPS 和 Blob URL；其他协议、非法 URL、resolver 抛错
或 `null` 都会回退为纯文本身份。

`onAssetError(assetKey)` 可接收失败通知。回调异常会被隔离，错误通知中不包含解析后的 URL。

## 自定义身份渲染

传入 `identityRenderer` 后，每个身份通过
`identityRenderer.render(identity, container)` 渲染。返回值必须实现同步、幂等的
`destroy()`；消息卸载、节点复用和渲染器销毁时都会调用它。

自定义 renderer 是受信任的调用方代码。核心仍不接受 HTML 字符串，也不会执行 metadata。

## Reduced motion

未显式设置 `reducedMotion` 时，渲染器监听
`(prefers-reduced-motion: reduce)`。开启后，消息固定在轨道中央，不再按核心提供的横向坐标
滚动；身份文字和轨道位置仍然可见。显式传入布尔值可以避免建立媒体查询监听器。

`destroy()` 会移除监听器、活动节点、池节点、测量 probe 和根图层。重复调用安全。

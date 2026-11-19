# 行内图片参考

`@babywbx/liveflow/danmaku/inline-images` 把弹幕正文里匹配到的片段换成图片，适合平台表情码、
自定义贴纸、动图表情，或者把 emoji 换成统一风格的图片。它实现 DOM 渲染器的
[`textRenderer`](./danmaku-dom.md#自定义正文渲染) 接缝，单独打包，按需加载，不计入四个核心
子路径的合并体积。

LiveFlow 不知道任何平台的表情名单或图片地址。匹配规则和图片来源都由调用方传入。

## 入口

```ts
import { createDomDanmakuRenderer } from '@babywbx/liveflow/danmaku/dom'
import { createInlineImageRenderer } from '@babywbx/liveflow/danmaku/inline-images'

const renderer = createDomDanmakuRenderer({
  container,
  textRenderer: createInlineImageRenderer({
    pattern: /\[[^[\]]+\]/gu,
    resolve(token) {
      const emote = emotes.get(token)
      return emote === undefined
        ? null
        : { src: emote.url, stillSrc: emote.stillUrl, alt: token, aspectRatio: emote.ratio }
    },
  }),
})
```

模块求值时不访问 DOM。工厂函数只校验选项；第一次需要判断减少动态效果时才读取
`matchMedia`，不注册监听器。

## 选项

| 选项                  |   默认值 | 说明                                                                 |
| --------------------- | -------: | -------------------------------------------------------------------- |
| `pattern`             |        — | 带 `g` 标志的正则，匹配可能是图片的片段；不带 `g` 时抛出配置错误     |
| `resolve(token)`      |        — | 返回 `InlineImage`，或返回 `null` 让这个片段保持文字                 |
| `maxImagesPerMessage` |     `16` | 单条消息最多换成图片的个数，之后的片段保持文字、不再调用解析         |
| `reducedMotion`       | 跟随系统 | 显式设置后不再读取 `prefers-reduced-motion`                          |
| `onError(token)`      |        — | 解析抛错、地址不安全、比例无效或图片加载失败时通知，回调异常会被隔离 |

`InlineImage` 字段：

| 字段          | 说明                                                    |
| ------------- | ------------------------------------------------------- |
| `src`         | 图片地址，可以是 PNG、WebP、AVIF、GIF、APNG 或动图 WebP |
| `stillSrc`    | 可选的静态图，减少动态效果时代替 `src`                  |
| `alt`         | 替代文字，默认是匹配到的原文                            |
| `aspectRatio` | 宽除以高，默认 `1`，必须是有限正数                      |

## 匹配与替换

- 按 `pattern` 从左到右匹配。`resolve` 返回 `null` 的片段原样保留为文字，匹配继续向后。
- 空匹配会被跳过，正则写得宽一些也不会在每个字符之间插图。
- 正文先按 DOM 渲染器的 `maxTextLength` 截断，再做替换。截断按字素进行，emoji 组合序列不会被
  拆开。
- 文字部分只以文本节点写入，不解析 HTML。

## 尺寸与对齐

每张图片是 `inline-block`，宽高都由样式写死：

```text
height: var(--liveflow-danmaku-image-size, 1.2em)
width: calc(高度 × aspectRatio)
vertical-align: var(--liveflow-danmaku-image-align, calc(0.35em - 高度 / 2))
object-fit: contain
```

- 尺寸以 `em` 计，跟着所在那一行的字号缩放，手机和大屏都不用另算。
- 默认对齐让图片中心落在字身中部，改了大小也保持居中。需要微调时在消息或图层上设置
  `--liveflow-danmaku-image-align`。
- 因为宽高不依赖图片本身，测量时图片还没加载也能得到最终宽度，滚动弹幕的碰撞计算和列表折行
  都把图片算进去。加载完成、加载失败前后盒子尺寸都不变，不会和相邻弹幕叠在一起。
- 加载失败的图片会隐藏（`visibility: hidden`），保留原来的空位，并调用 `onError`。
- 描边、阴影等效果由样式决定，例如 `.liveflow-danmaku__image { filter: drop-shadow(...) }`。

## 动图与减少动态效果

GIF、APNG、动图 WebP 由浏览器原生播放，不需要额外代码。系统开启减少动态效果，或者显式传入
`reducedMotion: true` 时，提供了 `stillSrc` 的图片改用静态图；没有提供的照常使用 `src`。

## 资源规则

地址按页面 `baseURI` 解析，只接受 HTTP、HTTPS 与 Blob URL，与 DOM 渲染器的
`assetResolver` 规则一致。`data:` 等其他协议会被拒绝，这个片段保持文字并调用 `onError`。
构建工具默认把小图内联成 `data:` 地址时，需要关闭内联或改用 `URL.createObjectURL()`。

## Emoji

Emoji 本身就是文字，DOM 渲染器直接用系统字体绘制。为了在各平台都显示彩色 emoji，建议在
弹幕字体栈末尾补上 emoji 字体：

```css
.liveflow-danmaku__message {
  font-family: system-ui, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji';
}
```

需要统一风格时，可以把 emoji 也交给行内图片，图片集由调用方提供。入口导出的 `EMOJI_PATTERN`
按完整序列匹配：肤色、零宽连接的组合、国旗和数字键帽都作为一个片段交给 `resolve`。

```ts
import { createInlineImageRenderer, EMOJI_PATTERN } from '@babywbx/liveflow/danmaku/inline-images'

createInlineImageRenderer({
  pattern: new RegExp(`${EMOTE.source}|${EMOJI_PATTERN.source}`, 'gu'),
  resolve: (token) => emotes.get(token) ?? emojiImages.get(token) ?? null,
})
```

`EMOJI_PATTERN` 也会匹配 `©`、`®` 这类常作文字使用的符号，`resolve` 对没有图片的片段返回
`null` 即可保留文字。它带 `g` 标志，请通过 `matchAll()`、`replace()` 或 `.source` 使用，不要调用
`test()` 或 `exec()`，以免共享的 `lastIndex` 被改动。

## 性能

- 每条消息最多生成 `maxImagesPerMessage` 个图片节点，节点随消息卸载一起回收。
- 图片带 `decoding="async"`，同一地址在测量和挂载之间复用浏览器缓存。
- 弹幕移动仍然只写 `transform`，图片随消息节点一起在合成层上移动，不触发重排。

# 在画面角落显示列表式弹幕

列表排布把弹幕逐条堆叠在画面的一角，新消息从末尾进入，旧消息被顶出区域后卸载。它和轨道
排布共用同一个引擎入口，等待队列、去重、限速与过期规则都不变。

## 1. 把容器放到角落

列表区域就是渲染容器本身。先用样式把容器放到想要的角，并给它宽高：

```css
.chat-stack {
  position: absolute;
  left: 12px;
  bottom: 12px;
  width: 40%;
  height: 45%;
}
```

渲染器的图层带有 `overflow: hidden`，超出容器的行会被裁掉。想让上边缘渐隐，可以给容器加
`mask-image`。

## 2. 创建引擎与渲染器

引擎和渲染器的 `layout` 必须一致，视口取容器自身的尺寸：

```ts
import { CONTRACT_VERSION } from '@babywbx/liveflow'
import { createDanmakuEngine } from '@babywbx/liveflow/danmaku'
import { createDomDanmakuRenderer } from '@babywbx/liveflow/danmaku/dom'

const engine = createDanmakuEngine({
  contractVersion: CONTRACT_VERSION,
  layout: 'stack',
  viewport: { width: container.clientWidth, height: container.clientHeight },
  policy: { stackAnchor: 'bottom-left', stackGap: 6, stackGlideMs: 300 },
  limits: { maxDisplayPerSecond: 8 },
  renderer: createDomDanmakuRenderer({
    container,
    layout: 'stack',
    assetResolver: {
      resolve(assetKey) {
        return avatars.get(assetKey) ?? null
      },
    },
  }),
})
```

容器尺寸变化时调用 `engine.resize()`，传入新的宽高。`stackAnchor` 应与容器所在的角一致：
放在右侧时用 `bottom-right` 或 `top-right`，行会贴住右边缘。

`maxDisplayPerSecond` 决定列表滚动的最快速度。消息多于这个速度时，等待队列按优先级保留，
其余的按既有规则过期丢弃。

## 3. 推入带头像和昵称颜色的消息

```ts
engine.push({
  id: 'message-1',
  receivedAt: performance.now(),
  text: '这条消息足够长的时候会在区域宽度内折行',
  mode: 'scroll',
  priority: 0,
  sender: { displayName: '观众', color: '#ffcb47', avatarKey: 'avatar:42' },
})
```

`mode` 在列表排布下不参与排布，填任意合法值即可。`avatarKey` 只是资源键，图片地址由
`assetResolver` 给出。

## 4. 补上样式

LiveFlow 不带样式。头像必须有固定宽高，否则图片加载后行高变化，会与相邻的行重叠：

```css
.chat-stack .liveflow-danmaku__message {
  position: relative;
  padding-left: 28px;
  line-height: 22px;
}

.chat-stack .liveflow-danmaku__avatar {
  position: absolute;
  left: 0;
  top: 0;
  width: 22px;
  height: 22px;
  border-radius: 50%;
}

.chat-stack .liveflow-danmaku__delimiter {
  display: none;
}

.chat-stack .liveflow-danmaku__sender {
  margin-right: 6px;
}
```

行的宽度上限等于容器宽度，所以左右内边距要写在行上，不要写在容器上。

## 5. 减少动态效果

DOM 渲染器在 `(prefers-reduced-motion: reduce)` 生效时不做滑动，每一行直接出现在最终位置。
自定义渲染器可以读取渲染帧里的 `restY` 达到同样的效果，也可以把 `stackGlideMs` 设为 `0`。

参考：[弹幕调度](../reference/danmaku.md#列表排布)、
[DOM 弹幕渲染器](../reference/danmaku-dom.md#列表排布)。

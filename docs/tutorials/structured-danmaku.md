# 在任意播放器容器中显示结构化弹幕

本教程使用 DOM renderer 显示合成消息。调用方把平台数据投影成通用消息后再交给引擎；
LiveFlow 不连接弹幕服务。

## 1. 建立挂载层

```ts
const container = document.querySelector<HTMLElement>('[data-player]')
if (container === null) {
  throw new Error('Player container is missing.')
}

const [{ CONTRACT_VERSION }, danmaku, dom] = await Promise.all([
  import('@babywbx/liveflow'),
  import('@babywbx/liveflow/danmaku'),
  import('@babywbx/liveflow/danmaku/dom'),
])

const renderer = dom.createDomDanmakuRenderer({
  container,
  backgroundColor: '#000000',
  fallbackTextColor: '#ffffff',
})

const engine = danmaku.createDanmakuEngine({
  contractVersion: CONTRACT_VERSION,
  renderer,
  viewport: {
    width: container.clientWidth,
    height: container.clientHeight,
  },
})
```

容器需要 `position: relative`。renderer 创建的图层不接收指针事件，也不会拦截播放器
控制条。

## 2. 推送结构化消息

```ts
engine.push({
  id: 'synthetic-1',
  receivedAt: performance.now(),
  text: '灯牌、昵称和正文是不同节点。',
  mode: 'scroll',
  priority: 20,
  color: '#ffffff',
  sender: {
    displayName: '示例观众',
  },
  identities: [
    {
      kind: 'supporter-badge',
      label: '同行者',
      level: 12,
    },
    {
      kind: 'user-level',
      label: '等级',
      level: 28,
    },
  ],
})
```

`identities` 中的灯牌和用户等级不会被拼进正文，也不会改变整条正文颜色。所有上游文字都
通过文本节点输出。

## 3. 跟随容器尺寸

```ts
const observer = new ResizeObserver(() => {
  engine.resize({
    width: Math.max(container.clientWidth, 1),
    height: Math.max(container.clientHeight, 1),
  })
})

observer.observe(container)
```

页面隐藏时可以调用 `engine.pause()`，恢复时调用 `engine.resume()`。暂停时间不会消耗消息
展示时长。

## 4. 清理

```ts
observer.disconnect()
engine.destroy()
```

销毁后 RAF、DOM 图层、节点池和媒体查询监听器都会释放。继续调用其他方法会抛出明确错误。

下一步可阅读[自定义灯牌](../how-to/custom-identity.md)和
[弹幕调度参考](../reference/danmaku.md)。

# 十分钟接入原生 video

本教程把一个已经存在的 `<video>` 接入连续性控制器。媒体地址仍由应用提供，LiveFlow 只管理
浏览器内的候选实例、首帧交接和有界恢复。

## 1. 准备容器

```html
<div class="player">
  <video data-live-video controls playsinline></video>
</div>
```

默认原生 surface 会在同一父节点创建隐藏候选，所以父容器应允许两个 video 临时重叠：

```css
.player {
  position: relative;
  aspect-ratio: 16 / 9;
  background: #000;
}

.player > video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
```

## 2. 在真正播放时加载

```ts
const startButton = document.querySelector<HTMLButtonElement>('[data-start]')
const video = document.querySelector<HTMLVideoElement>('[data-live-video]')

if (startButton === null || video === null) {
  throw new Error('Player controls are missing.')
}

startButton.addEventListener('click', () => {
  void startPlayback(video)
})

async function startPlayback(video: HTMLVideoElement): Promise<void> {
  const [{ CONTRACT_VERSION }, continuity, nativeVideo] = await Promise.all([
    import('@babywbx/liveflow'),
    import('@babywbx/liveflow/continuity'),
    import('@babywbx/liveflow/native-video'),
  ])

  const adapter = nativeVideo.createNativeVideoAdapter({ video })
  adapter.setMuted(true)

  const controller = continuity.createContinuityController({
    adapter,
    contractVersion: CONTRACT_VERSION,
  })

  await controller.setSource({
    url: await resolveCurrentMediaUrl(),
    kind: 'live',
    label: 'primary',
  })
}
```

这样初始页面不会下载连续性或适配器代码。第一次点击后，adapter 创建隐藏候选；候选真正
产生首帧时才替换当前 video。

## 3. 接入恢复

恢复 listener 只负责请求应用刷新 source：

```ts
const controller = continuity.createContinuityController({
  adapter,
  contractVersion: CONTRACT_VERSION,
  onRecoveryRequest(request) {
    void refreshSource(request).then((source) => controller.setSource(source))
  },
})
```

不要在 listener 中建立无限重试。控制器已经限制恢复冷却和自动恢复次数。

## 4. 监听状态并清理

```ts
const unsubscribe = controller.subscribe((snapshot) => {
  status.textContent = snapshot.state
})

window.addEventListener(
  'pagehide',
  () => {
    unsubscribe()
    void controller.destroy()
  },
  { once: true },
)
```

`destroy()` 会清理 adapter 创建的候选节点、媒体资源、计时器和事件监听器。调用方传入的
初始 video 在首次交接前仍归调用方所有。

下一步可阅读[恢复策略](../how-to/configure-recovery.md)和
[播放器适配器参考](../reference/adapters.md)。

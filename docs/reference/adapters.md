# 播放器适配器参考

LiveFlow 提供原生 `<video>` 与 ArtPlayer-like 两个可选适配器。二者实现相同的
`LivePlayerAdapter` 接口，连续性引擎不感知播放器类型。

适配器模块只负责媒体实例生命周期和播放器事件转换。它们不获取媒体地址、不解析平台协议，
也不创建解码器。

## 共同换源语义

一次换源严格分成以下步骤：

1. `prepare(source, generation)` 创建并隐藏候选实例；
2. `commit(prepared, generation)` 选定本代候选实例，但不替换当前画面；
3. `play()` 启动候选实例；
4. 候选实例产生首个视频帧时，适配器原子显示候选实例；
5. 原画面随后暂停并释放；
6. 适配器发出带对应 `generation` 的 `first-frame` 和 `playing` 事件。

如果浏览器支持 `requestVideoFrameCallback`，首帧门控使用实际视频帧回调；否则在 `playing`
事件时交接。候选实例在交接前始终静音，避免新旧实例同时出声。

`discard(prepared)` 释放未提交或已失效的候选实例。适配器销毁以后再次调用 `discard` 是安全
的无操作。`destroy()` 可重复调用，并在返回前释放所有已经创建的会话。

适配器最多同时保留 4 个候选创建或待提交会话，最多接受 32 个播放事件监听器。超过上限会抛出
`CapacityExceededError`。`destroy()` 不等待尚未结束的候选工厂：当前会话立即释放，候选
以后成功返回时由原 `prepare()` 路径独立释放。这保证无法结束的播放器创建不会阻塞页面卸载。

## 不存在画质与线路方法

适配器没有 `setQuality` 或 `setCdn`。画质、线路和刷新签名都由调用方解析成新的
`LiveSource`，然后执行一次新的 `prepare → commit`。这保证平台语义不会进入播放器 seam。

## 原生 video

```ts
import { createNativeVideoAdapter } from '@babywbx/liveflow/native-video'

const video = document.querySelector<HTMLVideoElement>('[data-live-video]')
if (video === null) {
  throw new Error('Missing live video element.')
}

const adapter = createNativeVideoAdapter({
  video,
  crossOrigin: 'anonymous',
})
```

默认 DOM surface 要求传入的 video 已挂载到文档中。适配器会在同一父节点创建隐藏的候选
video，复制 `controls`、`playsInline` 和 `className`，首帧时交换可见性。

调用方保留传入 video 的 DOM 所有权：

- 在首次交接前直接 `destroy()`：适配器会暂停并清空媒体资源，但不会从 DOM 删除该节点；
- 首次交接成功：原节点成为被替换的旧实例，会在新画面显示后删除；
- 适配器创建的所有候选节点均由适配器拥有，无论 `discard`、失败还是 `destroy` 都会删除。

因此最终销毁后不会留下适配器创建的隐藏节点。自定义 surface 也必须遵守同样的所有权和原子
交接语义。

### 自定义 surface

非标准 DOM 布局或测试环境可以传入 `NativeVideoSurface`：

```ts
const adapter = createNativeVideoAdapter({
  video: currentVideo,
  surface: {
    createVideo: () => createCandidateVideo(),
    stage: (candidate) => mountHidden(candidate),
    reveal: (candidate, previous) => swapAtomically(candidate, previous),
    remove: (candidate) => removeCandidate(candidate),
  },
})
```

`reveal` 必须是同步且原子的：返回时候选实例已可见，旧实例可以安全释放。

### 原生事件映射

| 原生事件                | `PlaybackEvent`                             |
| ----------------------- | ------------------------------------------- |
| `loadeddata`、`canplay` | `ready`                                     |
| `playing`               | `playing`，候选实例首帧后另发 `first-frame` |
| `waiting`               | `waiting`                                   |
| `stalled`               | `stalled`                                   |
| `ended`                 | `ended`                                     |
| `error`                 | `error`                                     |

媒体错误码只转换为不含媒体 URL 的稳定代码。错误码 `4` 被标记为不可恢复，其他原生媒体错误
由连续性引擎决定是否刷新源。

## ArtPlayer-like

ArtPlayer 子路径不静态导入或依赖播放器包。调用方提供一个很小的 `ArtPlayerLike` 包装以及
候选实例工厂：

```ts
import { createArtPlayerAdapter } from '@babywbx/liveflow/artplayer'

const adapter = createArtPlayerAdapter({
  player: currentPlayer,
  createPlayer: async (source, generation, { mutex }) => {
    return createApplicationPlayer({
      url: source.url,
      generation,
      mutex,
    })
  },
})
```

`createPlayer` 必须为每次调用返回独立实例。工厂接收固定的 `{ mutex: false }`，适配器还会对
返回实例调用 `setMutex(false)`。因此每个适配器只暂停和销毁自己拥有的实例，不会触发播放器
默认的跨实例互斥。

`ArtPlayerLike` 需要提供：

- 底层 `video`；
- `on` / `off` 事件订阅；
- `setMutex(false)`；
- `destroy()`；
- 可选 `container` 与 `overlayContainer`。

存在 `container` 时可以使用默认 surface。候选播放器工厂应先把容器挂载到正确位置，默认
surface 负责隐藏、显示与删除。特殊网格或拖拽布局应注入 `ArtPlayerSurface`，其 `reveal`
同样必须同步且原子。

`getOverlayContainer()` 返回当前可见播放器的 overlay 容器；当前实例未提供时，返回选项中的
共享 `overlayContainer`，两者都不存在时返回 `null`。

### ArtPlayer-like 事件映射

适配器同时接受普通名称和 `video:` 前缀名称：

| 输入事件                    | `PlaybackEvent`                             |
| --------------------------- | ------------------------------------------- |
| `ready`、`video:loadeddata` | `ready`                                     |
| `playing`、`video:playing`  | `playing`，候选实例首帧后另发 `first-frame` |
| `waiting`、`video:waiting`  | `waiting`                                   |
| `stalled`、`video:stalled`  | `stalled`                                   |
| `ended`、`video:ended`      | `ended`                                     |
| `error`、`video:error`      | 可恢复的 `error`                            |
| `destroy`                   | 不可恢复的 `error`                          |

适配器自身销毁时会先解除监听器，因此不会把正常清理误报为播放器错误。

## 媒体指标

`getMetrics()` 从当前可见实例的底层 video 读取：

- `currentTimeSeconds`：当前播放位置；
- `bufferedAheadSeconds`：包含当前位置的缓冲区间剩余长度；
- `liveEdgeDistanceSeconds`：最后一个缓冲区间末尾与当前位置的距离；
- `playbackRate`：当前播放速度；
- `stalledSince`：本实例最后一次进入 `waiting` / `stalled` 的单调时钟时间；
- `droppedFrames`：`getVideoPlaybackQuality()` 可用时的累计丢帧数，否则为 `null`。

## 浏览器基线

默认 DOM surface 的最低浏览器版本是 Chrome / Edge 111、Safari / iOS Safari 16.4 和
Firefox 128。模块求值阶段不访问 DOM；服务端可以安全导入核心入口和两个适配器子路径，只有
创建默认 DOM surface 时才要求浏览器环境。

# 接入自定义播放器 adapter

自定义播放器通过 `LivePlayerAdapter` seam 接入连续性引擎。adapter 负责媒体实例和 DOM，
连续性控制器负责 generation、恢复和追帧决策。

## 实现 interface

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

## 使用可见实例和候选实例

为了避免换源闪烁，adapter 内部需要区分：

- 当前可见实例；
- 正在 prepare、commit 或等待首帧的隐藏候选实例。

`prepare()` 创建候选资源，但不改变当前可见画面。`commit()` 接受候选并再次核对
generation，然后让候选在隐藏状态开始预热。候选产生首帧时：

1. 确认它仍是最新 generation；
2. 原子显示候选并隐藏旧实例；
3. 释放旧实例；
4. 发出候选 generation 的 `first-frame`。

不要在 `play()` Promise resolve 时直接移除旧实例；播放调用成功不代表首帧已经呈现。

## 实现 discard

`discard()` 必须幂等，并且只能释放传入 handle 对应的候选。旧 generation 的 discard
不能误删当前可见媒体。

控制器销毁后，较早开始的 `prepare()` 仍可能返回。`destroy()` 应先释放 adapter 已知的
全部实例；`discard()` 还要能安全处理这种销毁后才出现的迟到 handle。

## 转换事件

所有事件都带产生它的 generation：

```ts
listener({
  type: 'waiting',
  generation,
})
```

不要读取控制器的当前 generation 后再给旧事件补标签。generation 必须在创建媒体实例时与
实例绑定，否则旧实例的迟到事件会被错误标成当前事件。

## 提供播放指标

`getMetrics()` 返回有限、非负的秒数：

- 当前播放时间；
- 当前时间之后连续可播放的缓冲长度；
- 距离已知直播边缘的距离；
- 实际播放速度；
- 可选卡顿起点；
- 可选累计丢帧数。

无法得到某项指标时，不要伪造健康值。adapter 可以抛出脱敏错误，让控制器进入明确恢复。

## 画质和线路

adapter 上不存在 `setQuality()` 或 `setCdn()`。调用方解析新画质或线路后生成新的
`LiveSource`，再调用 `controller.setSource()`。这样所有换源都经过同一套 generation 和
首帧交接规则。

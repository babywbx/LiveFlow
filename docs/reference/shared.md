# 共享契约参考

根入口 `@babywbx/liveflow` 只导出共享契约，不静态加载三个引擎或播放器 adapter。

## 契约版本

```ts
import { CONTRACT_VERSION } from '@babywbx/liveflow'
```

调用方把这个值传给 `createContinuityController()`、`createDanmakuEngine()` 和
`createOverlayEngine()`。版本不一致时创建立即失败。当前契约版本为 `1`。

## Clock

```ts
interface Clock {
  now(): number
  setTimeout(handler: () => void, delayMs: number): number
  clearTimeout(handle: number): void
  requestFrame(handler: (timestampMs: number) => void): number
  cancelFrame(handle: number): void
}
```

`now()` 必须单调不倒退。系统实现最多同时持有 256 个 timeout 与 frame handle，达到上限
抛出 `CapacityExceededError`。

## 诊断事件

```ts
interface DiagnosticEvent {
  scope: 'continuity' | 'danmaku' | 'overlay'
  code: string
  level: 'debug' | 'info' | 'warn'
  generation?: number
  detail?: Readonly<Record<string, string | number | boolean>>
}
```

诊断是限频的运行状态信号，不是逐消息数据管道。detail 只含受限标量，不含媒体 URL、原始
消息或平台 payload。

## 销毁接口

```ts
interface Destroyable {
  destroy(): void
}

interface AsyncDestroyable {
  destroy(): Promise<void>
}
```

所有公共销毁方法都要求幂等。同步 renderer 使用 `Destroyable`；拥有异步媒体创建的
controller 与 adapter 使用 `AsyncDestroyable` 语义。

## 浏览器基线

| 浏览器              | 最低版本 |
| ------------------- | -------: |
| Chrome / Edge       |      111 |
| Safari / iOS Safari |     16.4 |
| Firefox             |      128 |

核心入口在没有 DOM 的 Node 环境也可以导入。DOM、播放器和动画资源只在调用对应工厂时创建。

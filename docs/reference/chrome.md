# Chrome Visibility API

本文是 LiveFlow 播放器控件显隐控制器的接口参考，面向需要让播放控件在指针活动时出现、
静止后淡出的前端开发者。这里的 chrome 指播放器自己的控件层（进度条、音量、菜单、
按钮），与浏览器无关。

控制器只回答「此刻控件该不该显示」这一个问题。它不渲染控件、不绑定事件、不读写 DOM，
也不依赖任何 UI 框架。控件外观、事件绑定和无障碍语义仍然属于调用方。

## 入口

```ts
import { createChromeVisibility, DEFAULT_CHROME_IDLE_HIDE_MS } from '@babywbx/liveflow/chrome'
```

控制器必须从 `@babywbx/liveflow/chrome` 子路径加载。模块求值时不会访问 DOM、创建计时器
或注册全局监听器。

## 创建控制器

```ts
const chrome = createChromeVisibility({
  clock,
  idleHideMs: 2_500,
  hold: false,
})
```

返回的控制器只有三类方法：输入信号、快照读取与订阅，以及销毁。

```ts
interface ChromeVisibilityController {
  pointerEnter(): void
  pointerMove(): void
  pointerLeave(): void
  pointerDown(): void
  pin(): void
  unpin(): void
  setFocusWithin(focused: boolean): void
  setHold(hold: boolean): void
  getSnapshot(): ChromeVisibilitySnapshot
  subscribe(listener: ChromeVisibilitySnapshotListener): () => void
  destroy(): void
}
```

### `ChromeVisibilityOptions`

| 字段         | 类型      | 必填 | 说明                                |
| ------------ | --------- | ---- | ----------------------------------- |
| `clock`      | `Clock`   | 否   | 单调时钟；省略时使用浏览器时钟      |
| `idleHideMs` | `number`  | 否   | 指针静止到隐藏的毫秒数，默认 `2500` |
| `hold`       | `boolean` | 否   | 初始常驻开关，默认 `false`          |

`idleHideMs` 必须是有限正数。`0`、负数、`NaN` 和 `Infinity` 会立即抛出
`InvalidChromeVisibilityConfigurationError`，不会被静默替换成默认值。

省略 `clock` 时使用浏览器的 `performance.now()` 与 `setTimeout()`。注入时钟是让显隐
时序可测的唯一方式；控制器内部不直接调用全局计时器。

## 输入信号

| 方法                      | 语义                                                       |
| ------------------------- | ---------------------------------------------------------- |
| `pointerEnter()`          | 指针进入播放区域：标记指针在内、显示控件并重排隐藏计时     |
| `pointerMove()`           | 指针在播放区域内移动：同 `pointerEnter()`                  |
| `pointerDown()`           | 指针按下：同 `pointerEnter()`，用于触屏点击唤起            |
| `pointerLeave()`          | 指针离开播放区域：标记指针在外，并在没有常驻时立即隐藏     |
| `pin()`                   | 打开一层常驻（菜单、滑杆展开），计数加一并立即显示         |
| `unpin()`                 | 关闭一层常驻，计数减一；不再常驻时恢复空闲计时             |
| `setFocusWithin(focused)` | 键盘焦点是否落在控件内；`true` 期间常驻                    |
| `setHold(hold)`           | 外部常驻条件（例如正在播放）；只在指针位于播放区域内时生效 |

调用方负责把宿主环境的事件接到这些信号上，例如把 `pointerenter` / `pointermove` /
`pointerleave` / `pointerdown` 绑到播放区域，把 `focusin` / `focusout` 折算成
`setFocusWithin()`，把「正在播放」折算成 `setHold()`。控制器不注册任何监听器，因此也
不会与播放器自身的事件处理冲突。

## 显隐规则

控件在满足以下任一条件时常驻，永远不会被空闲计时隐藏：

```text
pinCount > 0 || focusWithin || (hold && pointerInside)
```

其余规则：

- 空闲隐藏只在控件可见且不常驻时排期，隐藏后不留计时器；
- 每次指针信号都会重排隐藏计时，所以持续移动指针时控件保持可见；
- `pointerLeave()` 不走计时器，没有 `pin` 也没有焦点时立即隐藏；
- `setHold(true)` 只有在指针位于播放区域内时才取消已有计时，指针在外时不改变既有计时；
- `setHold(false)` 与 `unpin()` 只是重新开始空闲计时，不会立刻隐藏正在展示的控件。

`hold` 与 `pin` 语义不同：`hold` 表达「播放中且指针在内就别消失」这类持续状态，由调用方
反复覆盖写入；`pin` 表达「有一个临时浮层正在打开」，必须成对调用。

## 快照与订阅

```ts
interface ChromeVisibilitySnapshot {
  readonly visible: boolean
}
```

`getSnapshot()` 同步返回当前快照。可见与隐藏两种快照各自是同一个冻结对象，因此状态未
变化时引用保持稳定，可以直接接入要求引用相等的订阅式绑定。

`subscribe(listener)` 返回幂等退订函数，最多保留 32 个不同 listener，超出抛出
`CapacityExceededError`。listener 只在 `visible` 真正翻转时收到通知；某个 listener 抛错
不会中断其余 listener，也不会改变控制器状态。

## `destroy()`

取消待触发的隐藏计时器，清空 `pin` 计数、焦点与指针状态，向仍在订阅的 listener 发出最后
一次 `{ visible: false }`，然后清空订阅表。重复调用安全。

销毁后 `getSnapshot()` 仍可读且恒为 `{ visible: false }`；其余方法一律抛出
`ChromeVisibilityDestroyedError`，不会静默忽略。

## 有界性

| 资源             | 上限 |
| ---------------- | ---- |
| 快照 listener 数 | 32   |
| `pin` 计数深度   | 32   |
| 活跃计时器       | 1    |

`pin` 计数不会下溢：没有对应 `pin` 的 `unpin()` 抛出
`ChromeVisibilityPinUnderflowError`，而不是把计数钳到 `0` 后继续运行。钳位会把「调用不
配对」这个 bug 藏起来，最终表现成菜单还开着控件就消失，或者控件再也不会自动隐藏。

## 错误

| 错误                                        | 条件                           |
| ------------------------------------------- | ------------------------------ |
| `InvalidChromeVisibilityConfigurationError` | `idleHideMs` 不是有限正数      |
| `CapacityExceededError`                     | listener 或 `pin` 深度达到上限 |
| `ChromeVisibilityPinUnderflowError`         | `unpin()` 没有配对的 `pin()`   |
| `ChromeVisibilityDestroyedError`            | 销毁后继续发送信号或订阅       |

全部错误继承 `LiveFlowError`，带稳定 `code`。完整错误表见[错误类型](./errors.md)。

## 与其他引擎的关系

显隐控制器不导入连续性、弹幕或实时事件引擎，也不读取播放状态。它与
[Continuity API](./continuity.md) 之间唯一的联系是调用方自己决定的：把播放状态折算成
`setHold()` 的布尔值。多路播放网格中，每个画面各自持有一个控制器，互不共享状态。

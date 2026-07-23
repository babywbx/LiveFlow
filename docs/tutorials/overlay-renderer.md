# 注册一个有界实时事件卡 renderer

普通弹幕适合高频滚动消息；付费留言、礼物和里程碑更适合使用独立实时事件引擎。本教程注册
一个自定义 renderer，同时保留队列、展示时长和预算约束。

## 1. 创建 renderer

```ts
import type {
  OverlayPresentation,
  OverlayRenderer,
  RealtimeOverlayEvent,
} from '@babywbx/liveflow/overlay'

function createMilestoneRenderer(container: HTMLElement): OverlayRenderer {
  return {
    render(event: RealtimeOverlayEvent, presentation: OverlayPresentation) {
      const card = document.createElement('section')
      card.dataset.presentation = presentation

      const textNode = event.nodes.find((node) => node.type === 'text')
      card.textContent = textNode?.type === 'text' ? textNode.text : '新事件'
      container.append(card)

      return {
        destroy(): void {
          card.remove()
        },
      }
    },
    destroy(): void {},
  }
}
```

不要把节点内容拼成 HTML。`render()` 返回的句柄必须可重复销毁，因为展示级别变化时同一
事件可能重新渲染。

## 2. 创建引擎并注册

```ts
const [{ CONTRACT_VERSION }, overlayModule] = await Promise.all([
  import('@babywbx/liveflow'),
  import('@babywbx/liveflow/overlay'),
])

const overlay = overlayModule.createOverlayEngine({
  contractVersion: CONTRACT_VERSION,
  instanceId: 'primary',
  container,
})

const registration = overlay.registerRenderer('milestone', createMilestoneRenderer(container))
```

未注册的 `kind` 走默认安全 renderer。注册表固定有上限，不会随历史 kind 数量增长。

## 3. 提交结构事件

```ts
overlay.submit({
  id: 'synthetic-milestone-1',
  kind: 'milestone',
  receivedAt: performance.now(),
  priority: 80,
  durationMs: 4_000,
  nodes: [
    {
      type: 'identity',
      identity: {
        kind: 'supporter',
        label: '同行者',
        level: 12,
      },
    },
    {
      type: 'text',
      role: 'message',
      text: '完成了一个合成里程碑。',
    },
  ],
})
```

过期、重复或超出预算的事件会返回对应状态；引擎不会扩大队列来补播历史。

## 4. 释放

```ts
registration.destroy()
overlay.destroy()
```

引擎销毁时仍会统一销毁所有曾注册的 renderer，避免正在展示的卡片被提前留下。

多路页面继续阅读[共享动画预算](../how-to/shared-overlay-budget.md)。

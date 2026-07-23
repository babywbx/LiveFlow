# 渲染自定义灯牌

平台层先把原始身份字段投影成 `DanmakuIdentity`。`assetKey` 是受限资源标识，不是可以直接
写入图片 `src` 的 URL。

```ts
const renderer = createDomDanmakuRenderer({
  container,
  assetResolver: {
    resolve(assetKey) {
      return approvedAssets.get(assetKey) ?? null
    },
  },
})
```

默认 renderer 会分别创建身份图片和标签节点。解析失败或协议不允许时省略图片，文字标签仍然
保留。

需要完全自定义结构时传入 `identityRenderer`：

```ts
const renderer = createDomDanmakuRenderer({
  container,
  identityRenderer: {
    render(identity, identityContainer) {
      const label = document.createElement('span')
      label.textContent = identity.label
      identityContainer.append(label)

      return {
        destroy(): void {
          label.remove()
        },
      }
    },
  },
})
```

约束：

- 所有上游文字使用 `textContent`；
- 不从 `assetKey` 自行拼 URL；
- 返回句柄必须可重复销毁；
- renderer 不保存无上限的历史身份；
- 身份只改变自己的节点，不把颜色或等级传播到整条正文。

如果身份需要图片，仍应通过应用维护的 allowlist 或资源映射表解析。不要把平台原始 URL
直接塞进通用消息。

# 接入结构化诊断

每个引擎都接受 `onDiagnostic`。回调接收稳定短码、级别、可选 generation 和受限标量
detail。

```ts
const controller = createContinuityController({
  adapter,
  contractVersion: CONTRACT_VERSION,
  onDiagnostic(event) {
    logger.write({
      module: 'liveflow',
      scope: event.scope,
      event: event.code,
      level: event.level,
      generation: event.generation,
      detail: event.detail,
    })
  },
})
```

## 不要记录原始 source

诊断事件不会包含媒体 URL、消息对象、Cookie 或 token。转发时也不要把当前 source 或平台
原始 payload 重新附加进去。

## 使用稳定短码

`code` 用于聚合和告警，不能直接作为面向用户的文案。用户提示由应用根据自己的产品状态
生成。

## 回调失败

诊断回调抛错不会改变引擎状态。相同诊断码还有速率限制，因此诊断出口不能被用作逐条消息
数据管道。如果需要消息级统计，应定期读取对应引擎的 metrics。

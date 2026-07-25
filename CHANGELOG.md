# 变更日志

本文件记录 LiveFlow 的显著变更，格式参考 Keep a Changelog，版本号遵循语义化版本。

从 `v1.0.0` 起，公共接口遵循语义化版本兼容规则。

## [未发布]

### 新增

- 播放器控件显隐控制器 `@babywbx/liveflow/chrome`：移动唤起、空闲隐藏、pin 计数、
  focus-within 与播放期常驻，时间走注入的 `Clock`，与框架无关。
- 多路宫格布局模块 `@babywbx/liveflow/multiview`：网格阶梯、等比瓦片盒，以及列与行成对给出的
  显式 CSS 轨道声明。
- 连续性快照新增 `healthySince`：当前健康连播的起始时钟读数，调用方据此清除重试退避，
  不再把「地址取到了」误当成「播放成功了」。
- 连续性新增 `suspended` 状态与 `resume()`：浏览器省电暂停（`AbortError`）与自动播放
  拦截（`NotAllowedError`）不再被当作换源失败。
- 可注入的 `PageActivitySource`，以及基于 `visibilitychange` 的
  `@babywbx/liveflow/page-activity` 实现，页面重新可见时自动续播。

### 变更

- `SourceTransitionError` 新增脱敏的 `reason`（仅上游错误类名），仍不携带 `cause` 与
  上游 message，避免签名媒体 URL 外泄。

## [1.0.0] - 2026-07-23

### 新增

- 连续性控制器：generation 门禁、无闪烁首帧交接、柔性追帧与有界恢复。
- 原生 `<video>` 与 ArtPlayer-like 可选 adapter。
- 有界弹幕调度器与安全结构化 DOM renderer。
- 实时事件引擎、renderer registry 与显式共享的跨实例预算协调器。
- 结构化诊断、类型化错误、默认上限与完整公开参考。
- 四路与九路合成及真实 DOM 耐久测试、三浏览器生命周期测试和包体预算门禁。
- 延迟加载示例、双语 README、教程、操作指南和架构说明。

### 安全

- 核心零运行时依赖，模块求值不访问 DOM。
- 上游文字只通过安全文本 API 渲染，资源只通过调用方 resolver 加载。
- 所有长期运行集合、监听器、计时器、DOM 节点池和字符串都有明确上限。
- 构建不生成或分发 sourcemap，错误与诊断不包含媒体 URL 或原始消息。
- 销毁不等待无法结束的候选播放器创建，迟到资源仍会独立回收。
- 默认资源渲染器拒绝非 HTTP、HTTPS 或 blob URL。

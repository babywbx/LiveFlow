# 变更日志

本文件记录 LiveFlow 的显著变更，格式参考 Keep a Changelog，版本号遵循语义化版本。

从 `v1.0.0` 起，公共接口遵循语义化版本兼容规则。

## [1.4.0] - 2026-08-07

### 新增

- 连续性新增 `cancelRecovery(generation)`：调用方查完发现这一路不需要换源时撤回本次恢复
  请求，把占用的恢复次数还回去并清掉冷却。此前恢复次数只在替换源产生首帧时清零，一路
  反复自愈的流会在播放完全正常的情况下耗尽 `maxAutomaticRecoveries` 进入 `waiting-reopen`。
- 卡顿先解救、再换源：适配器可选实现 `seek(seconds)` 后，控制器在 `stall` 与 `latency`
  恢复真正发起之前先尝试跳过缓冲空洞或推进播放头。`PlaybackMetrics` 随之新增可选
  `strandedGapSeconds`，策略新增 `maxGapJumpSeconds`、`stallNudgeSeconds` 与
  `maxStallSeeksPerSource`。原生 `<video>` 适配器已实现 `seek` 与空洞上报。
- 策略新增 `maxPlausibleLiveEdgeSeconds`（默认 3600）：超过它的尾距按时间轴损坏处理，
  只归一速率并发出 `implausible-live-edge` 诊断，不再追帧、seek 或换源。容器时间戳
  32 位回绕会让缓冲末端跳到约四百万秒之后，此前这会被当成「落后四十九天」，把恢复预算
  和 seek 次数全部烧光，而画面其实一直是好的。
- 新增诊断码 `stall-seek`、`recovery-cancelled` 与 `implausible-live-edge`。

### 修复

- 预热超时现在无论当前状态如何都会释放该代际的候选源。候选源自己先报错时会把状态从
  `warming` 推到 `degraded`，超时回调因此早退，候选的媒体元素和它的连接会永久滞留。

### 变更

- `DanmakuEngine.resize()` 接受可选的第二个参数改写策略。字号变化导致轨道高度必须跟着变
  时不再需要销毁重建引擎，在途弹幕除放不下的以外都会保留。
- 替换源产生首帧时一并清零恢复冷却计时。成功的恢复不该继续节流后面一次不相干的故障，
  否则一路流恢复后正常播放数秒、再次出问题时会白等完整个冷却窗口。

## [1.3.0] - 2026-07-25

### 新增

- 三个可选播放器适配器子路径：`@babywbx/liveflow/dplayer`、`@babywbx/liveflow/videojs`
  和 `@babywbx/liveflow/xgplayer`，共享同一套受管播放器生命周期，均按各自的包体预算门禁
  单独计量。

## [1.2.0] - 2026-07-25

### 新增

- 原生 `<video>` 适配器新增可选 `binding`：调用方接管取源与卸载，用于把 MSE 播放器接入
  控制器的 generation 门禁。省略时行为不变，仍走 `src` 直连。

## [1.1.0] - 2026-07-25

### 新增

- 事件横幅呈现器（`@babywbx/liveflow/overlay`）：有界活动集合、字号阶梯与截断、素材失败
  就地降级为紧凑样式、注入式渲染面，平台素材与文案仍留在调用方。
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

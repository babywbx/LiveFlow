# generation 如何隔离异步媒体任务

换源涉及 prepare、播放器提交、播放启动、首帧和多个异步事件。这些步骤可能乱序完成。只用
“当前 URL”判断会产生竞态：旧请求晚到时可能覆盖新画面，旧播放器事件也可能修改当前状态。

LiveFlow 为每次 `setSource()` 分配单调递增的 generation。

## 门禁规则

每个 prepared source 和播放事件都携带 generation。控制器只接受当前 generation：

- 旧 prepare 完成后只能 discard；
- 旧事件只产生受限诊断，不能迁移状态；
- 旧计时器触发时先核对 generation；
- adapter 在 commit seam 再做一次 generation 校验。

控制器和 adapter 的双重校验覆盖了不同竞态。控制器阻止旧结果进入决策流程；adapter 阻止
已经开始执行的旧提交覆盖媒体实例。

## 首帧为什么也是门禁

prepare 或 `play()` 成功不代表用户已经看到新画面。新候选只有在自己的首帧可见后才完成
交接。在此之前，旧媒体保持可见。

如果候选超时、失败或被下一次换源取代，它会被 discard。只有当前 generation 的首帧可以
进入 `playing` 并清零成功恢复链。

## generation 不代表平台状态

generation 描述浏览器内的媒体代际，不代表一次直播场次，也不判断主播在线或离线。签名 URL
刷新、CDN 切换、画质切换都可以产生新 generation，而平台状态仍由调用方拥有。

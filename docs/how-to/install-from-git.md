# 以 Git 依赖安装 LiveFlow

LiveFlow 通过仓库中已提交的 `dist/` 分发，不发布到 npm。

根包没有 `prepare` 或其他安装期构建脚本。Git 安装直接使用已经过 CI 验证的 `dist/`，
不会要求消费项目开放依赖构建权限，也不会在生产构建机现场解析工具链。

## 安装

在消费项目中添加跟踪 `main` 的依赖：

```json
{
  "dependencies": {
    "@babywbx/liveflow": "git+https://github.com/babywbx/LiveFlow.git#main"
  }
}
```

然后正常安装：

```bash
pnpm install
```

依赖声明保持 `#main`。pnpm 锁文件会记录本次解析到的准确提交，因此正常的冻结安装不会在
无人参与时自动漂移。

## 显式升级

需要跟进上游时运行：

```bash
pnpm update @babywbx/liveflow
```

检查应用的类型、构建和测试后提交锁文件变化。生产和 CI 使用：

```bash
pnpm install --frozen-lockfile
```

## 回滚

回滚升级时恢复上一版锁文件即可。不要删除锁文件后重新安装，也不要把依赖声明手工改写成
某个提交 SHA；依赖声明负责表达跟踪策略，锁文件负责记录已经验证的实际版本。

## 验证入口

在无 DOM 的构建步骤中可以安全导入根入口和核心子路径：

```ts
import { CONTRACT_VERSION } from '@babywbx/liveflow'
import { createContinuityController } from '@babywbx/liveflow/continuity'
import { createDanmakuEngine } from '@babywbx/liveflow/danmaku'
import { createOverlayEngine } from '@babywbx/liveflow/overlay'
```

播放器 adapter 使用独立子路径，不会被核心入口静态加载。

# 多路宫格布局参考

`@babywbx/liveflow/multiview` 提供多路同看宫格的布局数学：把瓦片数量映射成网格阶梯，按固定
宽高比算出居中的瓦片盒，并给出与之匹配的 CSS 轨道声明。

这个模块是一组纯函数。它不创建 DOM、不读取布局、不注册监听器，也不持有任何状态，因此在服务端
渲染环境求值同样安全。它不决定瓦片里放什么，也不替调用方写样式。

## 网格阶梯

```ts
import { multiviewGridSpec } from '@babywbx/liveflow/multiview'

interface MultiviewGridSpec {
  columns: number
  rows: number
  placeholders: number
}

const spec = multiviewGridSpec(7) // { columns: 3, rows: 3, placeholders: 2 }
```

列数取 `ceil(sqrt(tileCount))`，行数取 `ceil(tileCount / columns)`，`placeholders` 是网格里没有
瓦片占用的空单元数量。默认上限为九路时的阶梯如下：

| 瓦片数 | 列 × 行 | 占位 | 瓦片数 | 列 × 行 | 占位 |
| -----: | ------- | ---: | -----: | ------- | ---: |
|      0 | 0 × 0   |    0 |      5 | 3 × 2   |    1 |
|      1 | 1 × 1   |    0 |      6 | 3 × 2   |    0 |
|      2 | 2 × 1   |    0 |      7 | 3 × 3   |    2 |
|      3 | 2 × 2   |    1 |      8 | 3 × 3   |    1 |
|      4 | 2 × 2   |    0 |      9 | 3 × 3   |    0 |

`tileCount` 为 `0` 表示没有可布局的内容，返回全零 spec，这是合法结果而不是错误。

### 上限

```ts
multiviewGridSpec(12, { maxTiles: 16 }) // { columns: 4, rows: 3, placeholders: 0 }
```

`maxTiles` 默认为 `DEFAULT_MULTIVIEW_MAX_TILES`（`9`），省略时行为与九路宫格完全一致。它只约束
**瓦片数量**，不改变阶梯形状；补齐后的网格单元数可能略多于 `maxTiles`。

`tileCount` 超过 `maxTiles` 时抛出 `CapacityExceededError`，不会静默截断成上限那一格。要展示更多
路数的调用方应显式提高 `maxTiles`，或者在调用之前自行裁剪列表。

## 瓦片盒

```ts
import { multiviewGridBox } from '@babywbx/liveflow/multiview'

interface MultiviewGridBox {
  width: number
  height: number
  tileWidth: number
  tileHeight: number
}

const box = multiviewGridBox({
  stage: { width: 1600, height: 900 },
  spec,
  gap: 12,
  aspectRatio: 16 / 9,
})
```

| 字段          | 类型                 | 必填 | 说明                                                          |
| ------------- | -------------------- | ---- | ------------------------------------------------------------- |
| `stage`       | `MultiviewStageSize` | 是   | 可用舞台尺寸，两个分量都必须是非负有限数                      |
| `spec`        | `MultiviewGridSpec`  | 是   | 通常来自 `multiviewGridSpec()`                                |
| `gap`         | `number`             | 是   | 相邻瓦片之间的间距，非负有限数                                |
| `aspectRatio` | `number`             | 否   | 瓦片宽高比，默认 `DEFAULT_MULTIVIEW_ASPECT_RATIO`（`16 / 9`） |

先从舞台里扣掉 `gap * (columns - 1)` 与 `gap * (rows - 1)`，再在「宽度受限」和「高度受限」两个候选
里取较小的瓦片宽度，因此瓦片宽高比恒等于 `aspectRatio`，整块网格永远落在舞台内部。返回的 `width`
与 `height` 是网格实际占据的尺寸，调用方据此把网格在舞台里居中。

舞台任一边为 `0`、spec 为空，或者间距已经吃掉全部可用空间时，返回全零盒。这表示「当前没有可用
空间」，是合法结果；只有非法参数才抛错。

## 轨道声明

```ts
import { multiviewGridTracks } from '@babywbx/liveflow/multiview'

interface MultiviewGridTracks {
  gridTemplateColumns: string
  gridTemplateRows: string
}

multiviewGridTracks(spec) // { gridTemplateColumns: 'repeat(3, 1fr)', gridTemplateRows: 'repeat(3, 1fr)' }
```

空 spec 返回 `{ gridTemplateColumns: 'none', gridTemplateRows: 'none' }`，对应 CSS 里「没有显式
网格」的初始值。

> \[!IMPORTANT\]
> **两条轨道必须一起写进样式。** 只声明列轨道时，行轨道是隐式的 `auto`：占位元素会按自身内容撑高
> 所在行，瓦片高度不再等于 `tileHeight`，宽高比随之偏离 `aspectRatio`，视频两侧出现黑边。瓦片盒的
> 数学只有在行轨道同样是 `repeat(rows, 1fr)` 时才成立，因此这个模块把两条轨道作为同一个返回值给出。

## 组合用法

```ts
const spec = multiviewGridSpec(tiles.length)
const box = multiviewGridBox({ stage, spec, gap: 12 })
const tracks = multiviewGridTracks(spec)

Object.assign(grid.style, {
  display: 'grid',
  gap: '12px',
  width: `${String(box.width)}px`,
  height: `${String(box.height)}px`,
  gridTemplateColumns: tracks.gridTemplateColumns,
  gridTemplateRows: tracks.gridTemplateRows,
})
```

`gap` 必须与传给 `multiviewGridBox()` 的值一致，否则盒子尺寸与实际排布会互相矛盾。占位元素照常
渲染进网格，用来补齐最后一行；由于行轨道是 `1fr` 均分，它们不会改变任何瓦片的尺寸。

## 常量

| 常量                             |       值 | 说明                   |
| -------------------------------- | -------: | ---------------------- |
| `DEFAULT_MULTIVIEW_MAX_TILES`    |      `9` | `maxTiles` 的默认值    |
| `DEFAULT_MULTIVIEW_ASPECT_RATIO` | `16 / 9` | `aspectRatio` 的默认值 |

## 错误

| 场景                                                                      | 错误                          | `code`                     |
| ------------------------------------------------------------------------- | ----------------------------- | -------------------------- |
| `tileCount`、`maxTiles`、`gap`、`aspectRatio`、`stage` 或 `spec` 取值非法 | `InvalidMultiviewLayoutError` | `invalid-multiview-layout` |
| `tileCount` 超过 `maxTiles`                                               | `CapacityExceededError`       | `capacity-exceeded`        |

`InvalidMultiviewLayoutError` 的 `field` 指出具体字段（如 `tileCount`、`spec.rows`、
`stage.width`）。非有限数、负数、非整数轨道数，以及自相矛盾的手工 spec（例如 `columns` 为 `0` 而
`rows` 为 `2`，或者 `placeholders` 不小于总单元数）都会立即抛错，而不是返回一个看起来正常的零值。

完整错误族见[错误类型](./errors.md)。

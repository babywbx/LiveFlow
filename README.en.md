<div align="center"><a name="readme-top"></a>

# LiveFlow

A browser-side live playback continuity and realtime overlay stack.<br/>
Three independent bounded engines: media continuity, structured danmaku, and realtime event cards.

[简体中文](./README.md) · [Report Bug][github-issues-link] · [Changelog][changelog-link] · [Docs][docs-link]

<!-- SHIELD GROUP -->

[![][github-stars-shield]][github-stars-link]
[![][github-forks-shield]][github-forks-link]
[![][github-issues-shield]][github-issues-link]
[![][github-license-shield]][github-license-link]<br/>
[![][github-contributors-shield]][github-contributors-link]
[![][github-lastcommit-shield]][github-lastcommit-link]
[![][github-ci-shield]][github-ci-link]
[![][node-shield]][node-link]

</div>

<details>
<summary><kbd>Table of Contents</kbd></summary>

#### TOC

- [✨ Features](#-features)
- [📋 Scope](#-scope)
- [📦 Installation](#-installation)
- [🚀 Quick Start](#-quick-start)
- [🧩 Entry Points](#-entry-points)
- [📖 API](#-api)
- [🔧 Configuration](#-configuration)
- [🔍 Key Behaviors](#-key-behaviors)
- [🌐 Browser Baseline](#-browser-baseline)
- [📚 Documentation](#-documentation)
- [🛠 Development](#-development)
- [❓ FAQ](#-faq)
- [📝 License](#-license)

####

<br/>

</details>

## ✨ Features

- **Seamless source transitions.** A candidate media instance is warmed up hidden, gated by a
  generation counter, revealed atomically on its first frame, and rolled back on failure.
- **Playback continuity.** Gentle catch-up toward the live edge, stall debouncing, and recovery
  requests bounded by a cooldown and a hard attempt ceiling.
- **Structured danmaku.** Badges, levels, sender names, and body text stay separate DOM nodes, so
  identity semantics never get flattened into a formatted string.
- **Bounded realtime events.** Priority, deduplication, expiry, per-kind renderer registry, and a
  single safe DOM renderer with no `innerHTML`.
- **Cross-instance budget.** Four- or nine-player grids share explicit ceilings for full cards and
  high-cost animations through a coordinator the page creates and owns.
- **Lazy by construction.** The root entry, three engines, and five player adapters are independent
  ESM subpaths; nothing downloads until playback actually starts.
- **Zero runtime dependencies.** Module evaluation touches no DOM, timers, or globals, so importing
  the core entry is safe during server-side rendering.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 📋 Scope

LiveFlow solves two problems: keeping live playback continuous across weak networks, short
outages, line switches, quality changes, and media generation changes; and presenting realtime
danmaku and structured event cards over the video in a bounded, extensible way.

It is not bound to any player. Native `<video>`, ArtPlayer-like, DPlayer-like, Video.js-like, and
XGPlayer-like seams are optional adapters behind the same `LivePlayerAdapter` interface.

**Non-goals.** LiveFlow does not implement ingest, transcoding, recording, media distribution,
stream URL resolution, platform signatures, platform chat protocols, backend proxies, message
persistence, HLS / FLV / DASH decoding, a complete player UI, gift assets, or framework-level state
management. The host application owns platform state and projects it into the generic models below.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 📦 Installation

LiveFlow is distributed from Git and is not published to npm. The built `dist/` is committed to the
repository, so a Git install needs no install-time build step in the consuming project.

Declare the dependency as a floating reference to `main`:

```json
{
  "dependencies": {
    "@babywbx/liveflow": "git+https://github.com/babywbx/LiveFlow.git#main"
  }
}
```

```bash
pnpm install
```

The lockfile records the exact resolved commit, so a frozen install never drifts on its own. Follow
upstream explicitly:

```bash
pnpm update @babywbx/liveflow   # then verify the app and commit the lockfile
pnpm install --frozen-lockfile  # production and CI
```

> \[!IMPORTANT\]
> Keep the declaration on `#main`. The declaration expresses the tracking policy; the lockfile
> records the verified commit. Rewriting the declaration into a commit SHA breaks that split.

Full details: [Install from Git](./docs/how-to/install-from-git.md).

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 🚀 Quick Start

### Continuity with a native `<video>`

Nothing is downloaded until the viewer actually starts playback:

```ts
async function startLive(video: HTMLVideoElement, url: string): Promise<void> {
  const [{ CONTRACT_VERSION }, continuity, nativeVideo] = await Promise.all([
    import('@babywbx/liveflow'),
    import('@babywbx/liveflow/continuity'),
    import('@babywbx/liveflow/native-video'),
  ])

  const adapter = nativeVideo.createNativeVideoAdapter({ video })
  const controller = continuity.createContinuityController({
    adapter,
    contractVersion: CONTRACT_VERSION,
    onRecoveryRequest(request) {
      void resolveFreshSource(request).then((source) => controller.setSource(source))
    },
  })

  await controller.setSource({ url, kind: 'live' })
}
```

`setSource()` starts a new generation for every quality change, line switch, signature refresh, or
media generation change. There is no `setQuality()` or `setCdn()` — resolution stays with the caller.

### Structured danmaku

```ts
const [{ CONTRACT_VERSION }, danmaku, dom] = await Promise.all([
  import('@babywbx/liveflow'),
  import('@babywbx/liveflow/danmaku'),
  import('@babywbx/liveflow/danmaku/dom'),
])

const renderer = dom.createDomDanmakuRenderer({
  container,
  backgroundColor: '#000000',
  assetResolver: { resolve: (assetKey) => assets.get(assetKey) ?? null },
})

const engine = danmaku.createDanmakuEngine({
  contractVersion: CONTRACT_VERSION,
  renderer,
  viewport: { width: 1280, height: 720 },
})

engine.push({
  id: 'message-1',
  receivedAt: performance.now(),
  text: 'A synthetic message.',
  mode: 'scroll',
  priority: 0,
  sender: { displayName: 'Synthetic viewer' },
  identities: [{ kind: 'member', label: 'Synthetic badge', level: 7 }],
})
```

### Realtime event cards

```ts
const { CONTRACT_VERSION, createOverlayEngine } = await import('@babywbx/liveflow/overlay')

const overlay = createOverlayEngine({
  contractVersion: CONTRACT_VERSION,
  instanceId: 'primary-player',
  container,
})

overlay.submit({
  id: 'paid-1',
  kind: 'paid-message',
  receivedAt: performance.now(),
  priority: 80,
  durationMs: 8_000,
  nodes: [
    { type: 'identity', identity: { kind: 'member', label: 'Synthetic member' } },
    { type: 'metric', role: 'value', label: 'Support', value: '99' },
    { type: 'text', role: 'body', text: 'A synthetic paid message.' },
  ],
})
```

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 🧩 Entry Points

Every engine and adapter is a separate ESM subpath. The root entry exports only the shared contract
and never statically pulls in an engine or a player runtime.

| Subpath                            | Provides                                             |   gzip | Budget |
| ---------------------------------- | ---------------------------------------------------- | -----: | -----: |
| `@babywbx/liveflow`                | `CONTRACT_VERSION`, shared types, typed errors       |      — |      — |
| `@babywbx/liveflow/continuity`     | Continuity controller and player adapter contract    | 4.7 KB |   6 KB |
| `@babywbx/liveflow/danmaku`        | Bounded danmaku scheduler                            | 4.9 KB |   7 KB |
| `@babywbx/liveflow/danmaku/dom`    | Safe structured DOM renderer and color helpers       | 2.8 KB |   4 KB |
| `@babywbx/liveflow/overlay`        | Realtime event engine and shared budget coordinator  | 5.6 KB |   8 KB |
| `@babywbx/liveflow/overlay/banner` | Event banner presenter (optional)                    | 4.0 KB |   5 KB |
| `@babywbx/liveflow/chrome`         | Player chrome visibility controller                  | 1.4 KB |   2 KB |
| `@babywbx/liveflow/multiview`      | Multiview grid layout math and grid track contract   | 0.9 KB |   2 KB |
| `@babywbx/liveflow/native-video`   | Native `<video>` adapter                             | 3.0 KB |   4 KB |
| `@babywbx/liveflow/page-activity`  | Page visibility source for suspended playback        | 0.5 KB |   2 KB |
| `@babywbx/liveflow/artplayer`      | ArtPlayer-like seam with no static player dependency | 3.0 KB |   4 KB |
| `@babywbx/liveflow/dplayer`        | DPlayer-like seam with no static player dependency   | 3.0 KB |   4 KB |
| `@babywbx/liveflow/videojs`        | Video.js-like seam with no static player dependency  | 3.2 KB |   4 KB |
| `@babywbx/liveflow/xgplayer`       | XGPlayer-like seam with no static player dependency  | 3.0 KB |   4 KB |

Measured minified and gzipped by `pnpm size:check`, which fails CI on any regression past the
budget column. The four core subpaths combined measure 15.1 KB against a 20 KB ceiling.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 📖 API

### Shared contract — `@babywbx/liveflow`

```ts
import { CONTRACT_VERSION, LiveFlowError } from '@babywbx/liveflow'
```

`CONTRACT_VERSION` is currently `1`. Every engine factory takes it and throws
`ContractVersionMismatchError` on creation when it does not match. There is no compatibility
guessing at runtime.

The root entry also exports `Clock`, `Destroyable` / `AsyncDestroyable`, `DiagnosticEvent`, and the
shared error classes:

```ts
interface Clock {
  now(): number
  setTimeout(handler: () => void, delayMs: number): number
  clearTimeout(handle: number): void
  requestFrame(handler: (timestampMs: number) => void): number
  cancelFrame(handle: number): void
}

interface DiagnosticEvent {
  scope: 'continuity' | 'danmaku' | 'overlay'
  code: string
  level: 'debug' | 'info' | 'warn'
  generation?: number
  detail?: Readonly<Record<string, string | number | boolean>>
}
```

`now()` must be monotonic. Diagnostics are rate-limited state signals, not a per-message data pipe;
`detail` carries bounded scalars only — never media URLs, raw messages, or platform payloads.
Reference: [Shared contract](./docs/reference/shared.md), [Diagnostics](./docs/reference/diagnostics.md).

### Continuity — `@babywbx/liveflow/continuity`

```ts
import { createContinuityController } from '@babywbx/liveflow/continuity'

interface ContinuityController {
  setSource(source: LiveSource): Promise<void>
  resume(): Promise<void>
  cancelRecovery(generation: number): void
  getSnapshot(): ContinuitySnapshot
  subscribe(listener: ContinuitySnapshotListener): () => void
  destroy(): Promise<void>
}
```

| Option              | Type                        | Required | Notes                                                |
| ------------------- | --------------------------- | -------- | ---------------------------------------------------- |
| `adapter`           | `LivePlayerAdapter`         | Yes      | Owned by the controller and destroyed with it        |
| `contractVersion`   | `number`                    | Yes      | The `CONTRACT_VERSION` the caller compiled against   |
| `clock`             | `Clock`                     | No       | Monotonic clock; defaults to the browser clock       |
| `policy`            | `Partial<ContinuityPolicy>` | No       | Overrides the conservative defaults                  |
| `onRecoveryRequest` | `(request) => void`         | No       | Asks the caller to resolve and submit a fresh source |
| `onDiagnostic`      | `(event) => void`           | No       | Rate-limited structured diagnostics                  |

`setSource()` increments the generation, then runs `prepare()` → `commit()` → `play()` and waits for
that generation's `first-frame` event. The returned promise settles after `play()`, not after the
first frame. Warm-up shares a single `sourceWarmupTimeoutMs` deadline; late prepared sources are
discarded and can never commit.

`getSnapshot()` returns `{ state, generation, automaticRecoveryCount }` and deliberately omits the
media URL, so no signed parameter leaks into UI state or diagnostics. `subscribe()` keeps at most 32
distinct listeners and throws `CapacityExceededError` beyond that; a throwing listener never changes
controller state.

| State            | Meaning                                                       |
| ---------------- | ------------------------------------------------------------- |
| `idle`           | No source set yet                                             |
| `resolving`      | Preparing the current generation                              |
| `warming`        | Prepared, waiting for this generation's first frame           |
| `playing`        | The current generation produced a first frame                 |
| `degraded`       | Waiting, stall, error, or a sustained high live-edge distance |
| `recovering`     | One bounded recovery request is outstanding                   |
| `waiting-reopen` | Automatic recovery exhausted, unrecoverable, or no listener   |
| `stopped`        | The controller was destroyed                                  |

> \[!NOTE\]
> `ERROR` does not mean the broadcaster is offline. Continuity state never interprets platform
> status and never mutates the caller's platform state.

Recovery requests carry `{ reason, generation, attempt }` where `reason` is `'stall' | 'latency' |
'playback-error' | 'source-timeout'`. The attempt count survives across generations until a
replacement source produces a first frame, so a chain of failing source swaps cannot bypass the
ceiling. Reference: [Continuity](./docs/reference/continuity.md).

### Player adapters — `LivePlayerAdapter`

```ts
interface LivePlayerAdapter {
  prepare(source: LiveSource, generation: number): Promise<PreparedSource>
  commit(prepared: PreparedSource, generation: number): Promise<void>
  discard(prepared: PreparedSource): Promise<void>
  play(): Promise<void>
  pause(): void
  setMuted(muted: boolean): void
  setVolume(volume: number): void
  setPlaybackRate(rate: number): void
  getMetrics(): PlaybackMetrics
  subscribe(listener: PlaybackEventListener): () => void
  destroy(): Promise<void>
}
```

An adapter must not replace the visible media during `prepare()`, must reject stale generations in
`commit()`, must reveal the candidate atomically _before_ emitting `first-frame`, must make
`discard()` and `destroy()` idempotent, must tag every `PlaybackEvent` with its generation, and must
never put a signed URL, cookie, or token into an error.

Five implementations ship with the library:

```ts
import { createNativeVideoAdapter } from '@babywbx/liveflow/native-video'
import { createArtPlayerAdapter } from '@babywbx/liveflow/artplayer'
import { createDPlayerAdapter } from '@babywbx/liveflow/dplayer'
import { createVideoJsAdapter } from '@babywbx/liveflow/videojs'
import { createXgPlayerAdapter } from '@babywbx/liveflow/xgplayer'
```

`createNativeVideoAdapter({ video })` creates the hidden candidate in the same parent node, copies
`controls` / `playsInline` / `className`, and swaps visibility on the first frame — using
`requestVideoFrameCallback` where available and the `playing` event otherwise. Candidates stay muted
until the handoff, so two instances never sound at once. The caller keeps DOM ownership of the
element it passed in; every node the adapter created is removed by the adapter.

`createArtPlayerAdapter({ player, createPlayer })` never statically imports a player package. The
caller supplies a small `ArtPlayerLike` wrapper (underlying `video`, `on` / `off`, `setMutex(false)`,
`destroy()`, optional `container` and `overlayContainer`) plus a factory that returns a fresh
instance per call.

`createDPlayerAdapter`, `createVideoJsAdapter`, and `createXgPlayerAdapter` follow the same wrapper
pattern: structural `*Like` interfaces plus a candidate factory, with no static player imports. The
DPlayer seam accommodates its event system that has no `off`; the Video.js seam resolves the media
element through `el()` and tolerates `dispose()` detaching the host from the DOM; the XGPlayer seam
resolves the media element from `media` then `video` and uses `root` as the default container.

All adapters accept a custom surface whose `reveal` must be synchronous and atomic.
Reference: [Adapters](./docs/reference/adapters.md),
[Custom player adapter](./docs/how-to/custom-player-adapter.md).

### Danmaku — `@babywbx/liveflow/danmaku`

```ts
import { createDanmakuEngine } from '@babywbx/liveflow/danmaku'

interface DanmakuEngine {
  push(message: DanmakuMessage): DanmakuPushResult
  getMetrics(): DanmakuMetrics
  pause(): void
  resume(): void
  resize(viewport: DanmakuViewport, policy?: Partial<DanmakuPolicy>): void
  destroy(): void
}
```

The engine takes `{ contractVersion, renderer, viewport }` plus optional `clock`, `limits`,
`policy`, and `onDiagnostic`. `renderer` is the only rendering seam: each frame the core batches a
`measure()` call and delivers mounts, position updates, and unmounts in a single `render()`. Callers
never build a per-message animation loop, and the engine requests no frame at all while idle.

```ts
interface DanmakuMessage {
  id: string
  receivedAt: number
  text: string
  mode: 'scroll' | 'top' | 'bottom'
  priority: number
  color?: string
  sender?: { displayName?: string }
  identities?: readonly DanmakuIdentity[]
  metadata?: Readonly<Record<string, unknown>>
}

interface DanmakuIdentity {
  kind: string
  label: string
  level?: number
  variant?: string
  assetKey?: string
}
```

`kind`, `variant`, and `assetKey` are caller-defined strings with no platform semantics. Multiple
identities remain separate nodes; the engine never infers one identity from another and never lets
an identity level recolor the body text. Body color accepts `#rgb` or `#rrggbb` only.

`push()` validates and copies synchronously. `accepted: true` means the message entered the bounded
pending queue — not that it will be shown, because it can still expire or find no lane. Structural
violations throw `InvalidDanmakuMessageError`; over-long text is rejected with a `text-too-long`
reason instead. Excess identities are truncated and `metadata` is dropped as a whole block, but the
body is never silently lost.

`getMetrics()` reports `received`, `displayed`, `dropped`, `pendingDepth`, `visible`,
`frameBudgetOverruns`, `metadataDiscarded`, and `droppedByReason` broken down by duplicate, expiry,
rate limit, capacity, lane starvation, and measurement failure. Reference:
[Danmaku](./docs/reference/danmaku.md).

### DOM renderer — `@babywbx/liveflow/danmaku/dom`

```ts
import { createDomDanmakuRenderer } from '@babywbx/liveflow/danmaku/dom'
```

Importing the module touches no DOM; nodes and the optional media-query listener are created only by
the factory. The renderer mounts its own absolutely positioned layer with `pointer-events: none`,
`overflow: hidden`, and `aria-hidden="true"`, so it neither intercepts player input nor makes a
screen reader narrate animated messages. Each message becomes separate, safe text nodes:

```text
.liveflow-danmaku__message
  .liveflow-danmaku__identity[data-kind]
    .liveflow-danmaku__identity-asset
    .liveflow-danmaku__identity-label
  .liveflow-danmaku__sender
  .liveflow-danmaku__delimiter
  .liveflow-danmaku__text
```

Live and pooled root nodes together never exceed `maxPoolSize`; hitting the ceiling throws
`CapacityExceededError` rather than allocating more. Each frame recycles finished nodes, prepares
new ones in a `DocumentFragment`, mounts once, then batches `transform: translate3d(...)` writes.

The entry also exports `normalizeHexColor()`, `contrastRatio()`, and
`resolveAccessibleTextColor()`, which apply the WCAG relative-luminance formula against the supplied
`backgroundColor` and fall back to `fallbackTextColor` below a 4.5 ratio. Images resolve exclusively
through `assetResolver.resolve(assetKey)` and only relative or absolute HTTP, HTTPS, and Blob URLs
are accepted. Without an explicit `reducedMotion` value the renderer honours
`(prefers-reduced-motion: reduce)` by pinning messages in their lane. Reference:
[DOM renderer](./docs/reference/danmaku-dom.md), [Custom identities](./docs/how-to/custom-identity.md).

### Realtime overlay — `@babywbx/liveflow/overlay`

```ts
import {
  createOverlayBudgetCoordinator,
  createOverlayEngine,
  createSafeOverlayRenderer,
} from '@babywbx/liveflow/overlay'

interface OverlayEngine {
  submit(event: unknown): OverlaySubmitResult
  registerRenderer(kind: string, renderer: OverlayRenderer): Destroyable
  updateInstance(state: OverlayInstanceStateUpdate): void
  getMetrics(): OverlayMetrics
  destroy(): void
}
```

Engine options require `contractVersion`, `instanceId`, and one of `container` or `defaultRenderer`;
`clock`, `instanceState`, `coordinator`, `limits`, `assetResolver`, `onError`, and `onDiagnostic` are
optional. `submit()` deliberately takes `unknown` and validates the shape itself, so a projection
cannot skip validation with a type assertion. Events are composed from four node shapes, and
LiveFlow interprets none of them:

```ts
type OverlayNode =
  | { type: 'text'; role: string; text: string }
  | { type: 'identity'; identity: DanmakuIdentity }
  | { type: 'asset'; role: string; assetKey: string; alt: string }
  | { type: 'metric'; role: string; label: string; value: string }
```

| `submit()` status | Meaning                                                  |
| ----------------- | -------------------------------------------------------- |
| `displayed`       | Won a budget grant and started showing                   |
| `queued`          | Entered the bounded pending queue                        |
| `deduped`         | The same dedupe key is still inside the window           |
| `expired`         | Already past the maximum lifetime on arrival             |
| `dropped`         | No capacity in the queue, dedupe table, or shared budget |

Invalid fields throw `InvalidOverlayEventError` — an illegal event never becomes an empty card. A
full queue only replaces its lowest-priority entry when the newcomer is strictly higher, and stale
backlog is dropped rather than caught up by shortening durations.

`createSafeOverlayRenderer(container, options)` is the default renderer: upstream text goes only to
`textContent`, `compact` renders the first node only, assets resolve through the caller's
`AssetResolver`, and a missing or invalid URL omits the node instead of guessing.

The cross-instance budget is an explicit object, never a module-level singleton:

```ts
const coordinator = createOverlayBudgetCoordinator({
  maxInstances: 9,
  maxActiveCards: 3,
  maxFullCards: 1,
  maxHighCostAnimations: 1,
})

const registration = coordinator.register({
  instanceId: 'primary-player',
  weight: 10,
  focused: true,
  visible: true,
})
```

A grant's `presentation` is `full`, `compact`, or `suppressed`, ordered by focus, caller weight,
event priority, and request order. `activeCards`, `activeFull`, and `activeHighCost` never exceed
their configured ceilings. Reference: [Overlay](./docs/reference/overlay.md),
[Shared overlay budget](./docs/how-to/shared-overlay-budget.md).

### Multiview — `@babywbx/liveflow/multiview`

```ts
import {
  multiviewGridBox,
  multiviewGridSpec,
  multiviewGridTracks,
} from '@babywbx/liveflow/multiview'

const spec = multiviewGridSpec(7) // { columns: 3, rows: 3, placeholders: 2 }
const box = multiviewGridBox({ stage, spec, gap: 12 }) // tiles stay 16:9 inside the stage
const tracks = multiviewGridTracks(spec) // { gridTemplateColumns, gridTemplateRows }
```

Stateless pure functions: map a tile count onto a grid ladder, derive a centered tile box for a fixed
aspect ratio, and emit the matching CSS track declarations. The ceiling defaults to nine tiles and the
caller may raise `maxTiles`; going past it throws `CapacityExceededError` instead of silently
truncating. An empty stage, or a gap that consumes all available space, returns a zero box — that is
an absence of space, not a failure. Illegal arguments always throw `InvalidMultiviewLayoutError`.

> \[!IMPORTANT\]
> Column and row tracks must be applied together. Declaring columns alone leaves the row track at the
> implicit `auto`, where placeholder elements stretch their row, tiles stop being 16:9, and the video
> gains pillarboxes. The tile box math only holds when rows are evenly divided too, which is why both
> tracks come from one return value.

Reference: [Multiview](./docs/reference/multiview.md).

### Errors

Every public error extends `LiveFlowError` and carries a stable `code`. Match on
`instanceof LiveFlowError` for the family and aggregate by `code`; never depend on message text.

| Error                                   | `code`                                |
| --------------------------------------- | ------------------------------------- |
| `ContractVersionMismatchError`          | `contract-version-mismatch`           |
| `CapacityExceededError`                 | `capacity-exceeded`                   |
| `AssetResolutionError`                  | `asset-resolution-failed`             |
| `InvalidContinuityPolicyError`          | `invalid-continuity-policy`           |
| `InvalidPlaybackMetricsError`           | `invalid-playback-metrics`            |
| `PreparedSourceGenerationMismatchError` | `prepared-source-generation-mismatch` |
| `SourceTransitionError`                 | `source-{phase}-failed`               |
| `InvalidDanmakuMessageError`            | `invalid-danmaku-message`             |
| `InvalidOverlayEventError`              | `invalid-overlay-event`               |
| `OverlayCapacityError`                  | `overlay-capacity-exceeded`           |
| `InvalidMultiviewLayoutError`           | `invalid-multiview-layout`            |
| `PlayerAdapterError`                    | Stable per-operation codes            |

The full table, including configuration, clock, renderer, scheduling, and cleanup errors, is in
[Errors](./docs/reference/errors.md).

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 🔧 Configuration

Every default is conservative and every limit is validated at creation time. Illegal, non-finite, or
mutually contradictory values throw a typed configuration error instead of being clamped.

**Continuity policy** — `DEFAULT_CONTINUITY_POLICY`:

| Field                         | Default | Field                    | Default |
| ----------------------------- | ------: | ------------------------ | ------: |
| `targetLatencySeconds`        |     `2` | `recoveryCooldownMs`     | `30000` |
| `softCatchupThresholdSeconds` |   `0.6` | `sourceWarmupTimeoutMs`  |  `8000` |
| `hardResyncThresholdSeconds`  |     `8` | `reopenGraceMs`          | `90000` |
| `catchupRate`                 |  `1.04` | `maxAutomaticRecoveries` |     `4` |

**Danmaku limits and policy** — `DEFAULT_DANMAKU_LIMITS`, `DEFAULT_DANMAKU_POLICY`:

| Limit                 | Default | Policy                  |    Default |
| --------------------- | ------: | ----------------------- | ---------: |
| `maxPending`          |   `200` | `laneHeight`            |    `32` px |
| `maxVisible`          |    `80` | `laneGap`               |    `12` px |
| `maxPoolSize`         |    `96` | `scrollPixelsPerSecond` | `140` px/s |
| `maxTextLength`       |   `500` | `fixedDurationMs`       |     `4000` |
| `maxBadgesPerMessage` |     `4` | `maxPendingAgeMs`       |     `8000` |
| `maxMountsPerFrame`   |     `8` | `maxLaneWaitMs`         |     `2000` |
| `maxIntakePerSecond`  |   `120` | `duplicateWindowMs`     |      `500` |
| `maxDisplayPerSecond` |    `60` | `frameBudgetMs`         |        `8` |

`metadata` is additionally bounded by `maxMetadataKeys` (`16`), `maxMetadataDepth` (`2`), and
`maxMetadataBytes` (`2048`).

**Overlay limits** — `DEFAULT_OVERLAY_LIMITS`:

| Field              | Default | Field                | Default |
| ------------------ | ------: | -------------------- | ------: |
| `maxPending`       |    `32` | `maxRenderers`       |    `32` |
| `maxVisible`       |     `1` | `maxDedupeEntries`   |   `128` |
| `maxNodesPerEvent` |     `8` | `dedupeWindowMs`     | `15000` |
| `maxTextLength`    |   `512` | `maxEventLifetimeMs` | `30000` |

How-to guides: [Configure recovery](./docs/how-to/configure-recovery.md),
[Configure overload](./docs/how-to/configure-overload.md),
[Forward diagnostics](./docs/how-to/forward-diagnostics.md).

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 🔍 Key Behaviors

**Generation gating.** Every source change mints a new generation. Promises, events, and timers from
an older generation can never change current state, and an adapter must additionally reject stale
commits at its own seam so an in-flight swap cannot overwrite newer media.

**Provable boundedness.** Pending queues, visible sets, DOM node pools, text length, badge counts,
metadata keys and depth, mounts per frame, intake and display rates, and the instance registry all
have fixed ceilings. Overload drops by priority — the queue is never grown to "save" every message.

**Failures stay loud.** Unparseable input, out-of-range values, and contract mismatches throw typed
errors. Nothing degrades silently into a result that merely looks normal, and a renderer failure is
reported through `onError` and metrics instead of being counted as a successful display.

**Clean teardown.** After `destroy()` no frame callback, timer, observer, or listener survives, and
calling `destroy()` again is safe. Teardown attempts every step, then throws an aggregate error if
any step failed.

**Rendering safety.** Upstream data is never rendered through `innerHTML`. Text goes to
`textContent`, images load only through a caller-supplied `assetKey → URL` resolver, and errors and
diagnostics never carry a signed media URL, cookie, or token.

**No sourcemaps.** The build emits no `.map` files, no `sourceMappingURL`, and no `sourcesContent`;
a CI gate blocks any regression.

Background reading: [Architecture](./docs/explanation/architecture.md),
[Generation gating](./docs/explanation/generation-gating.md),
[Bounded realtime](./docs/explanation/bounded-realtime.md),
[Structured identities](./docs/explanation/structured-identities.md).

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 🌐 Browser Baseline

| Browser             | Minimum |
| ------------------- | ------: |
| Chrome / Edge       |     111 |
| Safari / iOS Safari |    16.4 |
| Firefox             |     128 |

Browser tests run on Chromium, Firefox, and WebKit, covering safe DOM output, reduced motion,
resize, pause and resume, container moves, repeat mounting, real four- and nine-instance DOM bounds,
and cleanup. No mobile simulator is required.

Core entries evaluate without a DOM, so importing them in a server-side rendering or build step is
safe. DOM, player, and animation resources are created only when the matching factory is called.

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 📚 Documentation

Public documentation lives in [`docs/`](./docs/reference/shared.md), split into tutorials, how-to
guides, reference, and explanation.
It is written in Chinese; API names and code samples are language-independent.

| Tutorials                                                            | How-to                                                          |
| -------------------------------------------------------------------- | --------------------------------------------------------------- |
| [Native video in ten minutes](./docs/tutorials/native-video.md)      | [Install from Git](./docs/how-to/install-from-git.md)           |
| [Show structured danmaku](./docs/tutorials/structured-danmaku.md)    | [Configure recovery](./docs/how-to/configure-recovery.md)       |
| [Register an overlay renderer](./docs/tutorials/overlay-renderer.md) | [Configure overload](./docs/how-to/configure-overload.md)       |
|                                                                      | [Custom identity rendering](./docs/how-to/custom-identity.md)   |
|                                                                      | [Custom player adapter](./docs/how-to/custom-player-adapter.md) |
|                                                                      | [Forward diagnostics](./docs/how-to/forward-diagnostics.md)     |
|                                                                      | [Shared overlay budget](./docs/how-to/shared-overlay-budget.md) |
|                                                                      | [Run the soak test](./docs/how-to/run-soak.md)                  |

| Reference                                                  | Explanation                                                          |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| [Shared contract](./docs/reference/shared.md)              | [Architecture](./docs/explanation/architecture.md)                   |
| [Continuity](./docs/reference/continuity.md)               | [Generation gating](./docs/explanation/generation-gating.md)         |
| [Danmaku](./docs/reference/danmaku.md)                     | [Bounded realtime](./docs/explanation/bounded-realtime.md)           |
| [DOM renderer](./docs/reference/danmaku-dom.md)            | [Structured identities](./docs/explanation/structured-identities.md) |
| [Overlay](./docs/reference/overlay.md)                     |                                                                      |
| [Event banner presenter](./docs/reference/event-banner.md) |                                                                      |
| [Multiview](./docs/reference/multiview.md)                 |                                                                      |
| [Chrome visibility](./docs/reference/chrome.md)            |                                                                      |
| [Adapters](./docs/reference/adapters.md)                   |                                                                      |
| [Diagnostics](./docs/reference/diagnostics.md)             |                                                                      |
| [Errors](./docs/reference/errors.md)                       |                                                                      |

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 🛠 Development

Node.js `>=22.5.0` and pnpm `11.16.0` are required.

| Purpose            | Command                                  |
| ------------------ | ---------------------------------------- |
| Full gate          | `pnpm check`                             |
| Type check         | `pnpm typecheck`                         |
| Format             | `pnpm format` / `pnpm format:check`      |
| Lint               | `pnpm lint`                              |
| Unit + integration | `pnpm test`                              |
| Browser            | `pnpm test:browser`                      |
| Soak               | `SOAK_DURATION_MS=300000 pnpm test:soak` |
| Build              | `pnpm build`                             |
| Bundle budget      | `pnpm size:check`                        |

`pnpm check` aggregates format check, type check, lint, doc-link check, tests, build, bundle budget,
and the example build. It is the de facto CI gate and must pass locally before every commit. Because
`dist/` ships with the repository, any change under `src/` must be rebuilt and committed together
with its build output.

The example workspace reads a local media file and generates synthetic messages. It never uploads
the selected file and never connects to a streaming platform:

```bash
pnpm --filter liveflow-examples dev
```

Contribution boundaries are described in [CONTRIBUTING.md](./CONTRIBUTING.md); report security
issues privately as described in [SECURITY.md](./SECURITY.md).

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## ❓ FAQ

<details>
<summary><kbd>Q: Why is it not on npm?</kbd></summary>

<br/>

The package is installed as a Git dependency and the built `dist/` is committed. A consumer
installing from Git would otherwise resolve this repository's devDependencies on its own build
machine and run a `prepare` script, so toolchain drift could break a production build that never
changed. Shipping the build output with the repository removes that risk surface entirely, and the
tag a consumer pins to has already passed CI on `main`.

</details>

<details>
<summary><kbd>Q: Does the core pull in a player runtime?</kbd></summary>

<br/>

No. The package declares no runtime dependencies, and the core entries never import a player, a
decoder, a Node built-in, or a UI framework. Player adapters live behind separate subpaths and are only downloaded
when the caller imports them.

</details>

<details>
<summary><kbd>Q: Can I use it with React, Vue, or Svelte?</kbd></summary>

<br/>

Yes. LiveFlow is framework-agnostic: it exposes plain factories that take a DOM container and return
objects with `destroy()`. Create engines in whatever lifecycle hook your framework provides and
destroy them on teardown.

</details>

<details>
<summary><kbd>Q: Why drop messages under overload instead of growing the queue?</kbd></summary>

<br/>

An unbounded queue converts a traffic spike into unbounded memory and unbounded latency, and a live
message that arrives thirty seconds late is worse than one that never arrives. Every queue therefore
has a fixed ceiling and drops by priority, with the drop reason recorded in metrics.

</details>

<details>
<summary><kbd>Q: Is importing the core safe during server-side rendering?</kbd></summary>

<br/>

Yes. Module evaluation creates no styles, frame callbacks, workers, observers, or global listeners
and never touches the DOM. Only the DOM renderer and the default adapter surfaces require a browser
environment, and only at factory-call time.

</details>

<details>
<summary><kbd>Q: Does an error state mean the broadcaster went offline?</kbd></summary>

<br/>

No. Continuity state describes media health only. LiveFlow never decides whether a broadcast ended;
that judgement and its presentation stay with the host application.

</details>

<div align="right">

[![][back-to-top]](#readme-top)

</div>

## 📝 License

Copyright © 2026-present [Babywbx][profile-link].<br/>
This project is released under the [MIT](./LICENSE) license.

<!-- LINK GROUP -->

[back-to-top]: https://img.shields.io/badge/-BACK_TO_TOP-151515?style=flat-square
[changelog-link]: ./CHANGELOG.md
[docs-link]: ./docs/reference/shared.md
[github-ci-link]: https://github.com/babywbx/LiveFlow/actions/workflows/ci.yml
[github-ci-shield]: https://img.shields.io/github/actions/workflow/status/babywbx/LiveFlow/ci.yml?branch=main&label=CI&labelColor=black&style=flat-square
[github-contributors-link]: https://github.com/babywbx/LiveFlow/graphs/contributors
[github-contributors-shield]: https://img.shields.io/github/contributors/babywbx/LiveFlow?color=c4f042&labelColor=black&style=flat-square
[github-forks-link]: https://github.com/babywbx/LiveFlow/network/members
[github-forks-shield]: https://img.shields.io/github/forks/babywbx/LiveFlow?color=8ae8ff&labelColor=black&style=flat-square
[github-issues-link]: https://github.com/babywbx/LiveFlow/issues
[github-issues-shield]: https://img.shields.io/github/issues/babywbx/LiveFlow?color=ff80eb&labelColor=black&style=flat-square
[github-lastcommit-link]: https://github.com/babywbx/LiveFlow/commits/main
[github-lastcommit-shield]: https://img.shields.io/github/last-commit/babywbx/LiveFlow?labelColor=black&style=flat-square
[github-license-link]: ./LICENSE
[github-license-shield]: https://img.shields.io/github/license/babywbx/LiveFlow?color=white&labelColor=black&style=flat-square
[github-stars-link]: https://github.com/babywbx/LiveFlow/stargazers
[github-stars-shield]: https://img.shields.io/github/stars/babywbx/LiveFlow?color=ffcb47&labelColor=black&style=flat-square
[node-link]: https://github.com/babywbx/LiveFlow/blob/main/package.json
[node-shield]: https://img.shields.io/badge/node-%3E%3D22.5.0-369eff?labelColor=black&style=flat-square
[profile-link]: https://github.com/babywbx

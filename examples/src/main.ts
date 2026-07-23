import type { ArtPlayerLike, ArtPlayerSurface } from '@babywbx/liveflow/artplayer'
import type { ContinuityController, LivePlayerAdapter } from '@babywbx/liveflow/continuity'
import type { DanmakuEngine } from '@babywbx/liveflow/danmaku'
import type { OverlayBudgetCoordinator, OverlayEngine } from '@babywbx/liveflow/overlay'
import type Artplayer from 'artplayer'

import './style.css'

const app = document.querySelector<HTMLElement>('#app')
if (app === null) {
  throw new Error('Example root is missing.')
}

let controller: ContinuityController | null = null
let adapter: LivePlayerAdapter | null = null
let unsubscribeController: (() => void) | null = null
let danmakuEngine: DanmakuEngine | null = null
let overlayEngine: OverlayEngine | null = null
let overlayCoordinator: OverlayBudgetCoordinator | null = null
let mediaUrl: string | null = null
let danmakuTimer: number | null = null
let danmakuResizeObserver: ResizeObserver | null = null
let messageSequence = 0
let eventSequence = 0
let actionInProgress = false

const header = createElement('header', 'masthead')
const brand = createElement('div', 'brand')
brand.append(
  createElement('span', 'brand-mark', 'LF'),
  createElement('div', 'brand-copy', 'LiveFlow'),
)
const runtimeBadge = createElement('span', 'runtime-badge', 'runtime idle')
header.append(brand, runtimeBadge)

const intro = createElement('section', 'intro')
const introCopy = createElement('div', 'intro-copy')
introCopy.append(
  createElement('p', 'eyebrow', 'BROWSER-SIDE LIVE LAB'),
  createElement('h1', 'headline', '让下一帧接住上一帧。'),
  createElement(
    'p',
    'lede',
    '选择一个本地视频，观察 generation 换源、结构化弹幕和有界事件卡如何独立运行。',
  ),
)
const signalTrace = createElement('div', 'signal-trace')
signalTrace.setAttribute('aria-hidden', 'true')
for (const height of ['26%', '62%', '38%', '82%', '44%', '70%', '32%', '58%', '24%', '74%']) {
  const bar = createElement('span', 'signal-bar')
  bar.style.setProperty('--signal-height', height)
  signalTrace.append(bar)
}
intro.append(introCopy, signalTrace)

const lab = createElement('section', 'lab')
const controls = createElement('aside', 'control-rail')
controls.append(createElement('h2', 'section-title', '输入与运行时'))

const fileLabel = createElement('label', 'file-control')
fileLabel.append(createElement('span', 'control-label', '本地视频'))
const fileInput = document.createElement('input')
fileInput.type = 'file'
fileInput.accept = 'video/*'
fileLabel.append(fileInput)

const nativeButton = createButton('使用原生 video', 'primary')
const artButton = createButton('使用 ArtPlayer', 'secondary')
const danmakuButton = createButton('启动合成弹幕', 'secondary')
const eventButton = createButton('显示事件卡', 'secondary')
const destroyButton = createButton('释放全部资源', 'quiet')

const buttonStack = createElement('div', 'button-stack')
buttonStack.append(nativeButton, artButton, danmakuButton, eventButton, destroyButton)
controls.append(
  fileLabel,
  buttonStack,
  createElement(
    'p',
    'control-note',
    '播放器代码只在点击启动后动态加载。页面不连接直播平台，也不上传所选文件。',
  ),
)

const stageColumn = createElement('div', 'stage-column')
const stageHeader = createElement('div', 'stage-header')
stageHeader.append(
  createElement('span', 'stage-label', 'VISIBLE SURFACE'),
  createElement('span', 'stage-state', 'generation —'),
)
const stage = createElement('div', 'stage')
const mediaHost = createElement('div', 'media-host')
const emptyState = createElement('div', 'empty-state')
emptyState.append(
  createElement('span', 'empty-glyph', '◌'),
  createElement('strong', 'empty-title', '等待本地媒体'),
  createElement('span', 'empty-detail', '选择文件后启动任一播放器 adapter'),
)
mediaHost.append(emptyState)
const danmakuHost = createElement('div', 'danmaku-host')
danmakuHost.setAttribute('aria-hidden', 'true')
const overlayHost = createElement('div', 'overlay-host')
stage.append(mediaHost, danmakuHost, overlayHost)
stageColumn.append(stageHeader, stage)

const telemetry = createElement('aside', 'telemetry')
telemetry.append(createElement('h2', 'section-title', '有界状态'))
const continuityMetric = createMetric('连续性', 'idle')
const danmakuMetric = createMetric('弹幕', '0 pending')
const overlayMetric = createMetric('事件卡', '0 visible')
const diagnosticLog = createElement('ol', 'diagnostic-log')
diagnosticLog.append(createElement('li', 'diagnostic-empty', '诊断事件会显示在这里'))
telemetry.append(continuityMetric.root, danmakuMetric.root, overlayMetric.root)
telemetry.append(createElement('h3', 'log-title', '最近诊断'), diagnosticLog)

lab.append(controls, stageColumn, telemetry)

const footer = createElement('footer', 'footer')
footer.append(
  createElement('span', '', '仅使用合成消息与本地媒体'),
  createElement('span', '', 'Chrome 111 · Safari 16.4 · Firefox 128'),
)

app.append(header, intro, lab, footer)

nativeButton.addEventListener('click', () => {
  runAction(startNativePlayback)
})
artButton.addEventListener('click', () => {
  runAction(startArtPlayerPlayback)
})
danmakuButton.addEventListener('click', () => {
  runAction(toggleDanmaku)
})
eventButton.addEventListener('click', () => {
  runAction(showOverlayEvent)
})
destroyButton.addEventListener('click', () => {
  runAction(destroyEverything)
})
window.addEventListener('pagehide', () => {
  runAction(destroyEverything)
})

async function startNativePlayback(): Promise<void> {
  const selectedFile = selectedMedia()
  if (selectedFile === null) {
    setRuntimeStatus('先选择一个本地视频', true)
    return
  }

  setRuntimeStatus('loading native runtime', false)
  await destroyPlayback()
  const [{ CONTRACT_VERSION }, continuityModule, nativeModule] = await Promise.all([
    import('@babywbx/liveflow'),
    import('@babywbx/liveflow/continuity'),
    import('@babywbx/liveflow/native-video'),
  ])
  const url = replaceMediaUrl(selectedFile)
  mediaHost.replaceChildren()
  const initialVideo = document.createElement('video')
  initialVideo.className = 'video-surface'
  initialVideo.controls = true
  initialVideo.playsInline = true
  initialVideo.muted = true
  mediaHost.append(initialVideo)

  adapter = nativeModule.createNativeVideoAdapter({
    video: initialVideo,
    onDiagnostic: appendDiagnostic,
  })
  adapter.setMuted(true)
  controller = continuityModule.createContinuityController({
    adapter,
    contractVersion: CONTRACT_VERSION,
    onDiagnostic: appendDiagnostic,
    onRecoveryRequest(request) {
      appendLog(`恢复请求 · ${request.reason} · attempt ${String(request.attempt)}`)
    },
  })
  observeController(controller)
  await controller.setSource({
    url,
    kind: selectedFile.type || 'video',
    label: selectedFile.name,
  })
  setRuntimeStatus('native warming', false)
  updateTelemetry()
}

async function startArtPlayerPlayback(): Promise<void> {
  const selectedFile = selectedMedia()
  if (selectedFile === null) {
    setRuntimeStatus('先选择一个本地视频', true)
    return
  }

  setRuntimeStatus('loading ArtPlayer runtime', false)
  await destroyPlayback()
  const [{ CONTRACT_VERSION }, continuityModule, artAdapterModule, artModule] = await Promise.all([
    import('@babywbx/liveflow'),
    import('@babywbx/liveflow/continuity'),
    import('@babywbx/liveflow/artplayer'),
    import('artplayer'),
  ])
  const url = replaceMediaUrl(selectedFile)
  const ArtplayerConstructor = artModule.default
  mediaHost.replaceChildren()

  const createPlayer = (sourceUrl: string): ArtPlayerLike<HTMLDivElement> => {
    const shell = createElement('div', 'art-surface')
    mediaHost.append(shell)
    const player = new ArtplayerConstructor({
      container: shell,
      url: sourceUrl,
      autoplay: false,
      isLive: true,
      muted: true,
      mutex: false,
      setting: true,
      fullscreen: true,
      fullscreenWeb: true,
    })
    return wrapArtPlayer(player, shell)
  }

  const initialPlayer = createPlayer(url)
  const surface: ArtPlayerSurface<HTMLDivElement> = {
    stage(player): void {
      if (player.container !== undefined) {
        player.container.hidden = true
      }
    },
    reveal(player, previous): void {
      if (player.container !== undefined) {
        player.container.hidden = false
      }
      if (previous.container !== undefined) {
        previous.container.hidden = true
      }
    },
    remove(player): void {
      player.container?.remove()
    },
  }

  const artAdapter = artAdapterModule.createArtPlayerAdapter({
    player: initialPlayer,
    surface,
    createPlayer(source) {
      return createPlayer(source.url)
    },
    onDiagnostic: appendDiagnostic,
  })
  adapter = artAdapter
  adapter.setMuted(true)
  controller = continuityModule.createContinuityController({
    adapter,
    contractVersion: CONTRACT_VERSION,
    onDiagnostic: appendDiagnostic,
    onRecoveryRequest(request) {
      appendLog(`恢复请求 · ${request.reason} · attempt ${String(request.attempt)}`)
    },
  })
  observeController(controller)
  await controller.setSource({
    url,
    kind: selectedFile.type || 'video',
    label: selectedFile.name,
  })
  setRuntimeStatus('ArtPlayer warming', false)
  updateTelemetry()
}

function wrapArtPlayer(
  player: Artplayer,
  container: HTMLDivElement,
): ArtPlayerLike<HTMLDivElement> {
  return {
    video: player.video,
    container,
    overlayContainer: player.template.$layer,
    on(event, handler): void {
      player.on(event, handler)
    },
    off(event, handler): void {
      player.off(event, handler)
    },
    setMutex(_enabled): void {},
    destroy(): void {
      player.destroy(true)
    },
  }
}

async function toggleDanmaku(): Promise<void> {
  if (danmakuEngine !== null) {
    destroyDanmaku()
    danmakuButton.textContent = '启动合成弹幕'
    updateTelemetry()
    return
  }

  const [{ CONTRACT_VERSION }, danmakuModule, domModule] = await Promise.all([
    import('@babywbx/liveflow'),
    import('@babywbx/liveflow/danmaku'),
    import('@babywbx/liveflow/danmaku/dom'),
  ])
  const renderer = domModule.createDomDanmakuRenderer({
    container: danmakuHost,
    backgroundColor: '#0b1020',
    fallbackTextColor: '#f8fbff',
  })
  danmakuEngine = danmakuModule.createDanmakuEngine({
    contractVersion: CONTRACT_VERSION,
    renderer,
    viewport: stageViewport(),
    onDiagnostic: appendDiagnostic,
  })
  danmakuResizeObserver = new ResizeObserver(() => {
    danmakuEngine?.resize(stageViewport())
  })
  danmakuResizeObserver.observe(stage)
  pushSyntheticDanmaku()
  danmakuTimer = window.setInterval(pushSyntheticDanmaku, 720)
  danmakuButton.textContent = '停止合成弹幕'
  appendLog('弹幕引擎已启动')
  updateTelemetry()
}

async function showOverlayEvent(): Promise<void> {
  if (overlayEngine === null) {
    const [{ CONTRACT_VERSION }, overlayModule] = await Promise.all([
      import('@babywbx/liveflow'),
      import('@babywbx/liveflow/overlay'),
    ])
    overlayCoordinator = overlayModule.createOverlayBudgetCoordinator({
      maxInstances: 9,
      maxActiveCards: 3,
      maxFullCards: 1,
      maxHighCostAnimations: 1,
    })
    overlayEngine = overlayModule.createOverlayEngine({
      contractVersion: CONTRACT_VERSION,
      instanceId: 'example-primary',
      instanceState: {
        focused: true,
        visible: true,
        weight: 10,
      },
      coordinator: overlayCoordinator,
      container: overlayHost,
      onDiagnostic: appendDiagnostic,
    })
  }

  eventSequence += 1
  overlayEngine.submit({
    id: `event-${String(eventSequence)}`,
    dedupeKey: `example-${String(eventSequence)}`,
    kind: 'milestone',
    receivedAt: performance.now(),
    priority: 80,
    durationMs: 4_500,
    nodes: [
      {
        type: 'identity',
        identity: {
          kind: 'supporter',
          label: '同行者 Lv.12',
          level: 12,
        },
      },
      {
        type: 'text',
        role: 'message',
        text: '这是一张独立于普通弹幕调度的结构化事件卡。',
      },
    ],
  })
  appendLog(`事件卡 ${String(eventSequence)} 已提交`)
  updateTelemetry()
}

function pushSyntheticDanmaku(): void {
  if (danmakuEngine === null) {
    return
  }
  const messages = [
    '新画面出首帧以后才完成交接',
    '灯牌和正文保持独立结构',
    '高输入时丢弃，不扩大队列',
    '每一路都拥有自己的 generation',
    '普通弹幕不会阻塞事件卡',
  ]
  const message = messages[messageSequence % messages.length]
  if (message === undefined) {
    return
  }
  messageSequence += 1
  danmakuEngine.push({
    id: `message-${String(messageSequence)}`,
    receivedAt: performance.now(),
    text: message,
    mode: messageSequence % 7 === 0 ? 'top' : 'scroll',
    priority: messageSequence % 5 === 0 ? 70 : 20,
    color: messageSequence % 3 === 0 ? '#9ee7ff' : '#ffffff',
    sender: {
      displayName: `viewer-${String((messageSequence % 9) + 1)}`,
    },
    identities: [
      {
        kind: 'badge',
        label: `信号 ${String((messageSequence % 12) + 1)}`,
        level: (messageSequence % 12) + 1,
      },
    ],
  })
  updateTelemetry()
}

async function destroyEverything(): Promise<void> {
  destroyDanmaku()
  if (overlayEngine !== null) {
    overlayEngine.destroy()
    overlayEngine = null
  }
  if (overlayCoordinator !== null) {
    overlayCoordinator.destroy()
    overlayCoordinator = null
  }
  await destroyPlayback()
  releaseMediaUrl()
  mediaHost.replaceChildren(emptyState)
  setRuntimeStatus('runtime idle', false)
  appendLog('全部资源已释放')
  updateTelemetry()
}

async function destroyPlayback(): Promise<void> {
  const activeController = controller
  controller = null
  adapter = null
  unsubscribeController?.()
  unsubscribeController = null
  if (activeController !== null) {
    await activeController.destroy()
  }
}

function observeController(activeController: ContinuityController): void {
  unsubscribeController?.()
  unsubscribeController = activeController.subscribe((snapshot) => {
    setRuntimeStatus(`${snapshot.state} · generation ${String(snapshot.generation)}`, false)
    updateTelemetry()
  })
}

function destroyDanmaku(): void {
  if (danmakuTimer !== null) {
    window.clearInterval(danmakuTimer)
    danmakuTimer = null
  }
  danmakuResizeObserver?.disconnect()
  danmakuResizeObserver = null
  danmakuEngine?.destroy()
  danmakuEngine = null
}

function selectedMedia(): File | null {
  return fileInput.files?.item(0) ?? null
}

function replaceMediaUrl(file: File): string {
  releaseMediaUrl()
  mediaUrl = URL.createObjectURL(file)
  return mediaUrl
}

function releaseMediaUrl(): void {
  if (mediaUrl === null) {
    return
  }
  URL.revokeObjectURL(mediaUrl)
  mediaUrl = null
}

function stageViewport(): { width: number; height: number } {
  return {
    width: Math.max(stage.clientWidth, 1),
    height: Math.max(stage.clientHeight, 1),
  }
}

function setRuntimeStatus(message: string, isError: boolean): void {
  runtimeBadge.textContent = message
  runtimeBadge.toggleAttribute('data-error', isError)
}

function updateTelemetry(): void {
  const snapshot = controller?.getSnapshot()
  continuityMetric.value.textContent =
    snapshot === undefined
      ? 'idle'
      : `${snapshot.state} · g${String(snapshot.generation)} · r${String(snapshot.automaticRecoveryCount)}`
  const danmakuMetrics = danmakuEngine?.getMetrics()
  danmakuMetric.value.textContent =
    danmakuMetrics === undefined
      ? '0 pending'
      : `${String(danmakuMetrics.pendingDepth)} pending · ${String(danmakuMetrics.dropped)} dropped`
  const overlayMetrics = overlayEngine?.getMetrics()
  overlayMetric.value.textContent =
    overlayMetrics === undefined
      ? '0 visible'
      : `${String(overlayMetrics.visible)} visible · ${String(overlayMetrics.dropped)} dropped`
  const generation = snapshot?.generation
  const state = snapshot?.state
  const stageState = stageHeader.querySelector<HTMLElement>('.stage-state')
  if (stageState !== null) {
    stageState.textContent =
      generation === undefined || state === undefined
        ? 'generation —'
        : `generation ${String(generation)} · ${state}`
  }
}

function appendDiagnostic(event: {
  readonly scope: string
  readonly code: string
  readonly generation?: number
}): void {
  const generation = event.generation === undefined ? '' : ` · g${String(event.generation)}`
  appendLog(`${event.scope} · ${event.code}${generation}`)
}

function appendLog(message: string): void {
  diagnosticLog.querySelector('.diagnostic-empty')?.remove()
  diagnosticLog.prepend(createElement('li', '', message))
  while (diagnosticLog.children.length > 6) {
    diagnosticLog.lastElementChild?.remove()
  }
}

function runAction(action: () => Promise<void>): void {
  if (actionInProgress) {
    appendLog('runtime · action-in-progress')
    return
  }
  actionInProgress = true
  setActionControlsDisabled(true)
  void action()
    .catch((error: unknown) => {
      const name = error instanceof Error ? error.name : 'UnknownError'
      setRuntimeStatus('操作失败，请查看诊断', true)
      appendLog(`runtime · action-failed · ${name}`)
    })
    .finally(() => {
      actionInProgress = false
      setActionControlsDisabled(false)
    })
}

function setActionControlsDisabled(disabled: boolean): void {
  fileInput.disabled = disabled
  nativeButton.disabled = disabled
  artButton.disabled = disabled
  danmakuButton.disabled = disabled
  eventButton.disabled = disabled
  destroyButton.disabled = disabled
}

function createButton(label: string, variant: string): HTMLButtonElement {
  const button = createElement('button', `action ${variant}`, label)
  button.type = 'button'
  return button
}

function createMetric(
  label: string,
  value: string,
): { root: HTMLDivElement; value: HTMLSpanElement } {
  const root = createElement('div', 'metric-row')
  const valueElement = createElement('span', 'metric-value', value)
  root.append(createElement('span', 'metric-label', label), valueElement)
  return { root, value: valueElement }
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  if (className !== '') {
    element.className = className
  }
  if (text !== undefined) {
    element.textContent = text
  }
  return element
}

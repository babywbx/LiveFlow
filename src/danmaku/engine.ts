import { createSystemClock, type FrameHandle } from '../shared/clock.js'
import { CONTRACT_VERSION } from '../shared/contract.js'
import type { DiagnosticEvent } from '../shared/diagnostics.js'
import { ContractVersionMismatchError, type LiveFlowError } from '../shared/errors.js'
import {
  DanmakuRendererError,
  InvalidDanmakuConfigurationError,
  InvalidDanmakuMessageError,
  NonMonotonicDanmakuClockError,
} from './errors.js'
import type {
  DanmakuDropCounts,
  DanmakuDropReason,
  DanmakuEngine,
  DanmakuEngineOptions,
  DanmakuMeasurement,
  DanmakuMessage,
  DanmakuMetrics,
  DanmakuPolicy,
  DanmakuPushResult,
  DanmakuRenderFrame,
  DanmakuRenderItem,
  DanmakuRenderPosition,
  DanmakuViewport,
} from './types.js'
import {
  emitSanitizationDiagnostics,
  resolveLimits,
  resolvePolicy,
  sanitizeMessage,
  validateRequiredMessageFields,
  validateViewport,
} from './validation.js'

interface PendingMessage {
  readonly message: DanmakuMessage
  enqueuedAt: number
  expiresAt: number
  readonly sequence: number
  readonly sampleRank: number
  measurement: DanmakuMeasurement | null
  measuredAtFrame: number
}

interface VisibleMessage {
  readonly message: DanmakuMessage
  readonly sampleRank: number
  lane: number
  laneSpan: number
  readonly width: number
  readonly height: number
  scrollPixelsPerMs: number
  startAt: number
  endAt: number
}

interface MutableMetrics {
  received: number
  displayed: number
  dropped: number
  frameBudgetOverruns: number
  metadataDiscarded: number
  readonly droppedByReason: DanmakuDropCounts
}

const MAX_DIAGNOSTIC_CODES = 16
const DIAGNOSTIC_COOLDOWN_MS = 1_000

export function createDanmakuEngine(options: DanmakuEngineOptions): DanmakuEngine {
  if (options.contractVersion !== CONTRACT_VERSION) {
    throw new ContractVersionMismatchError(CONTRACT_VERSION, options.contractVersion)
  }
  validateViewport(options.viewport)
  const limits = resolveLimits(options.limits)
  let policy = resolvePolicy(options.policy)
  const clock = options.clock ?? createSystemClock()
  const renderer = options.renderer
  let viewport: DanmakuViewport = { ...options.viewport }
  let laneCount = calculateLaneCount(viewport, policy)
  let lastNow = clock.now()
  if (!Number.isFinite(lastNow)) {
    throw new InvalidDanmakuConfigurationError('clock.now')
  }

  let nextSequence = 1
  let measurementFrame = 0
  let frameHandle: FrameHandle | null = null
  let pausedAt: number | null = null
  let destroyed = false
  let rendererDestroyed = false
  let fatalError: LiveFlowError | null = null
  const pending: PendingMessage[] = []
  const visible: VisibleMessage[] = []
  const intakeTimes: number[] = []
  const displayTimes: number[] = []
  const diagnosticTimes = new Map<string, number>()
  const metrics: MutableMetrics = {
    received: 0,
    displayed: 0,
    dropped: 0,
    frameBudgetOverruns: 0,
    metadataDiscarded: 0,
    droppedByReason: {
      duplicate: 0,
      expired: 0,
      inputRate: 0,
      pendingCapacity: 0,
      displayRate: 0,
      visibleCapacity: 0,
      noLane: 0,
      textTooLong: 0,
      measurementFailed: 0,
    },
  }

  return {
    push(input: DanmakuMessage): DanmakuPushResult {
      ensureActive()
      const clockNow = readNow()
      const now = pausedAt ?? clockNow
      let required
      try {
        required = validateRequiredMessageFields(input)
      } catch (error) {
        throw normalizeInvalidMessageError(error)
      }
      metrics.received += 1
      pruneRateWindow(intakeTimes, now)
      if (intakeTimes.length >= limits.maxIntakePerSecond) {
        recordDrop('input-rate')
        return { accepted: false, reason: 'input-rate' }
      }
      intakeTimes.push(now)
      if (required.text.length > limits.maxTextLength) {
        recordDrop('text-too-long')
        return { accepted: false, reason: 'text-too-long' }
      }
      let sanitized
      try {
        sanitized = sanitizeMessage(input, required, limits)
      } catch (error) {
        throw normalizeInvalidMessageError(error)
      }

      if (sanitized.metadataDiscarded) {
        metrics.metadataDiscarded += 1
      }
      emitSanitizationDiagnostics(sanitized, emitDiagnostic)

      if (isRecentDuplicate(sanitized.message, now)) {
        recordDrop('duplicate')
        return { accepted: false, reason: 'duplicate' }
      }

      const item: PendingMessage = {
        message: sanitized.message,
        enqueuedAt: now,
        expiresAt: now + policy.maxPendingAgeMs,
        sequence: nextSequence,
        sampleRank: stableSampleRank(sanitized.message.id),
        measurement: null,
        measuredAtFrame: 0,
      }
      nextSequence += 1
      const retained = retainWithinCapacity(item)
      if (!retained) {
        recordDrop('pending-capacity')
        return { accepted: false, reason: 'pending-capacity' }
      }

      insertPending(item)
      scheduleFrame()
      return { accepted: true }
    },
    getMetrics(): DanmakuMetrics {
      ensureActive()
      return snapshotMetrics()
    },
    pause(): void {
      ensureActive()
      if (pausedAt !== null) {
        return
      }
      const now = readNow()
      cancelFrame()
      pausedAt = now
      callRenderer('pause', () => {
        renderer.setPaused(true)
      })
    },
    resume(): void {
      ensureActive()
      if (pausedAt === null) {
        return
      }
      const now = readNow()
      const pausedDuration = now - pausedAt
      pausedAt = null
      for (const item of visible) {
        item.startAt += pausedDuration
        item.endAt += pausedDuration
      }
      for (const item of pending) {
        item.enqueuedAt += pausedDuration
        item.expiresAt += pausedDuration
      }
      shiftTimes(intakeTimes, pausedDuration)
      shiftTimes(displayTimes, pausedDuration)
      callRenderer('resume', () => {
        renderer.setPaused(false)
      })
      scheduleFrame()
    },
    clear(): void {
      ensureActive()
      const now = pausedAt ?? readNow()
      const unmounts = visible.map((item) => item.message.id)
      cancelFrame()
      pending.length = 0
      visible.length = 0
      if (unmounts.length > 0) {
        callRenderer('clear', () => {
          renderer.render({ timestamp: now, mounts: [], updates: [], unmounts })
        })
      }
    },
    resize(nextViewport: DanmakuViewport, nextPolicy?: Partial<DanmakuPolicy>): void {
      ensureActive()
      validateViewport(nextViewport)
      const resolvedPolicy =
        nextPolicy === undefined ? policy : resolvePolicy({ ...policy, ...nextPolicy })
      const clockNow = readNow()
      const now = pausedAt ?? clockNow
      const scrollPositions = new Map<VisibleMessage, number>()
      const scrollProgress = new Map<VisibleMessage, number>()
      const previousLaneSpans = new Map<VisibleMessage, number>()
      for (const item of visible) {
        previousLaneSpans.set(item, item.laneSpan)
        if (item.message.mode === 'scroll') {
          scrollPositions.set(item, positionAt(item, now).x)
          scrollProgress.set(item, progressAt(item, now))
        }
      }
      policy = resolvedPolicy
      viewport = { ...nextViewport }
      laneCount = calculateLaneCount(viewport, policy)
      for (const item of pending) {
        item.measurement = null
        item.measuredAtFrame = 0
      }
      for (const item of visible) {
        const previousX = scrollPositions.get(item)
        const previousProgress = scrollProgress.get(item)
        if (previousX !== undefined && previousProgress !== undefined) {
          rebaseScrollPosition(item, previousX, previousProgress, now)
        }
        item.laneSpan = Math.max(1, Math.ceil(item.height / policy.laneHeight))
      }
      reflowScrollOverlap(now)
      const unmounts: string[] = []
      const retained: VisibleMessage[] = []
      // O(n²) is bounded by maxVisible.
      for (const item of visible) {
        if (
          item.lane + item.laneSpan > laneCount ||
          retained.some((existing) => visibleItemsConflict(item, existing, now, previousLaneSpans))
        ) {
          unmounts.push(item.message.id)
          recordDrop('no-lane')
        } else {
          retained.push(item)
        }
      }
      visible.length = 0
      visible.push(...retained)
      callRenderer('resize', () => {
        renderer.resize(viewport)
      })
      const updates = collectPositions(now)
      if (updates.length > 0 || unmounts.length > 0) {
        callRenderer('render', () => {
          renderer.render({ timestamp: now, mounts: [], updates, unmounts })
        })
      }
      scheduleFrame()
    },
    destroy(): void {
      if (destroyed && frameHandle === null && rendererDestroyed) {
        return
      }
      destroyed = true
      let cleanupFailed = false
      try {
        cancelFrame()
      } catch {
        cleanupFailed = true
      }
      pending.length = 0
      visible.length = 0
      intakeTimes.length = 0
      displayTimes.length = 0
      diagnosticTimes.clear()
      try {
        if (!rendererDestroyed) {
          renderer.destroy()
          rendererDestroyed = true
        }
      } catch {
        cleanupFailed = true
      }
      if (cleanupFailed) {
        throw new DanmakuRendererError('destroy')
      }
    },
  }

  function ensureActive(): void {
    if (fatalError !== null) {
      throw fatalError
    }
    if (destroyed) {
      throw new InvalidDanmakuConfigurationError('engine.destroyed')
    }
  }

  function readNow(): number {
    const now = clock.now()
    if (!Number.isFinite(now) || now < lastNow) {
      throw new NonMonotonicDanmakuClockError()
    }
    lastNow = now
    return now
  }

  function retainWithinCapacity(candidate: PendingMessage): boolean {
    if (pending.length < limits.maxPending) {
      return true
    }
    let victimIndex = 0
    for (let index = 1; index < pending.length; index += 1) {
      const current = pending[index]
      const victim = pending[victimIndex]
      if (current !== undefined && victim !== undefined && isWorseCandidate(current, victim)) {
        victimIndex = index
      }
    }
    const victim = pending[victimIndex]
    if (victim === undefined || !isBetterCandidate(candidate, victim)) {
      return false
    }
    pending.splice(victimIndex, 1)
    recordDrop('pending-capacity')
    return true
  }

  function insertPending(item: PendingMessage): void {
    let index = 0
    while (index < pending.length) {
      const current = pending[index]
      if (current !== undefined && isBetterForDisplay(item, current)) {
        break
      }
      index += 1
    }
    pending.splice(index, 0, item)
  }

  function isRecentDuplicate(message: DanmakuMessage, now: number): boolean {
    if (
      pending.some((item) => item.message.id === message.id) ||
      visible.some((item) => item.message.id === message.id)
    ) {
      return true
    }
    if (message.priority > 0 || message.text.length > 80) {
      return false
    }
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const item = pending[index]
      if (item === undefined || now - item.enqueuedAt > policy.duplicateWindowMs) {
        continue
      }
      if (
        item.message.mode === message.mode &&
        item.message.text === message.text &&
        item.message.sender?.displayName === message.sender?.displayName
      ) {
        return true
      }
    }
    return false
  }

  function scheduleFrame(): void {
    if (
      destroyed ||
      pausedAt !== null ||
      fatalError !== null ||
      frameHandle !== null ||
      (pending.length === 0 && visible.length === 0)
    ) {
      return
    }
    frameHandle = clock.requestFrame(runFrame)
  }

  function cancelFrame(): void {
    if (frameHandle === null) {
      return
    }
    const handle = frameHandle
    clock.cancelFrame(handle)
    frameHandle = null
  }

  function runFrame(): void {
    frameHandle = null
    if (destroyed || pausedAt !== null || fatalError !== null) {
      return
    }
    let now: number
    try {
      now = readNow()
    } catch {
      fatalError = new NonMonotonicDanmakuClockError()
      emitDiagnostic({ scope: 'danmaku', code: 'clock-failed', level: 'warn' })
      return
    }

    const frameStartedAt = now
    const unmounts = expireVisible(now)
    expirePending(now)
    pruneRateWindow(displayTimes, now)
    const mounts = mountPending(now)
    const updates = collectPositions(now)
    if (mounts.length > 0 || updates.length > 0 || unmounts.length > 0) {
      callRendererFromFrame('render', () => {
        const frame: DanmakuRenderFrame = {
          timestamp: now,
          mounts,
          updates,
          unmounts,
        }
        renderer.render(frame)
      })
    }

    let frameElapsed: number
    try {
      frameElapsed = readNow() - frameStartedAt
    } catch {
      fatalError = new NonMonotonicDanmakuClockError()
      emitDiagnostic({ scope: 'danmaku', code: 'clock-failed', level: 'warn' })
      return
    }
    if (frameElapsed > policy.frameBudgetMs) {
      metrics.frameBudgetOverruns += 1
      emitDiagnostic({ scope: 'danmaku', code: 'frame-budget-exceeded', level: 'warn' })
    }
    scheduleFrame()
  }

  function expireVisible(now: number): string[] {
    const unmounts: string[] = []
    for (let index = visible.length - 1; index >= 0; index -= 1) {
      const item = visible[index]
      if (item !== undefined && item.endAt <= now) {
        visible.splice(index, 1)
        unmounts.push(item.message.id)
      }
    }
    return unmounts
  }

  function expirePending(now: number): void {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const item = pending[index]
      if (item !== undefined && item.expiresAt <= now) {
        pending.splice(index, 1)
        recordDrop('expired')
      }
    }
  }

  function mountPending(now: number): DanmakuRenderItem[] {
    if (pending.length === 0) {
      return []
    }
    if (displayTimes.length >= limits.maxDisplayPerSecond) {
      dropTimedOutLaneWaiters(now, 'display-rate')
      return []
    }
    if (visible.length >= limits.maxVisible) {
      dropTimedOutLaneWaiters(now, 'visible-capacity')
      return []
    }

    const mountCapacity = Math.min(
      limits.maxMountsPerFrame,
      limits.maxVisible - visible.length,
      limits.maxDisplayPerSecond - displayTimes.length,
    )
    measurementFrame += 1
    const unmeasured: PendingMessage[] = []
    for (const item of pending) {
      if (item.measurement === null && item.measuredAtFrame <= measurementFrame)
        unmeasured.push(item)
      if (unmeasured.length >= limits.maxMountsPerFrame) break
    }
    const retryFrame = measurementFrame + Math.ceil(pending.length / limits.maxMountsPerFrame)
    for (const item of unmeasured) item.measuredAtFrame = retryFrame
    const measuredById = new Map<string, DanmakuMeasurement>()
    try {
      const measurements =
        unmeasured.length === 0 ? [] : renderer.measure(unmeasured.map((item) => item.message))
      if (!Array.isArray(measurements)) {
        throw new Error('measurement collection')
      }
      const measurementCount: unknown = measurements.length
      if (
        typeof measurementCount !== 'number' ||
        !Number.isSafeInteger(measurementCount) ||
        measurementCount < 0
      ) {
        throw new Error('measurement collection')
      }
      const retainedCount = Math.min(measurementCount, unmeasured.length)
      for (let index = 0; index < retainedCount; index += 1) {
        const measurement: unknown = measurements[index]
        if (typeof measurement !== 'object' || measurement === null) {
          continue
        }
        const id: unknown = Reflect.get(measurement, 'id')
        const width: unknown = Reflect.get(measurement, 'width')
        const height: unknown = Reflect.get(measurement, 'height')
        if (
          typeof id === 'string' &&
          typeof width === 'number' &&
          Number.isFinite(width) &&
          width > 0 &&
          typeof height === 'number' &&
          Number.isFinite(height) &&
          height > 0
        ) {
          measuredById.set(id, { id, width, height })
        }
      }
    } catch {
      failRenderer('measure')
      return []
    }

    for (const candidate of unmeasured) {
      const measurement = measuredById.get(candidate.message.id)
      if (measurement !== undefined) candidate.measurement = measurement
    }

    const mounts: DanmakuRenderItem[] = []
    let pendingIndex = 0
    while (pendingIndex < pending.length && mounts.length < mountCapacity) {
      const candidate = pending[pendingIndex]
      if (candidate === undefined) break
      const measurement = candidate.measurement
      if (measurement === null) {
        pendingIndex += 1
        continue
      }
      const laneSpan = Math.max(1, Math.ceil(measurement.height / policy.laneHeight))
      const duration =
        candidate.message.mode === 'scroll'
          ? scrollDuration(measurement.width, candidate.sampleRank)
          : policy.fixedDurationMs
      const scrollSpeed =
        candidate.message.mode === 'scroll' ? (viewport.width + measurement.width) / duration : 0
      const lane = findLane(candidate.message.mode, laneSpan, scrollSpeed, now)
      if (lane === null) {
        if (now - candidate.enqueuedAt >= policy.maxLaneWaitMs) {
          pending.splice(pendingIndex, 1)
          recordDrop('no-lane')
        } else {
          pendingIndex += 1
        }
        continue
      }
      pending.splice(pendingIndex, 1)
      const item: VisibleMessage = {
        message: candidate.message,
        sampleRank: candidate.sampleRank,
        lane,
        laneSpan,
        width: measurement.width,
        height: measurement.height,
        scrollPixelsPerMs: scrollSpeed,
        startAt: now,
        endAt: now + duration,
      }
      visible.push(item)
      displayTimes.push(now)
      metrics.displayed += 1
      const position = positionAt(item, now)
      mounts.push({
        message: item.message,
        lane,
        x: position.x,
        y: position.y,
        width: item.width,
        height: item.height,
      })
    }
    return mounts
  }

  function dropTimedOutLaneWaiters(now: number, reason: DanmakuDropReason): void {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const item = pending[index]
      if (item !== undefined && now - item.enqueuedAt >= policy.maxLaneWaitMs) {
        pending.splice(index, 1)
        recordDrop(reason)
      }
    }
  }

  function findLane(
    mode: DanmakuMessage['mode'],
    span: number,
    scrollSpeed: number,
    now: number,
  ): number | null {
    if (span > laneCount) {
      return null
    }
    if (mode === 'bottom') {
      for (let lane = laneCount - span; lane >= 0; lane -= 1) {
        if (laneSlack(lane, span, mode, scrollSpeed, now) >= 0) {
          return lane
        }
      }
      return null
    }
    const freest = mode === 'scroll' && policy.scrollLaneSelection === 'freest'
    let bestLane: number | null = null
    let bestSlack = -1
    for (let lane = 0; lane <= laneCount - span; lane += 1) {
      const slack = laneSlack(lane, span, mode, scrollSpeed, now)
      if (slack < 0) continue
      if (!freest) return lane
      // Most free lane wins, so lulls thin out evenly
      if (slack > bestSlack) {
        bestLane = lane
        bestSlack = slack
      }
    }
    return bestLane
  }

  function laneSlack(
    lane: number,
    span: number,
    mode: DanmakuMessage['mode'],
    scrollSpeed: number,
    now: number,
  ): number {
    let slack = Number.POSITIVE_INFINITY
    for (const item of visible) {
      if (!spansOverlap(lane, span, item.lane, item.laneSpan)) {
        continue
      }
      if (mode !== 'scroll' || item.message.mode !== 'scroll') {
        return -1
      }
      const position = positionAt(item, now)
      const gap = viewport.width - (position.x + item.width)
      const requiredGap = requiredScrollGap(
        policy.scrollOverlapStartRatio * viewport.width,
        scrollSpeed,
        item.scrollPixelsPerMs,
      )
      slack = Math.min(slack, gap - requiredGap)
      if (slack < 0) return slack
    }
    return slack
  }

  function visibleItemsConflict(
    candidate: VisibleMessage,
    existing: VisibleMessage,
    now: number,
    previousLaneSpans: ReadonlyMap<VisibleMessage, number>,
  ): boolean {
    if (!spansOverlap(candidate.lane, candidate.laneSpan, existing.lane, existing.laneSpan)) {
      return false
    }
    if (candidate.message.mode !== 'scroll' || existing.message.mode !== 'scroll') {
      return true
    }
    const candidatePreviousSpan = previousLaneSpans.get(candidate)
    const existingPreviousSpan = previousLaneSpans.get(existing)
    if (
      candidatePreviousSpan !== undefined &&
      existingPreviousSpan !== undefined &&
      spansOverlap(candidate.lane, candidatePreviousSpan, existing.lane, existingPreviousSpan)
    ) {
      return false
    }
    const candidateX = positionAt(candidate, now).x
    const existingX = positionAt(existing, now).x
    return (
      candidateX < existingX + existing.width + policy.laneGap &&
      existingX < candidateX + candidate.width + policy.laneGap
    )
  }

  function collectPositions(now: number): DanmakuRenderPosition[] {
    return visible.map((item) => {
      const position = positionAt(item, now)
      return {
        id: item.message.id,
        x: position.x,
        y: position.y,
      }
    })
  }

  function positionAt(item: VisibleMessage, now: number): { x: number; y: number } {
    const y = item.lane * policy.laneHeight
    if (item.message.mode !== 'scroll') {
      return {
        x: Math.max(0, (viewport.width - item.width) / 2),
        y,
      }
    }
    const elapsed = Math.min(item.endAt, Math.max(item.startAt, now)) - item.startAt
    return {
      x: viewport.width - elapsed * item.scrollPixelsPerMs,
      y,
    }
  }

  function scrollDuration(width: number, sampleRank: number): number {
    return (
      (policy.scrollDurationMs ??
        ((viewport.width + width) / policy.scrollPixelsPerSecond) * 1_000) +
      (policy.scrollDurationJitterMs ?? 0) * (sampleRank / 0x1_0000_0000)
    )
  }

  function progressAt(item: VisibleMessage, now: number): number {
    const elapsed = Math.min(item.endAt, Math.max(item.startAt, now)) - item.startAt
    return elapsed / (item.endAt - item.startAt)
  }

  function rebaseScrollPosition(
    item: VisibleMessage,
    x: number,
    previousProgress: number,
    now: number,
  ): void {
    const progress =
      policy.scrollDurationMs === undefined || policy.scrollDurationMs === null
        ? Math.min(1, Math.max(0, (viewport.width - x) / (viewport.width + item.width)))
        : previousProgress
    setScrollProgress(item, progress, now)
  }

  function reflowScrollOverlap(now: number): void {
    if (policy.scrollOverlapStartRatio <= 0) return
    const guardX = viewport.width * (1 - policy.scrollOverlapStartRatio)
    for (let trailingIndex = visible.length - 1; trailingIndex >= 0; trailingIndex -= 1) {
      const trailing = visible[trailingIndex]
      if (
        trailing === undefined ||
        trailing.message.mode !== 'scroll' ||
        trailing.lane + trailing.laneSpan > laneCount
      ) {
        continue
      }
      const trailingX = positionAt(trailing, now).x
      if (trailingX < guardX) continue
      for (let leadingIndex = trailingIndex - 1; leadingIndex >= 0; leadingIndex -= 1) {
        const leading = visible[leadingIndex]
        if (
          leading === undefined ||
          leading.message.mode !== 'scroll' ||
          leading.lane + leading.laneSpan > laneCount ||
          !spansOverlap(trailing.lane, trailing.laneSpan, leading.lane, leading.laneSpan)
        ) {
          continue
        }
        const leadingX = positionAt(leading, now).x
        const requiredGap = requiredScrollGap(
          trailingX - guardX,
          trailing.scrollPixelsPerMs,
          leading.scrollPixelsPerMs,
        )
        const gap = trailingX - (leadingX + leading.width)
        if (gap >= requiredGap) continue
        const nextX = leadingX - (requiredGap - gap)
        const progress = (viewport.width - nextX) / (viewport.width + leading.width)
        setScrollProgress(leading, progress, now)
      }
    }
  }

  function requiredScrollGap(
    protectedDistance: number,
    trailingSpeed: number,
    leadingSpeed: number,
  ): number {
    const closingSpeed = trailingSpeed - leadingSpeed
    return closingSpeed <= 0
      ? policy.laneGap
      : policy.laneGap + (protectedDistance * closingSpeed) / trailingSpeed
  }

  function setScrollProgress(item: VisibleMessage, progress: number, now: number): void {
    const duration = scrollDuration(item.width, item.sampleRank)
    const boundedProgress = Math.min(1, Math.max(0, progress))
    item.startAt = now - boundedProgress * duration
    item.endAt = item.startAt + duration
    item.scrollPixelsPerMs = (viewport.width + item.width) / duration
  }

  function callRenderer(phase: string, operation: () => void): void {
    try {
      operation()
    } catch {
      throw failRenderer(phase)
    }
  }

  function callRendererFromFrame(phase: string, operation: () => void): void {
    try {
      operation()
    } catch {
      failRenderer(phase)
    }
  }

  function failRenderer(phase: string): DanmakuRendererError {
    const error = new DanmakuRendererError(phase)
    fatalError = error
    try {
      cancelFrame()
    } catch {
      // Destroy retries cancellation with the retained handle.
    }
    emitDiagnostic({ scope: 'danmaku', code: 'renderer-failed', level: 'warn' })
    return error
  }

  function emitDiagnostic(event: DiagnosticEvent): void {
    if (options.onDiagnostic === undefined) {
      return
    }
    const now = lastNow
    const previous = diagnosticTimes.get(event.code)
    if (previous !== undefined && now - previous < DIAGNOSTIC_COOLDOWN_MS) {
      return
    }
    if (previous === undefined && diagnosticTimes.size >= MAX_DIAGNOSTIC_CODES) {
      return
    }
    diagnosticTimes.set(event.code, now)
    try {
      options.onDiagnostic(event)
    } catch {
      return
    }
  }

  function recordDrop(reason: DanmakuDropReason): void {
    metrics.dropped += 1
    switch (reason) {
      case 'duplicate':
        metrics.droppedByReason.duplicate += 1
        return
      case 'expired':
        metrics.droppedByReason.expired += 1
        return
      case 'input-rate':
        metrics.droppedByReason.inputRate += 1
        return
      case 'pending-capacity':
        metrics.droppedByReason.pendingCapacity += 1
        return
      case 'display-rate':
        metrics.droppedByReason.displayRate += 1
        return
      case 'visible-capacity':
        metrics.droppedByReason.visibleCapacity += 1
        return
      case 'no-lane':
        metrics.droppedByReason.noLane += 1
        return
      case 'text-too-long':
        metrics.droppedByReason.textTooLong += 1
        return
      case 'measurement-failed':
        metrics.droppedByReason.measurementFailed += 1
        return
    }
  }

  function snapshotMetrics(): DanmakuMetrics {
    return {
      received: metrics.received,
      displayed: metrics.displayed,
      dropped: metrics.dropped,
      pendingDepth: pending.length,
      visible: visible.length,
      frameBudgetOverruns: metrics.frameBudgetOverruns,
      metadataDiscarded: metrics.metadataDiscarded,
      droppedByReason: { ...metrics.droppedByReason },
    }
  }
}

function calculateLaneCount(viewport: DanmakuViewport, policy: DanmakuPolicy): number {
  return Math.max(1, Math.floor(viewport.height / policy.laneHeight))
}

function pruneRateWindow(times: number[], now: number): void {
  while (times.length > 0) {
    const first = times[0]
    if (first === undefined || now - first < 1_000) {
      return
    }
    times.shift()
  }
}

function shiftTimes(times: number[], duration: number): void {
  for (let index = 0; index < times.length; index += 1) {
    const time = times[index]
    if (time !== undefined) {
      times[index] = time + duration
    }
  }
}

function stableSampleRank(id: string): number {
  let hash = 2_166_136_261
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return hash >>> 0
}

function isBetterCandidate(candidate: PendingMessage, existing: PendingMessage): boolean {
  if (candidate.message.priority !== existing.message.priority) {
    return candidate.message.priority > existing.message.priority
  }
  if (candidate.sampleRank !== existing.sampleRank) {
    return candidate.sampleRank < existing.sampleRank
  }
  return candidate.sequence < existing.sequence
}

function isWorseCandidate(candidate: PendingMessage, existing: PendingMessage): boolean {
  return isBetterCandidate(existing, candidate)
}

function isBetterForDisplay(candidate: PendingMessage, existing: PendingMessage): boolean {
  if (candidate.message.priority !== existing.message.priority) {
    return candidate.message.priority > existing.message.priority
  }
  if (candidate.message.receivedAt !== existing.message.receivedAt) {
    return candidate.message.receivedAt < existing.message.receivedAt
  }
  return candidate.sequence < existing.sequence
}

function spansOverlap(
  firstLane: number,
  firstSpan: number,
  secondLane: number,
  secondSpan: number,
): boolean {
  return firstLane < secondLane + secondSpan && secondLane < firstLane + firstSpan
}

function normalizeInvalidMessageError(error: unknown): InvalidDanmakuMessageError {
  try {
    if (error instanceof InvalidDanmakuMessageError) {
      return error
    }
  } catch {
    return new InvalidDanmakuMessageError('message')
  }
  return new InvalidDanmakuMessageError('message')
}

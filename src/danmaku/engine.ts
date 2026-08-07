import { createSystemClock, type FrameHandle } from '../shared/clock.js'
import { CONTRACT_VERSION } from '../shared/contract.js'
import type { DiagnosticEvent } from '../shared/diagnostics.js'
import { ContractVersionMismatchError, type LiveFlowError } from '../shared/errors.js'
import {
  DanmakuRendererError,
  InvalidDanmakuConfigurationError,
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
  validateViewport,
} from './validation.js'

interface PendingMessage {
  readonly message: DanmakuMessage
  readonly enqueuedAt: number
  expiresAt: number
  readonly sequence: number
  readonly sampleRank: number
}

interface VisibleMessage {
  readonly message: DanmakuMessage
  lane: number
  readonly laneSpan: number
  readonly width: number
  readonly height: number
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
  let frameHandle: FrameHandle | null = null
  let pausedAt: number | null = null
  let destroyed = false
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
      const now = readNow()
      const sanitized = sanitizeMessage(input, limits)
      metrics.received += 1
      if (sanitized.message.text.length > limits.maxTextLength) {
        recordDrop('text-too-long')
        return { accepted: false, reason: 'text-too-long' }
      }

      if (sanitized.metadataDiscarded) {
        metrics.metadataDiscarded += 1
      }
      emitSanitizationDiagnostics(sanitized, emitDiagnostic)
      pruneRateWindow(intakeTimes, now)
      if (intakeTimes.length >= limits.maxIntakePerSecond) {
        recordDrop('input-rate')
        return { accepted: false, reason: 'input-rate' }
      }
      intakeTimes.push(now)

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
      pausedAt = readNow()
      cancelFrame()
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
        item.expiresAt += pausedDuration
      }
      shiftTimes(intakeTimes, pausedDuration)
      shiftTimes(displayTimes, pausedDuration)
      callRenderer('resume', () => {
        renderer.setPaused(false)
      })
      scheduleFrame()
    },
    resize(nextViewport: DanmakuViewport, nextPolicy?: Partial<DanmakuPolicy>): void {
      ensureActive()
      validateViewport(nextViewport)
      if (nextPolicy !== undefined) {
        policy = resolvePolicy({ ...policy, ...nextPolicy })
      }
      const now = readNow()
      viewport = { ...nextViewport }
      laneCount = calculateLaneCount(viewport, policy)
      const unmounts: string[] = []
      for (let index = visible.length - 1; index >= 0; index -= 1) {
        const item = visible[index]
        if (item !== undefined && item.lane + item.laneSpan > laneCount) {
          visible.splice(index, 1)
          unmounts.push(item.message.id)
          recordDrop('no-lane')
        }
      }
      callRenderer('resize', () => {
        renderer.resize(viewport)
      })
      if (unmounts.length > 0) {
        callRenderer('render', () => {
          renderer.render({ timestamp: now, mounts: [], updates: [], unmounts })
        })
      }
      scheduleFrame()
    },
    destroy(): void {
      if (destroyed) {
        return
      }
      destroyed = true
      cancelFrame()
      pending.length = 0
      visible.length = 0
      intakeTimes.length = 0
      displayTimes.length = 0
      diagnosticTimes.clear()
      try {
        renderer.destroy()
      } catch {
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
    clock.cancelFrame(frameHandle)
    frameHandle = null
  }

  function runFrame(timestamp: number): void {
    frameHandle = null
    if (destroyed || pausedAt !== null || fatalError !== null) {
      return
    }
    let now: number
    try {
      now = readFrameTime(timestamp)
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

  function readFrameTime(timestamp: number): number {
    const clockNow = readNow()
    if (!Number.isFinite(timestamp)) {
      return clockNow
    }
    return clockNow
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

    const candidates = pending.slice(
      0,
      Math.min(
        pending.length,
        limits.maxMountsPerFrame,
        limits.maxVisible - visible.length,
        limits.maxDisplayPerSecond - displayTimes.length,
      ),
    )
    let measurements: readonly DanmakuMeasurement[]
    try {
      measurements = renderer.measure(candidates.map((item) => item.message))
    } catch {
      failRenderer('measure')
      return []
    }
    const byId = new Map<string, DanmakuMeasurement>()
    for (const measurement of measurements.slice(0, limits.maxMountsPerFrame)) {
      if (
        typeof measurement.id === 'string' &&
        Number.isFinite(measurement.width) &&
        measurement.width > 0 &&
        Number.isFinite(measurement.height) &&
        measurement.height > 0
      ) {
        byId.set(measurement.id, measurement)
      }
    }

    const mounts: DanmakuRenderItem[] = []
    for (const candidate of candidates) {
      if (mounts.length >= limits.maxMountsPerFrame) {
        break
      }
      const pendingIndex = pending.findIndex((item) => item.sequence === candidate.sequence)
      if (pendingIndex < 0) {
        continue
      }
      const measurement = byId.get(candidate.message.id)
      if (measurement === undefined) {
        pending.splice(pendingIndex, 1)
        recordDrop('measurement-failed')
        emitDiagnostic({
          scope: 'danmaku',
          code: 'measurement-failed',
          level: 'warn',
          detail: { messageId: candidate.message.id },
        })
        continue
      }
      const laneSpan = Math.max(1, Math.ceil(measurement.height / policy.laneHeight))
      const lane = findLane(candidate.message.mode, laneSpan, now)
      if (lane === null) {
        if (now - candidate.enqueuedAt >= policy.maxLaneWaitMs) {
          pending.splice(pendingIndex, 1)
          recordDrop('no-lane')
        }
        continue
      }
      pending.splice(pendingIndex, 1)
      const duration =
        candidate.message.mode === 'scroll'
          ? ((viewport.width + measurement.width) / policy.scrollPixelsPerSecond) * 1_000
          : policy.fixedDurationMs
      const item: VisibleMessage = {
        message: candidate.message,
        lane,
        laneSpan,
        width: measurement.width,
        height: measurement.height,
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

  function findLane(mode: DanmakuMessage['mode'], span: number, now: number): number | null {
    if (span > laneCount) {
      return null
    }
    if (mode === 'bottom') {
      for (let lane = laneCount - span; lane >= 0; lane -= 1) {
        if (laneIsAvailable(lane, span, mode, now)) {
          return lane
        }
      }
      return null
    }
    for (let lane = 0; lane <= laneCount - span; lane += 1) {
      if (laneIsAvailable(lane, span, mode, now)) {
        return lane
      }
    }
    return null
  }

  function laneIsAvailable(
    lane: number,
    span: number,
    mode: DanmakuMessage['mode'],
    now: number,
  ): boolean {
    for (const item of visible) {
      if (!spansOverlap(lane, span, item.lane, item.laneSpan)) {
        continue
      }
      if (mode !== 'scroll' || item.message.mode !== 'scroll') {
        return false
      }
      const position = positionAt(item, now)
      if (position.x + item.width > viewport.width - policy.laneGap) {
        return false
      }
    }
    return true
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
    const progress = Math.min(1, Math.max(0, (now - item.startAt) / (item.endAt - item.startAt)))
    return {
      x: viewport.width - progress * (viewport.width + item.width),
      y,
    }
  }

  function callRenderer(phase: string, operation: () => void): void {
    try {
      operation()
    } catch {
      throw new DanmakuRendererError(phase)
    }
  }

  function callRendererFromFrame(phase: string, operation: () => void): void {
    try {
      operation()
    } catch {
      failRenderer(phase)
    }
  }

  function failRenderer(phase: string): void {
    fatalError = new DanmakuRendererError(phase)
    cancelFrame()
    emitDiagnostic({ scope: 'danmaku', code: 'renderer-failed', level: 'warn' })
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

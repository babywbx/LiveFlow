import { describe, expect, it } from 'vitest'

import {
  createArtPlayerAdapter,
  type ArtPlayerLike,
  type ArtPlayerSurface,
} from '../../src/adapters/artplayer.js'
import {
  createNativeVideoAdapter,
  type NativeVideoSurface,
  type TimeRangesLike,
  type VideoElementLike,
} from '../../src/adapters/native-video.js'
import { createContinuityController, type LivePlayerAdapter } from '../../src/continuity/index.js'
import { CONTRACT_VERSION } from '../../src/index.js'

class EmptyRanges implements TimeRangesLike {
  readonly length = 0

  start(_index: number): number {
    throw new RangeError('Missing range.')
  }

  end(_index: number): number {
    throw new RangeError('Missing range.')
  }
}

class HarnessVideo implements VideoElementLike {
  src = ''
  crossOrigin: string | null = null
  preload = ''
  currentTime = 0
  playbackRate = 1
  muted = false
  volume = 1
  paused = true
  ended = false
  readyState = 0
  buffered = new EmptyRanges()
  error: { readonly code: number } | null = null
  private readonly listeners = new Map<string, Set<() => void>>()
  private frame: ((timestampMs: number) => void) | null = null

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  load(): void {}

  play(): Promise<void> {
    this.paused = false
    return Promise.resolve()
  }

  pause(): void {
    this.paused = true
  }

  removeAttribute(name: string): void {
    if (name === 'src') {
      this.src = ''
    }
  }

  requestVideoFrameCallback(callback: (timestampMs: number) => void): number {
    this.frame = callback
    return 1
  }

  cancelVideoFrameCallback(_handle: number): void {
    this.frame = null
  }

  emitPlaying(): void {
    for (const listener of this.listeners.get('playing') ?? []) {
      listener()
    }
  }

  renderFrame(): void {
    const callback = this.frame
    this.frame = null
    callback?.(100)
  }
}

class HarnessNativeSurface implements NativeVideoSurface {
  candidate: HarnessVideo | null = null

  createVideo(): VideoElementLike {
    const video = new HarnessVideo()
    this.candidate = video
    return video
  }

  stage(_video: VideoElementLike): void {}

  reveal(_video: VideoElementLike, _previous: VideoElementLike): void {}

  remove(_video: VideoElementLike): void {}
}

class HarnessPlayer implements ArtPlayerLike {
  readonly video = new HarnessVideo()
  private readonly listeners = new Map<string, Set<(...args: readonly unknown[]) => void>>()

  on(event: string, handler: (...args: readonly unknown[]) => void): void {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(handler)
    this.listeners.set(event, listeners)
  }

  off(event: string, handler: (...args: readonly unknown[]) => void): void {
    this.listeners.get(event)?.delete(handler)
  }

  setMutex(_enabled: boolean): void {}

  destroy(): void {}

  emitPlaying(): void {
    for (const listener of this.listeners.get('playing') ?? []) {
      listener()
    }
  }
}

class HarnessArtSurface implements ArtPlayerSurface {
  stage(_player: ArtPlayerLike): void {}

  reveal(_player: ArtPlayerLike, _previous: ArtPlayerLike): void {}

  remove(_player: ArtPlayerLike): void {}
}

interface AdapterHarness {
  readonly adapter: LivePlayerAdapter
  emitCandidatePlaying(): void
  renderCandidateFrame(): void
}

function createNativeHarness(): AdapterHarness {
  const surface = new HarnessNativeSurface()
  const adapter = createNativeVideoAdapter({
    video: new HarnessVideo(),
    surface,
  })
  return {
    adapter,
    emitCandidatePlaying(): void {
      requireNativeCandidate(surface).emitPlaying()
    },
    renderCandidateFrame(): void {
      requireNativeCandidate(surface).renderFrame()
    },
  }
}

function createArtHarness(): AdapterHarness {
  const surface = new HarnessArtSurface()
  let candidate: HarnessPlayer | null = null
  const adapter = createArtPlayerAdapter({
    player: new HarnessPlayer(),
    createPlayer(): Promise<ArtPlayerLike> {
      const player = new HarnessPlayer()
      candidate = player
      return Promise.resolve(player)
    },
    surface,
  })
  return {
    adapter,
    emitCandidatePlaying(): void {
      requireArtCandidate(candidate).emitPlaying()
    },
    renderCandidateFrame(): void {
      requireArtCandidate(candidate).video.renderFrame()
    },
  }
}

const adapterFactories = [
  ['native video', createNativeHarness],
  ['ArtPlayer-like', createArtHarness],
] as const

describe.each(adapterFactories)('%s continuity integration', (_name, createHarness) => {
  it('enters playing only after the committed candidate renders a first frame', async () => {
    const harness = createHarness()
    const controller = createContinuityController({
      adapter: harness.adapter,
      contractVersion: CONTRACT_VERSION,
    })

    await controller.setSource({
      url: 'https://media.invalid/integration.m3u8',
      kind: 'hls',
    })
    expect(controller.getSnapshot()).toMatchObject({
      state: 'warming',
      generation: 1,
    })

    harness.emitCandidatePlaying()
    expect(controller.getSnapshot().state).toBe('warming')
    harness.renderCandidateFrame()
    expect(controller.getSnapshot()).toMatchObject({
      state: 'playing',
      generation: 1,
    })

    await controller.destroy()
  })
})

function requireNativeCandidate(surface: HarnessNativeSurface): HarnessVideo {
  if (surface.candidate === null) {
    throw new Error('Native candidate was not created.')
  }
  return surface.candidate
}

function requireArtCandidate(candidate: HarnessPlayer | null): HarnessPlayer {
  if (candidate === null) {
    throw new Error('ArtPlayer candidate was not created.')
  }
  return candidate
}

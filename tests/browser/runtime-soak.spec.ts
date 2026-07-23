import { expect, test } from '@playwright/test'

import { type DistServer, startDistServer } from './dist-server.js'

const requestedDurationMs = Number.parseInt(process.env.BROWSER_SOAK_DURATION_MS ?? '', 10)
const durationMs =
  Number.isFinite(requestedDurationMs) && requestedDurationMs > 0 ? requestedDurationMs : null

let server: DistServer

test.beforeAll(async () => {
  server = await startDistServer(fixtureHtml)
})

test.afterAll(async () => {
  await server.close()
})

test('records real DOM, frame, long-task and heap signals for four and nine instances', async ({
  browserName,
  page,
}) => {
  test.skip(durationMs === null, 'Set BROWSER_SOAK_DURATION_MS to run the browser soak.')
  test.skip(browserName !== 'chromium', 'The release soak uses Chromium heap instrumentation.')
  if (durationMs === null) {
    return
  }

  test.setTimeout(durationMs + 120_000)
  await page.goto(`${server.origin}?duration=${String(durationMs)}`)
  await expect(page.locator('#fixture')).toHaveAttribute('data-complete', 'true', {
    timeout: durationMs + 90_000,
  })
  await expect(page.locator('#fixture')).toHaveAttribute('data-bounded', 'true')
  await expect(page.locator('#fixture')).toHaveAttribute('data-released', 'true')
  const report = await page.locator('#fixture').getAttribute('data-report')
  expect(report).not.toBeNull()
  console.log(report)
})

const fixtureHtml = `<!doctype html>
<html>
  <body>
    <div id="fixture"></div>
    <script type="module">
      import { CONTRACT_VERSION } from '/index.js'
      import { createDanmakuEngine } from '/danmaku/index.js'
      import { createDomDanmakuRenderer } from '/danmaku/renderers/index.js'
      import { createOverlayBudgetCoordinator, createOverlayEngine } from '/overlay/index.js'

      const fixture = document.querySelector('#fixture')
      const requested = Number.parseInt(new URL(location.href).searchParams.get('duration') ?? '', 10)
      const totalDuration = Number.isFinite(requested) && requested > 0 ? requested : 0

      void run().catch((error) => {
        fixture.dataset.complete = 'true'
        fixture.dataset.bounded = 'false'
        fixture.dataset.released = 'false'
        fixture.dataset.report = JSON.stringify({
          kind: 'liveflow-browser-soak-error',
          name: error instanceof Error ? error.name : 'UnknownError',
        })
      })

      async function run() {
        const profileDuration = Math.max(1_000, Math.floor(totalDuration / 2))
        const four = await runProfile(4, profileDuration)
        const nine = await runProfile(9, profileDuration)
        fixture.dataset.bounded = String(four.bounded && nine.bounded)
        fixture.dataset.released = String(four.released && nine.released)
        fixture.dataset.report = JSON.stringify({
          kind: 'liveflow-browser-soak',
          totalDuration,
          profiles: [four, nine],
        })
        fixture.dataset.complete = 'true'
      }

      async function runProfile(instanceCount, duration) {
        fixture.replaceChildren()
        const coordinator = createOverlayBudgetCoordinator({
          maxInstances: instanceCount,
          maxActiveCards: 3,
          maxFullCards: 1,
          maxHighCostAnimations: 1,
        })
        const resources = []
        let sequence = 0
        let bounded = true
        let maxDanmakuNodes = 0
        let maxOverlayCards = 0
        let frameCount = 0
        let worstFrameGapMs = 0
        let previousFrameAt = performance.now()
        let frameActive = true
        let longTasks = 0
        let longestTaskMs = 0
        const memory = performance.memory
        const startingHeapBytes = memory?.usedJSHeapSize ?? null
        let peakHeapBytes = startingHeapBytes
        const observer = typeof PerformanceObserver === 'function'
          ? new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                longTasks += 1
                longestTaskMs = Math.max(longestTaskMs, entry.duration)
              }
            })
          : null
        try {
          observer?.observe({ type: 'longtask', buffered: true })
        } catch {
          observer?.disconnect()
        }

        const countFrame = (timestamp) => {
          if (!frameActive) {
            return
          }
          frameCount += 1
          worstFrameGapMs = Math.max(worstFrameGapMs, timestamp - previousFrameAt)
          previousFrameAt = timestamp
          requestAnimationFrame(countFrame)
        }
        requestAnimationFrame(countFrame)

        for (let instanceIndex = 0; instanceIndex < instanceCount; instanceIndex += 1) {
          const shell = document.createElement('section')
          const danmakuHost = document.createElement('div')
          danmakuHost.style.position = 'relative'
          danmakuHost.style.width = '640px'
          danmakuHost.style.height = '180px'
          const overlayHost = document.createElement('div')
          shell.append(danmakuHost, overlayHost)
          fixture.append(shell)
          const renderer = createDomDanmakuRenderer({
            container: danmakuHost,
            maxPoolSize: 48,
          })
          const danmaku = createDanmakuEngine({
            contractVersion: CONTRACT_VERSION,
            renderer,
            viewport: { width: 640, height: 180 },
            limits: {
              maxPending: 96,
              maxVisible: 32,
              maxPoolSize: 48,
              maxIntakePerSecond: 96,
              maxDisplayPerSecond: 48,
            },
          })
          const overlay = createOverlayEngine({
            contractVersion: CONTRACT_VERSION,
            instanceId: 'soak-browser-' + String(instanceCount) + '-' + String(instanceIndex),
            instanceState: {
              weight: instanceCount - instanceIndex,
              focused: instanceIndex === 0,
              visible: true,
            },
            coordinator,
            container: overlayHost,
            limits: {
              maxPending: 16,
              maxVisible: 1,
            },
          })
          resources.push({ danmaku, overlay, danmakuHost })
        }

        const startedAt = performance.now()
        try {
          while (performance.now() - startedAt < duration) {
            const elapsed = performance.now() - startedAt
            const phase = Math.floor(elapsed / 30_000) % 3
            const messageCount = phase === 0 ? 2 : phase === 1 ? 16 : 48
            for (const [instanceIndex, resource] of resources.entries()) {
              for (let messageIndex = 0; messageIndex < messageCount; messageIndex += 1) {
                sequence += 1
                resource.danmaku.push({
                  id: 'd-' + String(instanceIndex) + '-' + String(sequence),
                  receivedAt: performance.now(),
                  text: 'synthetic browser soak ' + String(messageIndex),
                  mode: messageIndex % 13 === 0 ? 'top' : 'scroll',
                  priority: messageIndex % 11 === 0 ? 90 : 10,
                })
              }
              sequence += 1
              resource.overlay.submit({
                id: 'o-' + String(instanceIndex) + '-' + String(sequence),
                kind: 'milestone',
                receivedAt: performance.now(),
                priority: sequence % 5 === 0 ? 90 : 10,
                durationMs: 2_000,
                nodes: [{
                  type: 'text',
                  role: 'message',
                  text: 'synthetic browser event',
                }],
              })
            }

            const budget = coordinator.getMetrics()
            bounded = bounded
              && budget.registeredInstances <= instanceCount
              && budget.activeCards <= 3
              && budget.activeFull <= 1
              && budget.activeHighCost <= 1
            for (const resource of resources) {
              const danmaku = resource.danmaku.getMetrics()
              const overlay = resource.overlay.getMetrics()
              const nodeCount = resource.danmakuHost
                .querySelectorAll('.liveflow-danmaku__message').length
              maxDanmakuNodes = Math.max(maxDanmakuNodes, nodeCount)
              bounded = bounded
                && danmaku.pendingDepth <= 96
                && danmaku.visible <= 32
                && overlay.pendingDepth <= 16
                && overlay.visible <= 1
                && nodeCount <= 32
            }
            maxOverlayCards = Math.max(
              maxOverlayCards,
              fixture.querySelectorAll('[data-liveflow-overlay-card]').length,
            )
            if (memory !== undefined) {
              peakHeapBytes = Math.max(peakHeapBytes ?? 0, memory.usedJSHeapSize)
            }
            await new Promise((resolve) => {
              setTimeout(resolve, 250)
            })
          }
        } finally {
          frameActive = false
          observer?.disconnect()
          for (const resource of resources) {
            resource.danmaku.destroy()
            resource.overlay.destroy()
          }
          coordinator.destroy()
        }

        const elapsedMs = performance.now() - startedAt
        const finalBudget = coordinator.getMetrics()
        const released = finalBudget.registeredInstances === 0
          && finalBudget.activeCards === 0
          && fixture.querySelectorAll('.liveflow-danmaku').length === 0
          && fixture.querySelectorAll('[data-liveflow-overlay-card]').length === 0
        const endingHeapBytes = memory?.usedJSHeapSize ?? null
        fixture.replaceChildren()
        return {
          instances: instanceCount,
          durationMs: elapsedMs,
          bounded,
          released,
          framesPerSecond: frameCount / (elapsedMs / 1_000),
          worstFrameGapMs,
          longTasks,
          longestTaskMs,
          maxDanmakuNodes,
          maxOverlayCards,
          startingHeapBytes,
          peakHeapBytes,
          endingHeapBytes,
        }
      }
    </script>
  </body>
</html>`

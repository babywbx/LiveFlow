import { gzipSync } from 'node:zlib'

import { build } from 'esbuild'

const targets = [
  {
    label: './continuity',
    path: './dist/continuity/index.js',
    maxGzipBytes: 6 * 1024,
  },
  {
    label: './danmaku',
    path: './dist/danmaku/index.js',
    maxGzipBytes: 7 * 1024,
  },
  {
    label: './danmaku/dom',
    path: './dist/danmaku/renderers/index.js',
    maxGzipBytes: 4 * 1024,
  },
  {
    label: './overlay',
    path: './dist/overlay/index.js',
    maxGzipBytes: 8 * 1024,
  },
  {
    label: './chrome',
    path: './dist/chrome/index.js',
    maxGzipBytes: 2 * 1024,
  },
  {
    label: './multiview',
    path: './dist/multiview/index.js',
    maxGzipBytes: 2 * 1024,
  },
  {
    label: './native-video',
    path: './dist/adapters/native-video.js',
    maxGzipBytes: 4 * 1024,
  },
  {
    label: './page-activity',
    path: './dist/adapters/document-page-activity.js',
    maxGzipBytes: 2 * 1024,
  },
  {
    label: './artplayer',
    path: './dist/adapters/artplayer.js',
    maxGzipBytes: 4 * 1024,
  },
]

const browserTargets = ['chrome111', 'safari16.4', 'firefox128']

/** @param {string} entryPoint @returns {Promise<number>} */
async function bundleGzipBytes(entryPoint) {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'esm',
    minify: true,
    platform: 'browser',
    target: browserTargets,
    treeShaking: true,
    write: false,
  })
  const output = result.outputFiles[0]
  if (output === undefined) {
    throw new Error(`No bundle was emitted for ${entryPoint}.`)
  }
  return gzipSync(output.contents, { level: 9 }).byteLength
}

/** @returns {Promise<number>} */
async function combinedGzipBytes() {
  const result = await build({
    stdin: {
      contents: [
        "export * as continuity from './dist/continuity/index.js'",
        "export * as danmaku from './dist/danmaku/index.js'",
        "export * as danmakuDom from './dist/danmaku/renderers/index.js'",
        "export * as overlay from './dist/overlay/index.js'",
      ].join('\n'),
      resolveDir: process.cwd(),
      sourcefile: 'liveflow-combined-entry.js',
    },
    bundle: true,
    format: 'esm',
    minify: true,
    platform: 'browser',
    target: browserTargets,
    treeShaking: true,
    write: false,
  })
  const output = result.outputFiles[0]
  if (output === undefined) {
    throw new Error('No combined bundle was emitted.')
  }
  return gzipSync(output.contents, { level: 9 }).byteLength
}

let failed = false
for (const target of targets) {
  const bytes = await bundleGzipBytes(target.path)
  const status = bytes <= target.maxGzipBytes ? 'PASS' : 'FAIL'
  console.log(
    `${status} ${target.label}: ${String(bytes)} / ${String(target.maxGzipBytes)} gzip bytes`,
  )
  failed ||= bytes > target.maxGzipBytes
}

const combinedBytes = await combinedGzipBytes()
const combinedLimit = 20 * 1024
const combinedStatus = combinedBytes <= combinedLimit ? 'PASS' : 'FAIL'
console.log(
  `${combinedStatus} combined core: ${String(combinedBytes)} / ${String(combinedLimit)} gzip bytes`,
)
failed ||= combinedBytes > combinedLimit

if (failed) {
  process.exitCode = 1
}

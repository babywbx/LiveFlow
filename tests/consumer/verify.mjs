import { readFile } from 'node:fs/promises'

import { CONTRACT_VERSION, ContractVersionMismatchError, LiveFlowError } from '@babywbx/liveflow'
import { createContinuityController, DEFAULT_CONTINUITY_POLICY } from '@babywbx/liveflow/continuity'
import { createDanmakuEngine } from '@babywbx/liveflow/danmaku'
import { createDomDanmakuRenderer } from '@babywbx/liveflow/danmaku/dom'
import { createOverlayBudgetCoordinator, createOverlayEngine } from '@babywbx/liveflow/overlay'
import { createEventBannerPresenter } from '@babywbx/liveflow/overlay/banner'
import { createChromeVisibility } from '@babywbx/liveflow/chrome'
import { multiviewGridSpec } from '@babywbx/liveflow/multiview'
import { createNativeVideoAdapter } from '@babywbx/liveflow/native-video'
import { createDocumentPageActivity } from '@babywbx/liveflow/page-activity'
import { createArtPlayerAdapter } from '@babywbx/liveflow/artplayer'
import { createDPlayerAdapter } from '@babywbx/liveflow/dplayer'
import { createVideoJsAdapter } from '@babywbx/liveflow/videojs'
import { createXgPlayerAdapter } from '@babywbx/liveflow/xgplayer'

const packageName = '@babywbx/liveflow'
const subpaths = [
  `${packageName}/continuity`,
  `${packageName}/danmaku`,
  `${packageName}/danmaku/dom`,
  `${packageName}/overlay`,
  `${packageName}/overlay/banner`,
  `${packageName}/chrome`,
  `${packageName}/multiview`,
  `${packageName}/native-video`,
  `${packageName}/page-activity`,
  `${packageName}/artplayer`,
  `${packageName}/dplayer`,
  `${packageName}/videojs`,
  `${packageName}/xgplayer`,
]

for (const subpath of subpaths) {
  await import(subpath)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

const packageJsonUrl = import.meta.resolve(`${packageName}/package.json`)
const installedManifest = JSON.parse(await readFile(new URL(packageJsonUrl), 'utf8'))
const exportedSubpaths = Object.keys(installedManifest.exports).filter(
  (subpath) => subpath !== '.' && subpath !== './package.json',
)
const coveredSubpaths = new Set(subpaths.map((subpath) => `.${subpath.slice(packageName.length)}`))
const missingCoverage = exportedSubpaths.filter((subpath) => !coveredSubpaths.has(subpath))
const staleCoverage = [...coveredSubpaths].filter((subpath) => !exportedSubpaths.includes(subpath))

if (missingCoverage.length > 0 || staleCoverage.length > 0) {
  fail(
    `Subpath coverage mismatch. Untested: ${missingCoverage.join(', ') || 'none'}; not exported: ${staleCoverage.join(', ') || 'none'}.`,
  )
}

if (!Number.isInteger(CONTRACT_VERSION) || CONTRACT_VERSION < 1) {
  fail('CONTRACT_VERSION is missing or invalid.')
}

const packageMajor = Number.parseInt(installedManifest.version.split('.')[0], 10)
if (!Number.isInteger(packageMajor) || CONTRACT_VERSION !== packageMajor) {
  fail(
    `Contract version ${String(CONTRACT_VERSION)} does not match package major ${String(packageMajor)}.`,
  )
}

if (!(new ContractVersionMismatchError(1, 2) instanceof LiveFlowError)) {
  fail('Error hierarchy did not survive the build.')
}

if (typeof createContinuityController !== 'function') {
  fail('createContinuityController is not callable from the built package.')
}

for (const [name, factory] of [
  ['createDanmakuEngine', createDanmakuEngine],
  ['createDomDanmakuRenderer', createDomDanmakuRenderer],
  ['createOverlayEngine', createOverlayEngine],
  ['createOverlayBudgetCoordinator', createOverlayBudgetCoordinator],
  ['createEventBannerPresenter', createEventBannerPresenter],
  ['createChromeVisibility', createChromeVisibility],
  ['multiviewGridSpec', multiviewGridSpec],
  ['createNativeVideoAdapter', createNativeVideoAdapter],
  ['createDocumentPageActivity', createDocumentPageActivity],
  ['createArtPlayerAdapter', createArtPlayerAdapter],
  ['createDPlayerAdapter', createDPlayerAdapter],
  ['createVideoJsAdapter', createVideoJsAdapter],
  ['createXgPlayerAdapter', createXgPlayerAdapter],
]) {
  if (typeof factory !== 'function') {
    fail(`${name} is not callable from the built package.`)
  }
}

if (typeof DEFAULT_CONTINUITY_POLICY?.targetLatencySeconds !== 'number') {
  fail('DEFAULT_CONTINUITY_POLICY did not survive the build.')
}

console.log(`contract ${CONTRACT_VERSION} resolved from ${subpaths.length + 1} entry points`)
console.log('runtime exports are callable and no DOM was required to import them')

import { CONTRACT_VERSION, ContractVersionMismatchError, LiveFlowError } from '@babywbx/liveflow'
import { createContinuityController, DEFAULT_CONTINUITY_POLICY } from '@babywbx/liveflow/continuity'

const subpaths = [
  '@babywbx/liveflow/continuity',
  '@babywbx/liveflow/danmaku',
  '@babywbx/liveflow/danmaku/dom',
  '@babywbx/liveflow/overlay',
  '@babywbx/liveflow/native-video',
  '@babywbx/liveflow/artplayer',
]

for (const subpath of subpaths) {
  await import(subpath)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

if (!Number.isInteger(CONTRACT_VERSION) || CONTRACT_VERSION < 1) {
  fail('CONTRACT_VERSION is missing or invalid.')
}

if (!(new ContractVersionMismatchError(1, 2) instanceof LiveFlowError)) {
  fail('Error hierarchy did not survive the build.')
}

if (typeof createContinuityController !== 'function') {
  fail('createContinuityController is not callable from the built package.')
}

if (typeof DEFAULT_CONTINUITY_POLICY?.targetLatencySeconds !== 'number') {
  fail('DEFAULT_CONTINUITY_POLICY did not survive the build.')
}

console.log(`contract ${CONTRACT_VERSION} resolved from ${subpaths.length + 1} entry points`)
console.log('runtime exports are callable and no DOM was required to import them')

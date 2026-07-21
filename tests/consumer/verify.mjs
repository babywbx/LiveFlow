import { CONTRACT_VERSION, ContractVersionMismatchError, LiveFlowError } from '@babywbx/liveflow'

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

if (!Number.isInteger(CONTRACT_VERSION) || CONTRACT_VERSION < 1) {
  console.error('CONTRACT_VERSION is missing or invalid.')
  process.exit(1)
}

if (!(new ContractVersionMismatchError(1, 2) instanceof LiveFlowError)) {
  console.error('Error hierarchy did not survive the build.')
  process.exit(1)
}

console.log(`contract ${CONTRACT_VERSION} resolved from ${subpaths.length + 1} entry points`)
console.log('no DOM was required to import the core entries')

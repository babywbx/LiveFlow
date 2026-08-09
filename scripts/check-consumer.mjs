import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const temporaryRoot = await mkdtemp(join(tmpdir(), 'liveflow-consumer-'))
const consumerRoot = join(temporaryRoot, 'consumer')
const tarballPath = join(temporaryRoot, 'liveflow.tgz')
const pnpmCli = process.env.npm_execpath

try {
  const packageManifest = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'))
  const consumerManifest = JSON.parse(
    await readFile(join(repositoryRoot, 'tests/consumer/package.json'), 'utf8'),
  )

  await mkdir(consumerRoot)
  await runPnpm(['pack', '--out', tarballPath], repositoryRoot)
  await writeFile(
    join(consumerRoot, 'package.json'),
    `${JSON.stringify(
      {
        ...consumerManifest,
        dependencies: { [packageManifest.name]: `file:${tarballPath}` },
      },
      null,
      2,
    )}\n`,
  )
  await cp(join(repositoryRoot, 'tests/consumer/verify.mjs'), join(consumerRoot, 'verify.mjs'))
  await cp(join(repositoryRoot, 'tests/consumer/verify.ts'), join(consumerRoot, 'verify.ts'))
  await cp(
    join(repositoryRoot, 'tests/consumer/tsconfig.json'),
    join(consumerRoot, 'tsconfig.json'),
  )
  await runPnpm(
    ['install', '--ignore-workspace', '--offline', '--ignore-scripts', '--no-lockfile'],
    consumerRoot,
  )
  await runPnpm(['exec', 'tsc', '-p', join(consumerRoot, 'tsconfig.json')], repositoryRoot)
  await run(process.execPath, ['verify.mjs'], consumerRoot)
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}

/** @param {string[]} args @param {string} cwd @returns {Promise<void>} */
async function runPnpm(args, cwd) {
  if (pnpmCli === undefined) {
    await run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, cwd)
    return
  }
  await run(process.execPath, [pnpmCli, ...args], cwd)
}

/** @param {string} command @param {string[]} args @param {string} cwd @returns {Promise<void>} */
async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve(undefined)
        return
      }
      reject(new Error(`${command} failed with ${signal ?? `exit code ${String(code)}`}.`))
    })
  })
}

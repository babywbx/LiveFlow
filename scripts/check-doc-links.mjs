import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'

const repositoryRoot = process.cwd()
const markdownFiles = [
  'README.md',
  'README.en.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'THIRD_PARTY_NOTICES.md',
  ...collectMarkdown('docs'),
]
const markdownLink = /!?\[[^\]]*]\(([^)\s]+)(?:\s+["'][^)]*)?\)/g
const failures = []

for (const relativeFile of markdownFiles) {
  const absoluteFile = resolve(repositoryRoot, relativeFile)
  const content = readFileSync(absoluteFile, 'utf8')
  for (const match of content.matchAll(markdownLink)) {
    const rawTarget = match[1]
    if (
      rawTarget === undefined ||
      rawTarget.startsWith('#') ||
      /^[a-z][a-z\d+.-]*:/i.test(rawTarget)
    ) {
      continue
    }
    const pathTarget = rawTarget.split('#', 1)[0]
    if (pathTarget === undefined || pathTarget.length === 0) {
      continue
    }
    const absoluteTarget = resolve(dirname(absoluteFile), decodeURIComponent(pathTarget))
    if (!existsSync(absoluteTarget)) {
      failures.push(`${relativeFile}: missing ${rawTarget}`)
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure)
  }
  process.exitCode = 1
} else {
  console.log(`PASS documentation links: ${String(markdownFiles.length)} files`)
}

/** @param {string} relativeDirectory @returns {string[]} */
function collectMarkdown(relativeDirectory) {
  const absoluteDirectory = resolve(repositoryRoot, relativeDirectory)
  const files = []
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const relativePath = `${relativeDirectory}/${entry.name}`
    if (entry.isDirectory()) {
      files.push(...collectMarkdown(relativePath))
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      files.push(relativePath)
    }
  }
  return files.sort()
}

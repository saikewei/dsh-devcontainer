// Bilingual pairing guard, following DeepSeek Harness's own convention for its packages
// (`@deepseek-ai/dsh-base/README.i18n.yaml`): each side's git blob hash is recorded as of the
// last confirmed-consistent state, and drift fails the suite.
//
// Both languages carry equal authority here — the Chinese README is not a subsidiary
// translation that may lag. Editing either side means bringing the other along, then
// re-recording with:
//
//   node test/readme-pair.mjs --write
//
// The blob hash is computed in-process rather than by shelling out to `git hash-object`, so
// this runs in a tarball checkout with no git and no subprocess seam.
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const RECORD = 'README.i18n.yaml'
const PAIR = ['README.md', 'README.zh.md']

/** The git blob hash: sha1 over `blob <bytes>\0<content>`. */
function blobHash(text) {
  const body = Buffer.from(text, 'utf8')
  return createHash('sha1').update('blob ' + String(body.length) + '\u0000').update(body).digest('hex')
}

const read = (name) => readFileSync(join(root, name), 'utf8')

let failures = 0
const check = (label, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
  if (!ok) failures++
}

const recorded = new Map()
const recordText = read(RECORD)
for (const match of recordText.matchAll(/^(README[\w.-]*\.md):\s*([0-9a-f]{40})\s*$/gm)) {
  recorded.set(match[1], match[2])
}

if (process.argv.includes('--write')) {
  let next = recordText
  for (const name of PAIR) {
    next = next.replace(
      new RegExp('^(' + name.replace('.', '\\.') + '):\\s*[0-9a-f]{40}\\s*$', 'm'),
      '$1: ' + blobHash(read(name)),
    )
  }
  writeFileSync(join(root, RECORD), next)
  console.log('re-recorded ' + RECORD + ' — commit both sides together.')
  process.exit(0)
}

console.log('-- the bilingual pair is in step --')
check('the record lists both sides', PAIR.every((name) => recorded.has(name)), [...recorded.keys()].join(', '))

for (const name of PAIR) {
  check(name + ' exists', (() => {
    try {
      read(name)
      return true
    } catch {
      return false
    }
  })())
}

for (const name of PAIR) {
  const actual = blobHash(read(name))
  check(
    name + ' matches the recorded hash',
    recorded.get(name) === actual,
    recorded.get(name) === undefined
      ? 'no hash recorded'
      : 'recorded ' + String(recorded.get(name)).slice(0, 12) + ', actual ' + actual.slice(0, 12)
      + ' — bring the other side along, then: node test/readme-pair.mjs --write',
  )
}

// A switcher that only exists on one side strands the reader who lands on the other.
const OTHER = { 'README.md': 'README.zh.md', 'README.zh.md': 'README.md' }
for (const name of PAIR) {
  const text = read(name)
  check(name + ' links to its counterpart', text.includes('](' + OTHER[name] + ')'), 'no switcher line')
  check(name + ' is reachable from the switcher', read(OTHER[name]).includes('](' + name + ')'))
}

console.log('')
if (failures > 0) {
  console.log(failures + ' CHECK(S) FAILED')
  process.exit(1)
}
console.log('ALL CHECKS PASSED')

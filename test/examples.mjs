// Guards the deployment guidance this repository publishes, rather than the plugin's own
// behaviour. The examples are what an operator copies into a profile, and one combination
// is actively harmful: a stand-in configured without routing. It makes the workspace picker
// offer container directories, registers a path that is a real but EMPTY local directory,
// and — because the workspace registry is shared by every profile that has no registry of
// its own — drops that entry into the operator's daily profile.
//
// Everything here is dependency-free and runs everywhere.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let failures = 0
const check = (label, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
  if (!ok) failures++
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(join(root, relative), 'utf8')

const examplesDir = join(root, 'examples')
const examples = readdirSync(examplesDir).filter((name) => name.endsWith('.cordis.patch.yml'))
const body = (name) => read(join('examples', name))

/** The config object of the `devcontainer` row, as text. Good enough for a presence check. */
const rowConfig = (text) => {
  const at = text.indexOf('- id: devcontainer')
  return at === -1 ? '' : text.slice(at)
}

console.log('-- a stand-in only ships where it can be routed --')
const withStandIn = examples.filter((name) => /^\s+mount(Root|Point):/m.test(rowConfig(body(name))))
check('at least one example configures a stand-in', withStandIn.length > 0, String(withStandIn.length))
for (const name of withStandIn) {
  const text = rowConfig(body(name))
  check(`${name}: routes the stand-in it registers`, /^\s+provideFs: true$/m.test(text), 'provideFs is not true')
  check(
    `${name}: keeps its registry out of the shared one`,
    text.includes('- id: storage-json') || body(name).includes('- id: storage-json'),
    'no storage-json row',
  )
}

console.log('\n-- a tools-only example registers nothing --')
const toolsOnly = examples.filter((name) => /^\s+provideFs: false$/m.test(rowConfig(body(name))))
check('at least one example is tools-only', toolsOnly.length > 0, String(toolsOnly.length))
for (const name of toolsOnly) {
  check(
    `${name}: configures no stand-in`,
    !/^\s+mount(Root|Point):/m.test(rowConfig(body(name))),
    'a tools-only profile must not offer the container picker',
  )
}

console.log('\n-- the guidance the README points at actually ships --')
const manifests = ['README.md', 'docs/architecture.md'].filter((name) => existsSync(join(root, name)))
const referenced = new Set()
for (const name of manifests) {
  for (const match of read(name).matchAll(/examples\/([a-z-]+\.cordis\.patch\.yml)/g)) referenced.add(match[1])
}
check('the README references the examples', referenced.size > 0, String(referenced.size))
const dangling = [...referenced].filter((name) => !examples.includes(name))
check('every referenced example exists', dangling.length === 0, dangling.join(', '))

// The package publishes `files`, so an example the README cites but `files` omits is
// invisible to anyone who installed from npm.
const pkg = JSON.parse(read('package.json'))
const published = pkg.files ?? []
check('the examples are published, not just cited', published.includes('examples'), published.join(', '))
check('the docs are published, not just cited', published.includes('docs') || !existsSync(join(root, 'docs')), published.join(', '))

console.log('\n-- the isolation recipe is stated, not just implied --')
const readme = read('README.md')
check('the README explains the shared registry', /shared by every profile/.test(readme))
check('and gives the storage-json row', /- id: storage-json/.test(readme) && /dshHomePath\('profiles\//.test(readme))
check('and says session logs stay shared', /sessions.*still|still.*every conversation|shared `\$DSH_HOME\/sessions`/.test(readme))

console.log('')
if (failures > 0) {
  console.log(failures + ' CHECK(S) FAILED')
  process.exit(1)
}
console.log('ALL CHECKS PASSED')

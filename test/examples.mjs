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
  // Two roots leak, and isolating only the first is the subtle half-failure: the workspace
  // disappears from the other profiles while its conversation merely moves to Ungrouped.
  check(
    `${name}: keeps its registry out of the shared one`,
    body(name).includes('- id: storage-json'),
    'no storage-json row',
  )
  check(
    `${name}: keeps its conversations out of the shared one`,
    body(name).includes('- id: session-persistence-jsonl'),
    'no session-persistence-jsonl row',
  )
}

// The README was guarded against the retracted claim but the routing example was not, which
// is how it kept a sentence saying session logs are unaffected six lines above the row that
// isolates them.
for (const name of examples) {
  check(
    `${name}: does not claim session logs stay shared`,
    !/Session logs are unaffected/.test(body(name)),
    'the session log root is shared by default and leaks',
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

console.log('\n-- the shipped bundle carries no operator\'s own target --')
// `dsh plugin add dsh-devcontainer` installs this patch verbatim, so anything filled in here
// becomes everybody's default. A host alias, container name or project path that belongs to
// one machine is both wrong for every other installation and a leak of that machine.
const shipped = read('cordis.patch.yml')
const shippedConfig = Object.fromEntries(
  [...shipped.matchAll(/^ {8}([a-zA-Z]+):[ \t]*(.*)$/gm)].map((m) => [m[1], m[2].trim()]),
)
check('the shipped row declares its config', Object.keys(shippedConfig).length >= 5, JSON.stringify(shippedConfig))
for (const key of ['sshHost', 'container', 'hostRoot', 'mountPoint']) {
  check(`${key} ships empty rather than pointing somewhere`, shippedConfig[key] === "''", String(shippedConfig[key]))
}
check('containerRoot ships as the container root', shippedConfig.containerRoot === "'/'", String(shippedConfig.containerRoot))

// The in-code default matters just as much: it is what an override that omits the key gets.
const source = read('lib/index.js')
check(
  'DEFAULT_CONFIG leaves sshHost empty too',
  /const DEFAULT_CONFIG = \{[\s\S]*?\n {2}sshHost: '',/.test(source),
  'a plausible-looking default would aim a new installation at somebody else',
)

console.log('\n-- every tool the plugin registers is documented --')
// An undocumented tool is invisible: the operator cannot know it exists, and the model is
// told about it only by its own schema. This caught the five devc_host_* tools, which were
// named in passing but described nowhere.
const registered = [...new Set([...source.matchAll(/name: '(devc_[a-z_]+)'/g)].map((m) => m[1]))]
check('the plugin registers tools', registered.length >= 8, String(registered.length))
// Both languages, not just the canonical one: the pairing record proves the two sides were
// re-recorded together, not that either of them actually documents what the code registers.
for (const name of ['README.md', 'README.zh.md']) {
  if (!existsSync(join(root, name))) continue
  const text = read(name)
  const undocumented = registered.filter((tool) => !text.includes(tool))
  check(`none is missing from ${name}`, undocumented.length === 0, undocumented.join(', '))
}

console.log('\n-- the isolation recipe is stated, not just implied --')
const readme = read('README.md')
check('the README explains the shared registry', /shared by every profile/.test(readme))
check('and gives the storage-json row', /- id: storage-json/.test(readme) && /dshHomePath\('profiles\//.test(readme))
check(
  'and names the second shared root',
  /session-persistence-jsonl/.test(readme) && /Ungrouped/.test(readme),
  'the session log root must be named, with the Ungrouped failure mode',
)
// The claim that isolating the registry is enough was wrong once and cost a round trip.
check(
  'and warns that the registry alone is not enough',
  /only the registry is not enough|Isolating only the registry is not enough/i.test(readme),
)
check(
  'and does not repeat the old "sessions are unaffected" claim',
  !/Session logs are unaffected/.test(readme),
)
// The second trap this guard exists for: seeding the profile's registry by copying the
// shared file "so nothing is lost" carries the other world's workspaces back in.
check(
  'and warns against seeding the new registry by copying',
  /rather than copying/i.test(readme) && /workspace\.json/.test(readme),
  'the copy-the-registry trap must be named',
)
check(
  'and scopes the session move to the stand-in directories',
  /move only the stand-in log directories/i.test(readme),
)

console.log('')
if (failures > 0) {
  console.log(failures + ' CHECK(S) FAILED')
  process.exit(1)
}
console.log('ALL CHECKS PASSED')

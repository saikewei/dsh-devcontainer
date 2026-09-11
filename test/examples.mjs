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

console.log('-- the bundle disables nothing --')
// The whole point of routing in the tool layer: no composition row is switched off, so a profile
// cannot be left with no filesystem when this plugin is absent. A `disabled:` anywhere in the
// shipped patch is the foot-gun coming back.
const patchText = read('cordis.patch.yml')
check('the shipped patch disables no row', !/^\s*disabled:/m.test(patchText), 'a disabled row reappeared')
const patchIds = [...patchText.matchAll(/^- id: ([\w-]+)/gm)].map((m) => m[1])
check('and it only inserts its own row', patchIds.length === 0 || patchIds.every((id) => id === 'devcontainer'), patchIds.join(', '))

console.log('\n-- the routing flags are gone --')
// There is no mode to be in, so there is nothing to switch: a config key that no longer exists
// silently does nothing, and one that reappears means the design regressed.
const pluginSource = read('lib/index.js')
for (const key of ['provideFs', 'provideShell', 'provideSearch']) {
  check(`DEFAULT_CONFIG has no ${key}`, !new RegExp('^\\s*' + key + ':', 'm').test(pluginSource))
}
check('the shipped row carries none either', !/provide(Fs|Shell|Search):/.test(patchText))

console.log('\n-- every example is the configuration, nothing else --')
for (const name of examples) {
  const text = body(name)
  check(`${name}: disables nothing`, !/^\s*disabled:/m.test(text))
  check(`${name}: carries no routing flag`, !/provide(Fs|Shell|Search):/.test(text))
}

console.log('\n-- the README states the two guarantees --')
const mainReadme = read('README.md')
check('routing is described as per session', /per session/i.test(mainReadme))
check('and a local session is described as untouched', /not reached|never reaches the routing code/i.test(mainReadme), 'the local-untouched guarantee must be stated')
check('and nothing global is said to be replaced', /[Nn]othing global is replaced|[Nn]othing here is disabled/i.test(mainReadme))
check('the isolation recipe is gone', !/shared by every profile|storage-json/.test(mainReadme), 'the retracted isolation recipe is still documented')

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

console.log('')
if (failures > 0) {
  console.log(failures + ' CHECK(S) FAILED')
  process.exit(1)
}
console.log('ALL CHECKS PASSED')

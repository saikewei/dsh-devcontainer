// Routing acceptance test: bring up the REAL sandbox/subprocess/tools stack, mount the
// routing providers the way the devcontainer profile does (with the shipped fs-sandbox
// and bash-sandbox left out), and prove the harness's ORDINARY fs/shell seams operate
// inside the container for mount-point paths while staying local — and sandboxed —
// everywhere else.
import { mkdir, rm } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { CONFIG as TARGET, requireTarget } from './config.mjs'

requireTarget('sshHost', 'container', 'containerRoot')

const CONFIG = {
  ...TARGET,
  // Routing mode: the shipped `fs-sandbox` and `bash-sandbox` are deliberately NOT mounted
  // below, so the routers must take their seams.
  tools: false,
  provideFs: true,
  provideShell: true,
  prompt: false,
}

/** A module's plugin is its default export (class or object) or the namespace itself. */
function pluginOf(mod) {
  const fallback = mod.default
  if (typeof fallback === 'function') return fallback
  if (fallback && typeof fallback === 'object' && typeof fallback.apply === 'function') return fallback
  if (typeof mod.apply === 'function') return mod
  throw new Error('no Cordis plugin found in module')
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 400))

// The mount point must be a real local directory: the workspace registry canonicalizes
// it with node:fs realpath, which never sees the container.
await mkdir(CONFIG.mountPoint, { recursive: true })

let failures = 0
const check = (label, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
  if (!ok) failures++
}

const app = new Context()
app.plugin(pluginOf(await import('@deepseek-ai/dsh-system-prompt')))
app.plugin(pluginOf(await import('@deepseek-ai/dsh-subprocess-local')))
app.plugin(pluginOf(await import('@deepseek-ai/dsh-sandbox-local')))
app.plugin(pluginOf(await import('@deepseek-ai/dsh-session-projection')))
app.plugin(pluginOf(await import('@deepseek-ai/dsh-sandbox-policy')), {
  mode: 'workspace-write',
  workspaceRoot: CONFIG.mountPoint,
})
app.plugin(pluginOf(await import('@deepseek-ai/dsh-tools')))
await settle()

console.log('-- composition (fs-sandbox and bash-sandbox deliberately NOT mounted) --')
console.log('tools service     :', app.tools !== undefined)
console.log('sandboxPolicy     :', app.sandboxPolicy !== undefined)
check('ctx.fs is not yet provided', app.fs === undefined)
check('ctx.shell is not yet provided', app.shell === undefined)

app.plugin(await import('../lib/index.js'), CONFIG)
await settle()

console.log('\n-- routing providers took the seams --')
console.log('ctx.fs    :', app.fs ? app.fs.constructor.name : '(none)')
console.log('ctx.shell :', app.shell ? app.shell.constructor.name : '(none)')
check('ctx.fs is the router', app.fs !== undefined && app.fs.constructor.name === 'RoutingFileSystem')
check('ctx.shell is the router', app.shell !== undefined && app.shell.constructor.name === 'RoutingBashExecutor')

const fs = app.fs
const mount = (rel) => CONFIG.mountPoint + (rel === undefined ? '' : '/' + rel)

console.log('\n-- ctx.fs: container world via the mount point --')
const target = await fs.resolve(mount('go.mod'))
console.log('resolve(mount/go.mod) ->', JSON.stringify({ key: String(target.targetKey), display: target.displayPath }))
// A target key carries its world, because the same path exists on the host and in the
// container: `/etc/hosts` is a different file in each.
const KEY_SEP = String.fromCharCode(0)
const worldOf = (t) => String(t.targetKey).split(KEY_SEP)[0]
const pathOf = (t) => String(t.targetKey).split(KEY_SEP).slice(1).join(KEY_SEP)
check('the mount-point spelling resolves into the container world', worldOf(target) === 'container', worldOf(target))
check('and names the container path', pathOf(target) === CONFIG.containerRoot + '/go.mod', pathOf(target))
check('the display path is the container path, not the stand-in', target.displayPath === CONFIG.containerRoot + '/go.mod')

const target2 = await fs.resolve(CONFIG.containerRoot + '/go.mod')
check('container spelling resolves to the same target', String(target2.targetKey) === String(target.targetKey))

const text = await fs.readText(target)
check('readText returns container content', text.includes('module shutterseek'))

const info = await fs.stat(target)
console.log('stat ->', JSON.stringify({ type: info.type, size: info.size, version: String(info.version) }))
check('stat reports a regular file', info.type === 'file' && info.size > 1000)

const entries = await fs.listDir(await fs.resolve(mount()))
const names = entries.map((entry) => entry.name)
console.log('listDir -> ', names.slice(0, 8).join(', '), '…')
check('listDir lists the container project', names.includes('go.mod') && names.includes('cmd'))

const missing = await fs.stat(await fs.resolve(mount('does-not-exist.txt')))
check('stat on an absent container path returns undefined', missing === undefined)

console.log('\n-- ctx.fs: container mutations --')
// A previous crashed run may have left the scratch file behind; createIfAbsent is
// supposed to refuse that, so clear it first rather than asserting on stale state.
await app.shell.run(app.shell.resolve({ command: 'rm -f .dsh-routing-test.txt', workdir: mount() }))
const scratch = await fs.resolve(mount('.dsh-routing-test.txt'))
const created = await fs.writeText(scratch, 'alpha\nbeta\n', { kind: 'createIfAbsent' })
console.log('writeText ->', created.operation, String(created.version))
check('writeText creates in the container', created.operation === 'create')

const edited = await fs.editText(scratch, { oldString: 'beta', newString: 'BETA', replaceAll: false }, { version: created.version })
check('editText applies with a version guard', edited.after.includes('BETA'))

const reread = await fs.readText(scratch)
check('the edit persisted in the container', reread.includes('BETA'))

let staleRejected = false
try {
  await fs.editText(scratch, { oldString: 'alpha', newString: 'ALPHA', replaceAll: false }, { version: created.version })
} catch (error) {
  staleRejected = String(error.code ?? error.message).includes('FS_STALE_VERSION')
}
check('a stale version guard is rejected', staleRejected)

let ambiguousRejected = false
try {
  // Content is "alpha\nBETA\n": lowercase 'a' genuinely appears twice.
  await fs.editText(scratch, { oldString: 'a', newString: 'Z', replaceAll: false })
} catch (error) {
  ambiguousRejected = String(error.message).includes('replace_all')
}
check('an ambiguous edit is rejected', ambiguousRejected)
check('the rejected edit left the file untouched', (await fs.readText(scratch)).includes('BETA'))

const bytes = await fs.readBytes(scratch, undefined, 1024)
check('readBytes returns container bytes', Buffer.from(bytes).toString('utf8').includes('BETA'))

console.log('\n-- ctx.shell: container world via the mount point --')
const spec = app.shell.resolve({ command: 'echo "cwd=$(pwd)"; hostname; test -f /.dockerenv && echo in_container=yes', workdir: mount() })
console.log('resolved workdir ->', spec.workdir)
check('resolve maps the mount point to the container path', spec.workdir === CONFIG.containerRoot)

const result = await app.shell.run(spec)
console.log('run stdout:', result.stdout.text.trim().split('\n').join(' | '))
check('the command ran inside the container', result.stdout.text.includes('in_container=yes'))
check('the command ran in the container workdir', result.stdout.text.includes('cwd=' + CONFIG.containerRoot))
check('a successful run reports exit 0 and no sandbox facts', result.exitCode === 0 && result.sandbox === undefined)

const failing = await app.shell.run(app.shell.resolve({ command: 'exit 7', workdir: mount() }))
check('a non-zero exit is reported, not thrown', failing.exitCode === 7)

console.log('\n-- ctx.shell: background streaming --')
// A burst with no sleep maximises the chance that the `exec_start` response and the first
// chunks share one TCP read — the exact condition that used to drop `tick1`, because the
// listener was only attached once the response promise settled. Five rounds so a race
// cannot pass by luck.
const TICKS = ['tick1', 'tick2', 'tick3', 'tick4', 'tick5']
let roundsComplete = 0
let lastStreamed = ''
let settledStatus = ''
for (let round = 0; round < 5; round++) {
  const proc = app.shell.start(app.shell.resolve({
    command: 'for i in 1 2 3 4 5; do echo tick$i; done',
    workdir: mount(),
  }))
  await proc.done
  const streamed = proc.readOutput().delta
  lastStreamed = streamed.trim()
  settledStatus = proc.status
  if (TICKS.every((tick) => streamed.includes(tick))) roundsComplete++
}
console.log('streamed (last round):', JSON.stringify(lastStreamed))
check('every background round streamed its complete output', roundsComplete === 5, roundsComplete + '/5 complete')
check('the background process settles completed', settledStatus === 'completed', settledStatus)

console.log('\n-- local world is untouched AND still sandboxed --')
const localTarget = await fs.resolve('/tmp/dsh-devcontainer-local-test.txt')
console.log('resolve(/tmp/...) ->', String(localTarget.targetKey))
check(
  'a local path goes through the shipped local backend (realpath, not the container)',
  String(localTarget.targetKey) === '/private/tmp/dsh-devcontainer-local-test.txt',
)

// The local branch must still reach the SHIPPED sandboxed executor. This process runs
// inside DSH's own file sandbox, where a nested sandbox-exec cannot start, so the
// correct outcome here is a refusal to run unconfined — which is itself the proof that
// the local branch did not silently become unconfined.
let localRun = null
let localRefused = null
try {
  localRun = await app.shell.run(app.shell.resolve({ command: 'echo local-here; hostname', workdir: '/tmp' }))
} catch (error) {
  localRefused = String(error.code ?? error.message)
}
if (localRun !== null) {
  console.log('local run:', localRun.stdout.text.trim().split('\n').join(' | '))
  check('a local workdir runs on this machine, not the container', !localRun.stdout.text.includes('in_container=yes'))
  check('the local branch still reports sandbox facts', localRun.sandbox !== undefined)
} else {
  console.log('local run refused:', localRefused)
  check(
    'the local branch still reaches the shipped sandbox (it refused to run unconfined)',
    localRefused === 'SANDBOX_UNAVAILABLE',
  )
}

// Not under the workspace root and not a platform temp area (DSH permits those), so
// this must still be fenced by the shipped policy.
const escapePath = CONFIG.escapePath
let sandboxDetail = '(the write was ALLOWED)'
try {
  await fs.writeText(await fs.resolve(escapePath), 'nope\n')
} catch (error) {
  sandboxDetail = String(error.code ?? '') + ' ' + String(error.message).slice(0, 120)
}
check(
  'a local write outside the workspace root is still DENIED (no regression)',
  sandboxDetail.includes('FS_SANDBOX_DENIED'),
  sandboxDetail,
)

console.log('\n-- cleanup --')
const removeTarget = await fs.resolve(mount('.dsh-routing-test.txt'))
try {
  await app.shell.run(app.shell.resolve({ command: 'rm -f .dsh-routing-test.txt', workdir: mount() }))
  check('scratch file removed', (await fs.stat(removeTarget)) === undefined)
} catch (error) {
  check('scratch file removed', false, String(error.message))
}
await rm(CONFIG.mountPoint, { recursive: true, force: true })

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'))
process.exit(failures === 0 ? 0 : 1)

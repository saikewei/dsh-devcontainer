// World dispatch: do the routers send each world to the RIGHT channel?
//
// Container-free by construction — the channels are recorders, not connections — so this
// guards the dispatch layer everywhere the integration suites cannot run. What it proves is
// narrow and worth having: a host path is never asked of the container channel and vice
// versa, and the path each channel receives is the one for its own world.
import { Context } from '@deepseek-ai/cordis'
import { Worlds, createRoutingFileSystem, createRoutingShellExecutor } from '../lib/routing.js'
import { registerRoutingSearch } from '../lib/search.js'

const MOUNT_ROOT = '/Users/you/.dsh/devcontainer/root'
const HOST_A = 'nas'
const HOST_B = 'eu'
const HOST_FOLDER = '/volume1/docker/my-project'
const CONTAINER_PATH = '/workspaces/my-project'
const CONTAINER_ROOT = '/workspaces/my-project'

let failures = 0
const check = (label, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
  if (!ok) failures++
}

/** A channel that records what it was asked and answers plausibly. */
function recorder(world) {
  const listeners = []
  let seq = 0
  return {
    world,
    calls: [],
    onEvent(listener) {
      listeners.push(listener)
      return () => {
        const at = listeners.indexOf(listener)
        if (at !== -1) listeners.splice(at, 1)
      }
    },
    emit(event) {
      for (const listener of [...listeners]) listener(event)
    },
    async request(request) {
      this.calls.push(request)
      switch (request.op) {
        case 'ping':
          return { ok: true, host: world, pid: 1, cwd: '/' }
        case 'stat':
        case 'lstat':
          return { ok: true, exists: true, type: 'file', size: 10, mtimeMs: 1000 }
        case 'read':
          return { ok: true, text: world + ' says ' + request.path, bytes: 10 }
        case 'list':
          return { ok: true, entries: [{ name: 'child', type: 'file', size: 1, mtimeMs: 1 }] }
        case 'write':
          return { ok: true, bytes: 3, mtimeMs: 1000 }
        case 'exec':
          return { ok: true, code: 0, stdout: world + ' ran ' + request.cmd, stderr: '', truncated: false }
        case 'exec_start': {
          const execId = 'exec-' + String(++seq)
          // The burst is emitted SYNCHRONOUSLY, before the response is returned — which is what
          // the resident channel really does, and the reason the stream dispatcher buffers by
          // execId instead of waiting for `claim`.
          this.emit({ execId, event: 'chunk', stream: 'stdout', text: world + ' bg\n' })
          this.emit({ execId, event: 'exit', code: 0, signal: null })
          return { ok: true, execId }
        }
        default:
          return { ok: true }
      }
    },
    last() {
      return this.calls[this.calls.length - 1]
    },
  }
}

// One recorder per (machine, world): the point is that the right one is chosen.
const recorders = {
  [`${HOST_A}|host`]: recorder(HOST_A + '/host'),
  [`${HOST_A}|container`]: recorder(HOST_A + '/container'),
  [`${HOST_B}|host`]: recorder(HOST_B + '/host'),
}
const host = recorders[`${HOST_A}|host`]
const container = recorders[`${HOST_A}|container`]
const other = recorders[`${HOST_B}|host`]
const channels = {
  forTarget: (target) => recorders[`${target.host}|${target.world}`],
}

const worlds = new Worlds({ sshHost: HOST_A, containerRoot: CONTAINER_ROOT, mountRoot: MOUNT_ROOT })
worlds.setResolved([
  // On machine A, the mirror folder that has a dev container…
  { localPrefix: MOUNT_ROOT + '/' + HOST_A + HOST_FOLDER, host: HOST_A, world: 'container', container: 'epic', remotePath: CONTAINER_PATH },
  // …and one that does not.
  { localPrefix: MOUNT_ROOT + '/' + HOST_A + '/volume1/docker/redis', host: HOST_A, world: 'host', remotePath: '/volume1/docker/redis' },
  // On machine B, a plain host directory.
  { localPrefix: MOUNT_ROOT + '/' + HOST_B + '/srv/app', host: HOST_B, world: 'host', remotePath: '/srv/app' },
])

// A real Cordis app for the shipped seams the routers extend.
const settle = (ms = 600) => new Promise((resolve) => setTimeout(resolve, ms))
function pluginOf(mod) {
  const fallback = mod.default
  if (typeof fallback === 'function') return fallback
  if (fallback && typeof fallback === 'object' && typeof fallback.apply === 'function') return fallback
  if (typeof mod.apply === 'function') return mod
  throw new Error('no Cordis plugin found in module')
}

const app = new Context()
app.plugin(pluginOf(await import('@deepseek-ai/dsh-system-prompt')))
app.plugin(pluginOf(await import('@deepseek-ai/dsh-subprocess-local')))
app.plugin(pluginOf(await import('@deepseek-ai/dsh-sandbox-local')))
app.plugin(pluginOf(await import('@deepseek-ai/dsh-session-projection')))
app.plugin(pluginOf(await import('@deepseek-ai/dsh-sandbox-policy')), { mode: 'workspace-write', workspaceRoot: '/tmp' })
app.plugin(pluginOf(await import('@deepseek-ai/dsh-tools')))
await settle()

app.plugin(createRoutingFileSystem(channels, worlds))
app.plugin(createRoutingShellExecutor(channels, worlds))
await settle()

const fs = app.fs
const shell = app.shell
check('the router took ctx.fs', fs !== undefined && fs.constructor.name === 'RoutingFileSystem', fs === undefined ? 'undefined' : fs.constructor.name)
check('the router took ctx.shell', shell !== undefined && shell.constructor.name === 'RoutingBashExecutor')

const KEY_SEP = String.fromCharCode(0)
// The tag is `<host>|<world>|<container>`, so every assertion can name the machine too.
const tagOf = (t) => String(t.targetKey).split(KEY_SEP)[0]
const worldOf = (t) => tagOf(t).split('|').slice(0, 2).join('/')
const pathOf = (t) => String(t.targetKey).split(KEY_SEP).slice(1).join(KEY_SEP)

console.log('\n-- a mirror folder that has a dev container --')
host.calls.length = 0
container.calls.length = 0
const inside = await fs.resolve(MOUNT_ROOT + '/' + HOST_A + HOST_FOLDER + '/cmd/main.go')
check('resolves into the container world, on the right machine', worldOf(inside) === HOST_A + '/container', worldOf(inside))
check('at the container path', pathOf(inside) === CONTAINER_PATH + '/cmd/main.go', pathOf(inside))
await fs.stat(inside)
check('stat went to the container channel', container.last()?.op === 'stat')
check('with the container path, not the host one', container.last()?.path === CONTAINER_PATH + '/cmd/main.go', container.last()?.path)
check('and never to the host channel', host.calls.length === 0, JSON.stringify(host.calls))
const text = await fs.readText(inside)
check('readText content came from the container channel', text.startsWith(HOST_A + '/container says'), text)

console.log('\n-- a mirror folder with no dev container --')
host.calls.length = 0
container.calls.length = 0
const onHost = await fs.resolve(MOUNT_ROOT + '/' + HOST_A + '/volume1/docker/redis/src/app.go')
check('resolves into the host world', worldOf(onHost) === HOST_A + '/host', worldOf(onHost))
check('at the host path', pathOf(onHost) === '/volume1/docker/redis/src/app.go', pathOf(onHost))
await fs.stat(onHost)
check('stat went to the host channel', host.last()?.op === 'stat')
check('with the host path', host.last()?.path === '/volume1/docker/redis/src/app.go', host.last()?.path)
check('and never to the container channel', container.calls.length === 0, JSON.stringify(container.calls))

console.log('\n-- listing children keeps the parent world --')
host.calls.length = 0
container.calls.length = 0
const entries = await fs.listDir(await fs.resolve(MOUNT_ROOT + '/' + HOST_A + HOST_FOLDER))
check('the listing came from the container channel', container.last()?.op === 'list')
check('a child target stays in the container world', entries.length === 1 && worldOf(entries[0].target) === HOST_A + '/container', entries[0] === undefined ? '(no entries)' : worldOf(entries[0].target))
check(
  'a child target carries its parent path',
  entries[0] !== undefined && pathOf(entries[0].target) === CONTAINER_PATH + '/child',
  entries[0] === undefined ? '' : pathOf(entries[0].target),
)

console.log('\n-- a second machine is a different channel entirely --')
other.calls.length = 0
container.calls.length = 0
const second = await fs.resolve(MOUNT_ROOT + '/' + HOST_B + '/srv/app/x.go')
check('resolves on the second machine', worldOf(second) === HOST_B + '/host', worldOf(second))
check('at its own path', pathOf(second) === '/srv/app/x.go', pathOf(second))
await fs.stat(second)
check('the request went to the SECOND machine', other.last()?.op === 'stat')
check('and never to the first machine\'s container channel', container.calls.length === 0, JSON.stringify(container.calls))
const secondSpec = shell.resolve({ command: 'echo hi', workdir: MOUNT_ROOT + '/' + HOST_B + '/srv/app' })
check('the shell follows it too', secondSpec.workdir === '/srv/app', secondSpec.workdir)

console.log('\n-- a plain local path is untouched --')
host.calls.length = 0
container.calls.length = 0
const local = await fs.resolve('/tmp/ordinary.txt')
// Not an exact path: macOS realpaths /tmp to /private/tmp, which is the shipped backend
// doing its job. What matters is that no world tag was attached.
check('a local resolve is not world-tagged', !String(local.targetKey).includes(KEY_SEP), String(local.targetKey))
check('and it still names a real local path', String(local.targetKey).endsWith('/ordinary.txt'), String(local.targetKey))
check('and asked no remote channel', host.calls.length === 0 && container.calls.length === 0)

console.log('\n-- the shell follows the same decision --')
host.calls.length = 0
container.calls.length = 0
const containerSpec = shell.resolve({ command: 'echo hi', workdir: MOUNT_ROOT + '/' + HOST_A + HOST_FOLDER })
check('a container-world workdir is rewritten to the container path', containerSpec.workdir === CONTAINER_PATH, containerSpec.workdir)
const hostSpec = shell.resolve({ command: 'echo hi', workdir: MOUNT_ROOT + '/' + HOST_A + '/volume1/docker/redis' })
check('a host-world workdir is rewritten to the host path', hostSpec.workdir === '/volume1/docker/redis', hostSpec.workdir)
const localSpec = shell.resolve({ command: 'echo hi', workdir: '/tmp' })
check('a local workdir is left alone', localSpec.workdir === '/tmp', localSpec.workdir)

container.calls.length = 0
const run = await shell.run(containerSpec)
check('the container spec ran on the container channel', container.last()?.cmd === 'echo hi')
check('and reported its exit code', run.exitCode === undefined || run.exitCode !== null, JSON.stringify(run.stdout))

console.log('\n-- search follows the same decision --')
// `glob`/`grep` do not go through ctx.fs or ctx.shell, so this is the only place that proves
// they dispatch on the world. They used to treat everything that was not `container` as
// local, which sent a host-world folder to local ripgrep against the empty stand-in.
// Local ripgrep must run for the local world and for nothing else, so the fake both
// records a local spawn and refuses to be one when a remote world asked.
const localRuns = []
const searchCtx = {
  subprocess: {
    spawn(spec) {
      localRuns.push(spec)
      return {
        done: Promise.resolve({ exitCode: 0 }),
        collected: {
          stdout: { readFrom: () => ({ text: '/tmp/a.go\n' }) },
          stderr: { readFrom: () => ({ text: '' }) },
        },
      }
    },
  },
  tools: { register(definition) { registered[definition.name] = definition } },
}
const registered = {}
registerRoutingSearch(searchCtx, (target) => recorders[`${target.host}|${target.world}`], worlds)
const exec = { agent: { session: { header: { cwd: '/tmp' } } } }

host.calls.length = 0
container.calls.length = 0
await registered.glob.execute({ pattern: '**/*.go', path: MOUNT_ROOT + '/' + HOST_A + '/volume1/docker/redis' }, exec)
check('a host-world glob asks the host channel', host.last()?.op === 'glob', JSON.stringify(host.last()))
check('and not the container channel', container.calls.length === 0, String(container.calls.length))
check('with the host path', host.last()?.cwd === '/volume1/docker/redis', String(host.last()?.cwd))

host.calls.length = 0
container.calls.length = 0
await registered.grep.execute({ pattern: 'func main', path: MOUNT_ROOT + '/' + HOST_A + HOST_FOLDER }, exec)
check('a container-world grep asks the container channel', container.last()?.op === 'grep', JSON.stringify(container.last()))
check('and not the host channel', host.calls.length === 0, String(host.calls.length))

localRuns.length = 0
host.calls.length = 0
container.calls.length = 0
const localGlob = await registered.glob.execute({ pattern: '**/*.go', path: '/tmp' }, exec)
check('a local-world glob runs local ripgrep', localRuns.length === 1, String(localRuns.length))
check('and asks no remote channel', host.calls.length === 0 && container.calls.length === 0)
check('and answers from it', localGlob.includes('/tmp/a.go'), localGlob)

console.log('\n-- a path no pass has decided yet (the resolution race) --')
// The defect this guards, reproduced end to end: a mirrored session's cwd was decided by a
// background pass, and that pass had not finished. `locate` answered the placeholder `host`,
// the tools acted on it, and `bash` ran on the NAS — right machine, wrong toolchain, wrong
// paths, and no error anywhere. Correctness must not depend on a pass having run first, so a
// router settles the path itself before it acts.
const probes = []
const HOST_FOLDER_2 = '/volume1/docker/other'
const CONTAINER_PATH_2 = '/workspaces/other'
const racedWorlds = new Worlds(
  { sshHost: HOST_A, containerRoot: CONTAINER_ROOT, mountRoot: MOUNT_ROOT },
  async ({ host, path }) => {
    probes.push(host + ':' + path)
    if (host === HOST_B) throw new Error('docker is not usable on ' + host)
    if (path === HOST_FOLDER || path.startsWith(HOST_FOLDER + '/')) {
      return { world: 'container', container: 'epic', folder: HOST_FOLDER, remotePath: CONTAINER_PATH }
    }
    if (path === HOST_FOLDER_2 || path.startsWith(HOST_FOLDER_2 + '/')) {
      return { world: 'container', container: 'other', folder: HOST_FOLDER_2, remotePath: CONTAINER_PATH_2 }
    }
    return { world: 'host', folder: path, remotePath: path }
  },
)
check(
  'nothing has decided the mirrored folder yet',
  racedWorlds.locate(MOUNT_ROOT + '/' + HOST_A + HOST_FOLDER + '/go.mod')?.provisional === true,
)

const raced = app.isolate('fs').isolate('shell')
raced.plugin(createRoutingFileSystem(channels, racedWorlds))
raced.plugin(createRoutingShellExecutor(channels, racedWorlds))
await settle(200)

host.calls.length = 0
container.calls.length = 0
probes.length = 0
const racedTarget = await raced.fs.resolve(MOUNT_ROOT + '/' + HOST_A + HOST_FOLDER + '/cmd/main.go')
check('a first touch decides the path itself', probes.length === 1, probes.join(','))
check('and resolves it into the CONTAINER, not the host', worldOf(racedTarget) === HOST_A + '/container', worldOf(racedTarget))
check('at the container path', pathOf(racedTarget) === CONTAINER_PATH + '/cmd/main.go', pathOf(racedTarget))
check('and the host channel was never asked', host.calls.length === 0, JSON.stringify(host.calls))
check('and a second path in the same folder costs no further probe', await (async () => {
  probes.length = 0
  await raced.fs.resolve(MOUNT_ROOT + '/' + HOST_A + HOST_FOLDER + '/cmd/other.go')
  return probes.length === 0
})(), probes.join(','))

// `ShellExecutor.resolve` is synchronous and cannot wait for a lookup, so it must NOT commit
// to the placeholder; the answer is taken on the asynchronous side. A folder nothing has
// touched yet is the only place that shows it.
const undecidedFolder = MOUNT_ROOT + '/' + HOST_A + HOST_FOLDER_2 + '/sub'
const racedSpec = raced.shell.resolve({ command: 'hostname', workdir: undecidedFolder })
check('an undecided shell spec keeps the local spelling — the remote path is not knowable yet', racedSpec.workdir === undecidedFolder, racedSpec.workdir)
check('and that folder is still undecided', racedWorlds.locate(undecidedFolder)?.provisional === true)
container.calls.length = 0
host.calls.length = 0
const racedRun = await raced.shell.run(racedSpec)
check('the deferred spec still runs on the container channel', container.last()?.op === 'exec', JSON.stringify(container.last()))
check('with the container workdir', container.last()?.cwd === CONTAINER_PATH_2 + '/sub', String(container.last()?.cwd))
check('and never on the host', host.calls.length === 0, JSON.stringify(host.calls))
check('reporting the command result', racedRun.exitCode === 0 && racedRun.stdout.text.includes('ran hostname'), JSON.stringify(racedRun.stdout))

// Once decided, `resolve` commits synchronously again — the deferral is only for the unknown.
const settledSpec = raced.shell.resolve({ command: 'pwd', workdir: MOUNT_ROOT + '/' + HOST_A + HOST_FOLDER })
check('a decided folder is rewritten synchronously', settledSpec.workdir === CONTAINER_PATH, settledSpec.workdir)

// The background path takes the same deferred route, and its handle must still come back
// synchronously — the request is issued inside the chain.
container.calls.length = 0
host.calls.length = 0
const racedProc = raced.shell.start(raced.shell.resolve({
  command: 'echo bg',
  workdir: MOUNT_ROOT + '/' + HOST_A + HOST_FOLDER_2 + '/bg',
}))
check('the background handle is returned before the request is issued', racedProc.status === 'running', racedProc.status)
await racedProc.done
check('and the background exec found the container channel', container.last()?.op === 'exec_start', JSON.stringify(container.last()))
check('with the container workdir', container.last()?.cwd === CONTAINER_PATH_2 + '/bg', String(container.last()?.cwd))
check('and never the host channel', host.calls.length === 0, JSON.stringify(host.calls))
check('streaming what it produced', racedProc.readOutput().delta.includes('bg'), JSON.stringify(racedProc.readOutput().delta))
check('and settling as completed', racedProc.status === 'completed', racedProc.status)

// The container's own spelling has to resolve back — it is derived from the decision.
const backAgain = await raced.fs.resolve(CONTAINER_PATH + '/go.mod')
check('a container path resolves back into the container world', worldOf(backAgain) === HOST_A + '/container', worldOf(backAgain))

// A lookup that FAILS must not become "the host either".
host.calls.length = 0
container.calls.length = 0
let racedRefusal = ''
try {
  await raced.fs.resolve(MOUNT_ROOT + '/' + HOST_B + '/srv/app/x.go')
} catch (error) {
  racedRefusal = String(error.code ?? '') + ' ' + String(error.message)
}
check('an undecidable path is REFUSED, not run on the host', racedRefusal.includes('FS_IO_ERROR'), racedRefusal)
check('naming the reason', racedRefusal.includes('not usable'), racedRefusal)
check('and no channel was asked to act on it', host.calls.length === 0 && container.calls.length === 0)

const refusedRun = await raced.shell.run(raced.shell.resolve({ command: 'pwd', workdir: MOUNT_ROOT + '/' + HOST_B + '/srv/app' }))
check('the shell reports the same refusal instead of running', refusedRun.exitCode === null && refusedRun.stderr.text.includes('not usable'), JSON.stringify(refusedRun.stderr.text))

// search follows the same rule: a placeholder must not answer "no matches" about a tree
// nobody looked at. These two tool definitions belong to the RACED resolver, not the one the
// earlier section registered.
const racedRegistered = {}
registerRoutingSearch(
  { subprocess: searchCtx.subprocess, tools: { register(definition) { racedRegistered[definition.name] = definition } } },
  (target) => recorders[`${target.host}|${target.world}`],
  racedWorlds,
)
container.calls.length = 0
host.calls.length = 0
localRuns.length = 0
await racedRegistered.glob.execute({ pattern: '**/*.go', path: MOUNT_ROOT + '/' + HOST_A + HOST_FOLDER + '/cmd' }, exec)
check('a glob through a placeholder searches the container', container.last()?.op === 'glob', JSON.stringify(container.last()))
check('not local ripgrep against the empty stand-in', localRuns.length === 0, String(localRuns.length))
host.calls.length = 0
container.calls.length = 0
const refusedGlob = await racedRegistered.glob.execute({ pattern: '**/*.go', path: MOUNT_ROOT + '/' + HOST_B + '/srv/app' }, exec)
check('an undecidable glob says so instead of "no matches"', refusedGlob.includes('not usable'), refusedGlob)
check('and still asked no channel', host.calls.length === 0 && container.calls.length === 0)
const refusedGrep = await racedRegistered.grep.execute({ pattern: 'func main', path: MOUNT_ROOT + '/' + HOST_B + '/srv/app' }, exec)
check('grep says so too', refusedGrep.includes('not usable'), refusedGrep)

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'))
process.exit(failures === 0 ? 0 : 1)

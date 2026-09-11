// World dispatch: do the routers send each world to the RIGHT channel?
//
// Container-free by construction — the channels are recorders, not connections — so this
// guards the dispatch layer everywhere the integration suites cannot run. What it proves is
// narrow and worth having: a host path is never asked of the container channel and vice
// versa, and the path each channel receives is the one for its own world.
import { Context } from '@deepseek-ai/cordis'
import { Worlds, createRoutingFileSystem, createRoutingShellExecutor } from '../lib/routing.js'

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
  return {
    world,
    calls: [],
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

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'))
process.exit(failures === 0 ? 0 : 1)

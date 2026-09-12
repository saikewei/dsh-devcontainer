// Unit test for the picker's listing pass. It runs locally through `sh`, so it needs no
// remote machine and no Node on one — which is the point: the picker must work on a host
// whose only requirement is sshd.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildListCommand, registerContainerApi } from '../lib/browse.js'

let failures = 0
const check = (label, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
  if (!ok) failures++
}
const run = (path) => {
  try {
    return { code: 0, out: execFileSync('/bin/sh', ['-c', buildListCommand(path)], { encoding: 'utf8' }) }
  } catch (error) {
    return { code: error.status, out: String(error.stdout ?? '') }
  }
}

const root = mkdtempSync(join(tmpdir(), 'dsh-browse-'))
try {
  mkdirSync(join(root, 'plain'))
  mkdirSync(join(root, 'project'))
  mkdirSync(join(root, 'project', '.devcontainer'))
  mkdirSync(join(root, '.hidden'))
  mkdirSync(join(root, '.hidden', '.devcontainer'))
  writeFileSync(join(root, 'a-file.txt'), 'not a directory\n')

  console.log('-- one level, one call --')
  const listed = run(root)
  const lines = listed.out.split('\n').map((l) => l.trim()).filter(Boolean)
  console.log('  raw:', JSON.stringify(lines))
  check('directories are reported, files are not', lines.includes('Fplain') && lines.includes('Dproject') && !lines.some((l) => l.includes('a-file')), JSON.stringify(lines))
  check('a folder carrying .devcontainer is marked D', lines.includes('Dproject'))
  check('a folder without one is marked F', lines.includes('Fplain'))
  check('hidden directories are skipped', !lines.some((l) => l.includes('hidden')))
  check('the level itself is reported when it has a .devcontainer', !lines.includes('S'))

  console.log('\n-- the level itself --')
  const self = run(join(root, 'project')).out.split('\n').map((l) => l.trim()).filter(Boolean)
  check('a project root reports S', self.includes('S'), JSON.stringify(self))
  check('and its empty child list', self.length === 1, JSON.stringify(self))

  console.log('\n-- a path that is not a directory --')
  const missing = run(join(root, 'nope'))
  check('a missing path exits 3 rather than listing nothing', missing.code === 3, String(missing.code))
  const file = run(join(root, 'a-file.txt'))
  check('a file exits 3 too', file.code === 3, String(file.code))

  console.log('\n-- quoting --')
  const odd = mkdtempSync(join(tmpdir(), "dsh-browse-'quoted-"))
  try {
    mkdirSync(join(odd, 'sub'))
    const out = run(odd).out
    check("a path containing a single quote is listed", out.includes('Fsub'), JSON.stringify(out))
  } finally {
    rmSync(odd, { recursive: true, force: true })
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('\n-- the host a request names is checked against the roster --')
// The HTTP routes are reachable from the page, and the `host` they accept becomes both an
// argv element for `ssh` (where a leading `-` is parsed as an OPTION, e.g. -oProxyCommand)
// and a path segment under the mirror (where `..` walks out, and the result is mkdir'd).
// Neither string is an ssh alias. This is container-free: the transport is a recorder.
let handler
const apiCtx = {
  get: (key) => (key === 'webServer' ? { register: (route) => { handler = route.handler; return () => {} } } : undefined),
  effect: () => {},
}
const seen = []
const deps = {
  forTarget: () => ({}),
  transportFor: (host) => ({ collect: async () => { seen.push(host); return { exitCode: 0, stdout: 'S\n', stderr: '' } } }),
  containersFor: () => ({ resolve: async () => ({ usable: false }) }),
  worlds: { locate: () => undefined, toMountRootPath: (host, p) => join(root, 'mirror', host, p) },
  cfg: {
    sshHost: 'my-nas', container: '', containerRoot: '/', hostRoot: '',
    mountRoot: join(root, 'mirror'), browseRoot: '/',
    sshConfigPath: join(root, 'no-such-ssh-config'), extraHosts: ['other-nas'],
  },
}
registerContainerApi(apiCtx, deps)

/** One GET /list, returning the status, the body, and whether ssh was reached at all. */
const listAs = async (host) => {
  seen.length = 0
  let status = null
  let body = ''
  const res = {
    writeHead: (code) => { status = code },
    end: (text) => { body = String(text ?? '') },
    setHeader: () => {},
  }
  const url = new URL('http://x/dsh-devcontainer/list?path=/&host=' + encodeURIComponent(host))
  await handler({ method: 'GET', url }, res)
  return { status, body, ssh: [...seen] }
}

const legitimate = await listAs('my-nas')
check('a host on the roster is accepted', legitimate.status === 200, String(legitimate.status))
check('and reaches ssh', legitimate.ssh.length === 1, JSON.stringify(legitimate.ssh))

const configured = await listAs('other-nas')
check('an extraHosts entry is accepted too', configured.status === 200, String(configured.status))

for (const [label, value] of [
  ['an ssh option masquerading as a host', '-oProxyCommand=touch /tmp/PWNED'],
  ['a path traversal in the host segment', '../../../../tmp/escape'],
  ['a host nobody offered', 'somewhere-else'],
]) {
  const attempt = await listAs(value)
  check(label + ' is refused', attempt.status === 400, String(attempt.status))
  check('  and never reaches ssh', attempt.ssh.length === 0, JSON.stringify(attempt.ssh))
}

console.log('\n-- a listing that could not run is not an empty directory --')
// ssh failed: unreachable machine, rejected key, no route. Rendering that as an empty listing
// told the operator "nothing here" about a machine the picker never reached, so a failure read
// as an answer. exit 3 stays a 404 — that one IS an answer ("no such directory").
const unreachable = { exitCode: 255, stdout: '', stderr: 'ssh: connect to host my-nas port 22: Operation timed out' }
registerContainerApi(apiCtx, {
  ...deps,
  transportFor: () => ({ collect: async () => unreachable }),
})
const failed = await listAs('my-nas')
check('a failed ssh is reported as a failure', failed.status === 502, String(failed.status))
check('with what ssh said', failed.body.includes('Operation timed out'), failed.body)
check('and NOT as an empty listing', failed.body.includes('error') && !failed.body.includes('"entries"'), failed.body)

const quietFailure = { exitCode: 255, stdout: '', stderr: '   ' }
registerContainerApi(apiCtx, { ...deps, transportFor: () => ({ collect: async () => quietFailure }) })
const quiet = await listAs('my-nas')
check('an ssh failure with no stderr still says something', quiet.status === 502 && quiet.body.includes('exit 255'), quiet.body)

const noExit = { exitCode: null, stdout: '', stderr: 'no sshHost configured' }
registerContainerApi(apiCtx, { ...deps, transportFor: () => ({ collect: async () => noExit }) })
const never = await listAs('my-nas')
check('a command that never ran is reported too', never.status === 502 && never.body.includes('no sshHost configured'), never.body)

registerContainerApi(apiCtx, { ...deps, transportFor: () => ({ collect: async () => ({ exitCode: 3, stdout: '', stderr: '' }) }) })
const absent = await listAs('my-nas')
check('exit 3 stays "no such directory"', absent.status === 404, String(absent.status))

registerContainerApi(apiCtx, deps)
const healthy = await listAs('my-nas')
check('and a working listing is still a listing', healthy.status === 200, String(healthy.status))

console.log('\n-- the ports routes --')
// These live in the SAME prefix handler as the picker, because `webServer.register` throws on a
// duplicate (kind, path) and the precedence of an `exact` route over this `prefix` one is not a
// documented guarantee. So the dispatch on method is what has to be right.
const portCalls = []
const fakeForwards = {
  bind: '127.0.0.1',
  list: () => [{ container: 'epic', remotePort: 8000, localPort: 8000, auto: false, connections: 2, url: 'http://127.0.0.1:8000', localAddress: '127.0.0.1:8000', substituted: false }],
  listening: async () => ({ ok: true, source: 'ss', ports: [{ port: 8000, address: '127.0.0.1', process: 'uvicorn', internal: false, loopback: true }] }),
  add: async (request) => { portCalls.push(request); return { ok: true, forward: { container: 'epic', remotePort: request.port, localPort: request.localPort ?? request.port, substituted: false, auto: false, connections: 0, url: 'http://127.0.0.1:' + String(request.localPort ?? request.port), localAddress: '', } } },
  // Synchronous, like the real `Forwards.remove`: the route reads `.ok` off the result without
  // awaiting, so an async fake here would hide a contract change instead of catching it.
  remove: (request) => { portCalls.push(request); return { ok: true, stopped: { container: 'epic', remotePort: request.port, localPort: request.port } } },
}
registerContainerApi(apiCtx, { ...deps, forwards: fakeForwards, cfg: { ...deps.cfg, container: 'epic' } })

/** One request against the shared prefix handler, returning status and parsed body. */
const call = async (method, route, payload) => {
  let status = null
  let body = ''
  const res = { writeHead: (code) => { status = code }, end: (text) => { body = String(text ?? '') }, setHeader: () => {} }
  const req = { method, url: 'http://x/dsh-devcontainer' + route, async *[Symbol.asyncIterator]() {
    if (payload !== undefined) yield Buffer.from(JSON.stringify(payload))
  } }
  await handler(req, res)
  let parsed
  try { parsed = JSON.parse(body) } catch { parsed = body }
  return { status, body: parsed }
}

const listed = await call('GET', '/ports')
check('GET /ports answers', listed.status === 200, String(listed.status))
check('with the live forwards', listed.body.forwards?.[0]?.remotePort === 8000, JSON.stringify(listed.body))
check('and what the container is listening on', listed.body.listening?.[0]?.process === 'uvicorn', JSON.stringify(listed.body.listening))
check('naming the bind address it would use', listed.body.bind === '127.0.0.1', String(listed.body.bind))
check('and no probe error when the probe ran', listed.body.listeningError === undefined, String(listed.body.listeningError))

const added = await call('POST', '/ports', { port: 5173 })
check('POST /ports starts a forward', added.status === 200 && added.body.forward?.remotePort === 5173, JSON.stringify(added.body))
check('and the request reached the forwards layer', portCalls.some((c) => c.port === 5173), JSON.stringify(portCalls))

const removed = await call('DELETE', '/ports', { port: 5173 })
check('DELETE /ports stops one', removed.status === 200 && removed.body.stopped?.remotePort === 5173, JSON.stringify(removed.body))

check('an unsupported method is refused', (await call('PUT', '/ports')).status === 405)
check('and the picker routes still answer', (await call('GET', '/config')).status === 200)

// A probe that failed must not be drawn as "nothing is listening": that is the same wrong
// answer this codebase already fixed once for directory listings.
registerContainerApi(apiCtx, { ...deps, forwards: { ...fakeForwards, listening: async () => ({ ok: false, error: 'channel is not connected' }) }, cfg: { ...deps.cfg, container: 'epic' } })
const probeFailed = await call('GET', '/ports')
check('a failed probe is reported as one', probeFailed.status === 200 && probeFailed.body.listeningError === 'channel is not connected', JSON.stringify(probeFailed.body))
check('and the list is empty rather than invented', Array.isArray(probeFailed.body.listening) && probeFailed.body.listening.length === 0)

// A profile that mounted the package without a container: say that, rather than answering an
// empty list the panel would draw as "nothing is forwarding".
registerContainerApi(apiCtx, deps)
const unmounted = await call('GET', '/ports')
check('no forwards layer at all is a 503, not an empty answer', unmounted.status === 503, String(unmounted.status))
check('saying what is missing', String(unmounted.body.error).includes('container'), String(unmounted.body.error))

registerContainerApi(apiCtx, deps)

console.log('\n-- the container-file route --')
// The "Files changed" row records the `file_path` the model passed to write/edit, which for a
// routed session is a CONTAINER path. Every shipped surface that opens one goes through
// `ctx.fs` — this plugin's empty local stand-in — so without this route the chips resolve
// nowhere. The route is the one place that path can be turned back into content.
const CONTAINER_ROOT = '/workspaces/ShutterSeek'
const FILE_TEXT = 'package main\n'
const fileCalls = []
const fileChannel = {
  request: async (frame) => {
    fileCalls.push(frame)
    if (frame.op === 'stat') {
      if (frame.path.endsWith('/missing.go')) return { ok: true, exists: false }
      if (frame.path.endsWith('/big.log') || frame.path.endsWith('/big.bin')) {
        return { ok: true, exists: true, type: 'file', size: 5 * 1024 * 1024 }
      }
      return { ok: true, exists: true, type: 'file', size: FILE_TEXT.length }
    }
    if (frame.op === 'read') {
      if (frame.path.endsWith('/binary.bin')) throw new Error('refusing to read a binary file')
      return { ok: true, text: FILE_TEXT, bytes: FILE_TEXT.length }
    }
    if (frame.op === 'read_b64') {
      // An oversized binary: the windowed path has no binary guard of its own, so the route
      // has to apply one — this fixture is the ELF-file case that reached a browser as mojibake.
      const bytes = frame.path.endsWith('/big.bin')
        ? Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x02, 0x01, 0x01])
        : Buffer.from(FILE_TEXT)
      return {
        ok: true,
        base64: bytes.toString('base64'),
        bytes: bytes.length,
        total: 5 * 1024 * 1024,
      }
    }
    throw new Error('unexpected op: ' + String(frame.op))
  },
}
// Only container spellings resolve. Everything else is an ordinary local path, which this
// route deliberately does not serve: the local filesystem is what the caller already reads.
const fileWorlds = {
  locate: (path) => {
    if (path === CONTAINER_ROOT || path.startsWith(CONTAINER_ROOT + '/')) {
      return { host: 'my-nas', world: 'container', container: 'epic', path }
    }
    if (path.startsWith('/volume1/')) return { host: 'my-nas', world: 'host', path }
    return undefined
  },
  toMountRootPath: () => undefined,
  knownRoots: [{ host: 'my-nas', path: CONTAINER_ROOT }],
}
const fileDeps = {
  ...deps,
  worlds: fileWorlds,
  forTarget: () => fileChannel,
  cfg: { ...deps.cfg, container: 'epic', containerRoot: CONTAINER_ROOT },
}
registerContainerApi(apiCtx, fileDeps)
const fileAs = (path) => call('GET', '/file?path=' + encodeURIComponent(path))

const served = await fileAs(CONTAINER_ROOT + '/internal/service/cache.go')
check('a container path is served', served.status === 200, JSON.stringify(served.body))
check('with the file text', served.body.text === FILE_TEXT, JSON.stringify(served.body.text))
check('and the container path it read', served.body.remotePath === CONTAINER_ROOT + '/internal/service/cache.go', String(served.body.remotePath))
check('not truncated', served.body.truncated === false, String(served.body.truncated))

const localPath = await fileAs('/Users/saikewei/code_proj/thing.go')
check('a local path is refused rather than read from this machine', localPath.status === 400, String(localPath.status))
const relative = await fileAs('internal/service/cache.go')
check('a relative path is refused', relative.status === 400, String(relative.status))
const traversal = await fileAs(CONTAINER_ROOT + '/../../etc/passwd')
check('a traversal that leaves the root is refused', traversal.status === 400, String(traversal.status))
check('and none of the refusals reached the channel', fileCalls.every((c) => c.path.startsWith(CONTAINER_ROOT)), JSON.stringify(fileCalls.map((c) => c.path)))

const onHost = await fileAs('/volume1/docker/ShutterSeek/main.go')
check('a path that resolves to the machine itself is refused', onHost.status === 400, String(onHost.status))
check('saying which machine it belongs to', String(onHost.body.error).includes('my-nas'), String(onHost.body.error))

const absentFile = await fileAs(CONTAINER_ROOT + '/missing.go')
check('a file that is not there is a 404', absentFile.status === 404, String(absentFile.status))
check('and is not read', !fileCalls.some((c) => c.op === 'read' && c.path.endsWith('/missing.go')))

const binaryFile = await fileAs(CONTAINER_ROOT + '/binary.bin')
check('a binary file is a 415, not a 502', binaryFile.status === 415, String(binaryFile.status))
check('and says why', String(binaryFile.body.error).includes('not text'), String(binaryFile.body.error))

const bigFile = await fileAs(CONTAINER_ROOT + '/big.log')
check('an oversized file is still served', bigFile.status === 200, String(bigFile.status))
check('marked truncated', bigFile.body.truncated === true, String(bigFile.body.truncated))
check('reporting the ORIGINAL size', bigFile.body.bytes === 5 * 1024 * 1024, String(bigFile.body.bytes))
const BIG_SIZE = 5 * 1024 * 1024
const bigWindow = fileCalls.filter((c) => c.op === 'read_b64').at(-1)
check(
  'and read as a bounded window, not whole',
  bigWindow !== undefined && bigWindow.length > 0 && bigWindow.length < BIG_SIZE,
  JSON.stringify(bigWindow),
)
check('from the head of the file', bigWindow?.offset === 0, JSON.stringify(bigWindow))
check('and the window is what is served', bigFile.body.text === FILE_TEXT, JSON.stringify(bigFile.body.text))

// The helper refuses a binary only on the whole-file read. The windowed path has no such guard,
// so an oversized executable used to come back as a 200 and a screenful of mojibake — verified
// against the real container, where the 48 MB `server` binary did exactly that.
const bigBinary = await fileAs(CONTAINER_ROOT + '/big.bin')
check('an oversized BINARY is still refused', bigBinary.status === 415, String(bigBinary.status))
check('and carries no text at all', bigBinary.body.text === undefined, JSON.stringify(bigBinary.body).slice(0, 120))

const deadChannel = { request: async () => { throw new Error('ssh: connect to host my-nas port 22: Operation timed out') } }
registerContainerApi(apiCtx, { ...fileDeps, forTarget: () => deadChannel })
const broken = await fileAs(CONTAINER_ROOT + '/main.go')
check('a channel that cannot answer is a 502, not an empty file', broken.status === 502, String(broken.status))
check('with what went wrong', String(broken.body.error).includes('Operation timed out'), String(broken.body.error))

registerContainerApi(apiCtx, fileDeps)
const noChannel = await fileAs(CONTAINER_ROOT + '/main.go')
check('and a profile with no channel for the host says so', noChannel.status === 200, String(noChannel.status))
registerContainerApi(apiCtx, { ...fileDeps, forTarget: () => undefined })
const detached = await fileAs(CONTAINER_ROOT + '/main.go')
check('a host with no channel at all is a 502', detached.status === 502, String(detached.status))

// The browser half decides synchronously whether an address is a container file, so the host
// publishes the roots it routes. The two must agree, or a chip would open a tab that 400s.
const config = await call('GET', '/config')
check('the config names the roots this profile routes', Array.isArray(config.body.knownRoots), JSON.stringify(config.body.knownRoots))
check('and the container root is one of them', config.body.knownRoots?.some((r) => r.path === CONTAINER_ROOT), JSON.stringify(config.body.knownRoots))
check('with the machine that serves it', config.body.knownRoots?.some((r) => r.host === 'my-nas'), JSON.stringify(config.body.knownRoots))

registerContainerApi(apiCtx, deps)

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'))
process.exit(failures === 0 ? 0 : 1)

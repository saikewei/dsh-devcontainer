// Pre-install smoke test: drive the SHIPPED plugin code (lib/index.js) against the real
// container using a stand-in for the `ctx.subprocess` seam. This validates the code that
// will be installed into the profile, without touching the profile at all.
import { spawn as nodeSpawn } from 'node:child_process'
import { get as httpGet } from 'node:http'
import { apply, name, inject } from '../lib/index.js'
import { CONFIG, requireTarget } from './config.mjs'

requireTarget('sshHost', 'container', 'containerRoot')

/** Minimal stand-in honouring the SubprocessRuntime contract the plugin relies on. */
function fakeSubprocess() {
  return {
    spawn(spec) {
      const [file, ...args] = spec.argv
      const stdinMode = spec.stdio.stdin
      const piped = stdinMode === 'pipe'
      const child = nodeSpawn(file, args, {
        cwd: spec.cwd,
        env: spec.env ?? process.env,
        stdio: [piped ? 'pipe' : 'pipe', 'pipe', 'pipe'],
      })
      if (stdinMode === 'ignore') child.stdin.end()
      if (stdinMode && typeof stdinMode === 'object' && typeof stdinMode.data === 'string') {
        child.stdin.end(stdinMode.data)
      }

      const outChunks = []
      const errChunks = []
      child.stdout.on('data', (chunk) => outChunks.push(chunk))
      child.stderr.on('data', (chunk) => errChunks.push(chunk))

      const reader = (chunks) => ({
        readFrom(fromByte) {
          const all = Buffer.concat(chunks)
          return {
            text: all.subarray(fromByte).toString('utf8'),
            nextOffset: all.length,
            lossy: false,
          }
        },
      })

      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        collected: { stdout: reader(outChunks), stderr: reader(errChunks) },
        done: new Promise((resolve) => {
          child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
        }),
        terminate() {
          child.kill('SIGTERM')
          setTimeout(() => child.kill('SIGKILL'), 500)
        },
        waitForExit() {
          return Promise.resolve(true)
        },
      }
    },
  }
}

const registry = new Map()
const disposers = []
const ctx = {
  // `get` models "no optional service available": a real Cordis context always has it, and
  // the plugin's optional lookups (webServer, workspaceRegistry) must tolerate absence.
  get: () => undefined,
  // Routing arms a workspace-world refresh timer through ctx.inject; a fake context has to
  // carry it, or the plugin's mount fails here rather than doing its job.
  inject: () => undefined,
  on: () => () => {},
  effect: (fn) => { const disposer = typeof fn === 'function' ? fn() : undefined; return typeof disposer === 'function' ? disposer : () => {} },
  subprocess: fakeSubprocess(),
  tools: { register: (definition) => { registry.set(definition.name, definition); return () => {} } },
  effect: (callback) => {
    const disposer = callback()
    // A contribution that had nothing to register returns undefined, which the real
    // Cordis effect tolerates; the fake has to as well.
    if (typeof disposer === 'function') disposers.push(disposer)
    return () => {}
  },
  logger: { info: () => {}, warn: (...a) => console.log('[warn]', ...a) },
}

apply(ctx, CONFIG)

const expected = ['devc_status', 'devc_exec', 'devc_read', 'devc_write', 'devc_edit', 'devc_ls', 'devc_grep', 'devc_glob']
console.log('plugin name  :', name, '| inject:', JSON.stringify(inject))
console.log('registered   :', [...registry.keys()].join(', '))
const missing = expected.filter((tool) => !registry.has(tool))
if (missing.length) {
  console.log('MISSING TOOLS:', missing.join(', '))
  process.exit(1)
}

const run = async (tool, args) => {
  const started = Date.now()
  const value = await registry.get(tool).execute(args, { signal: undefined })
  const ms = Date.now() - started
  const text = String(value)
  console.log(`\n=== ${tool}  (${ms} ms) ===`)
  console.log(text.split('\n').slice(0, 12).join('\n') + (text.split('\n').length > 12 ? '\n  …' : ''))
  return { value, ms }
}

let failures = 0
const check = (label, ok) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label)
  if (!ok) failures++
}

// --- 1. status: proves the channel connects and lands inside the container -----------------
const status = await run('devc_status', {})
check('status reports the container, not the NAS host', String(status.value).includes('in_container=yes'))
check('status reports a container hostname', /[0-9a-f]{12}/.test(String(status.value)))

// --- 2. exec: a real command in the container's own toolchain ------------------------------
const exec = await run('devc_exec', { command: 'echo "cwd=$(pwd)"; go version; node -v', workdir: CONFIG.containerRoot })
check('exec runs in the container workdir', String(exec.value).includes('cwd=' + CONFIG.containerRoot))
check('exec sees the container Go toolchain', /go1\.\d+/.test(String(exec.value)))
check('second call reuses the resident channel (fast)', exec.ms < 2000)

// --- 3. read / ls ---------------------------------------------------------------------------
const read = await run('devc_read', { path: CONFIG.containerRoot + '/go.mod', limit: 4 })
check('read returns line-numbered content', /^\s*1\s+module \S+/m.test(String(read.value)))
const ls = await run('devc_ls', { path: CONFIG.containerRoot })
check('ls lists project entries', String(ls.value).includes('go.mod'))

// --- 4. write -> edit -> read round trip in a scratch path ---------------------------------
const scratch = '/tmp/dsh-devcontainer-smoke/note.txt'
await run('devc_write', { path: scratch, content: 'alpha\nbeta\ngamma\n' })
const edited = await run('devc_edit', { path: scratch, old_string: 'beta', new_string: 'BETA' })
check('edit reports one replacement', String(edited.value).includes('1 replacement'))
const reread = await run('devc_read', { path: scratch })
check('write+edit round trip persisted', String(reread.value).includes('BETA'))

// --- 5. edit guard: ambiguous match must be refused ----------------------------------------
const ambiguous = await run('devc_edit', { path: scratch, old_string: 'a', new_string: 'z' })
check('ambiguous edit is refused', String(ambiguous.value).includes('appears'))

// --- 6. glob / grep ------------------------------------------------------------------------
const glob = await run('devc_glob', { pattern: 'cmd/**/*.go', workdir: CONFIG.containerRoot })
check('glob finds Go entrypoints', String(glob.value).includes('cmd/server/main.go'))
const grep = await run('devc_grep', { pattern: 'func main', path: CONFIG.containerRoot + '/cmd', include: '*.go' })
check('grep returns file:line matches', /cmd\/server\/main\.go:\d+:/.test(String(grep.value)))

// --- 7. error surfacing: a missing file must not throw -------------------------------------
const bad = await run('devc_read', { path: '/tmp/dsh-devcontainer-smoke/does-not-exist' })
check('missing file surfaces an error string, not a throw', String(bad.value).includes('dsh-devcontainer error'))

// --- 8. port forwarding: a real byte round trip through a real container ---------------------
// This is the acceptance test for the feature. The container's own services bind 127.0.0.1,
// which nothing outside the container can reach — so the assertion that matters is not "the
// tool returned ok", it is that a request made HERE arrives THERE and its answer comes back.
const PORTS = await run('devc_ports', {})
check('ports lists what the container is listening on', /listening in /.test(String(PORTS.value)), String(PORTS.value).slice(0, 200))

// A throwaway HTTP server INSIDE the container, bound to its loopback on purpose: that binding
// is the whole reason this feature cannot be `ssh -L`.
//
// Any server left by an earlier run is killed first. It would hold the port, ours would fail to
// bind in silence, and the OLD server would answer with the OLD marker — which is how this test
// first failed, reporting a working forward as broken.
const PORT = 7391
const DEAD_PORT = 7392
const MARKER = 'dsh-forward-' + String(Date.now())
// The probe is a FILE, written into the container and run by path. Inlining it as `node -e`
// meant three levels of quoting (JS -> bash -> node), and one missed escape silently produced a
// server that never started — which the test then reported as a broken forward.
//
// It binds 127.0.0.1 on purpose: that binding is the whole reason this feature cannot be
// `ssh -L`, and a probe on every interface would let a broken forward pass.
const PROBE_PATH = '/tmp/dsh-fwd-probe.js'
/**
 * Free a port by killing whatever holds it.
 *
 * Not `pkill -f <path>`: the shell running that command carries the same string in ITS command
 * line, so it matches itself and dies before it does anything — and the bracket trick only works
 * while the pattern does not also appear literally, which it does as soon as the same command
 * starts the probe. Reading the owner out of `ss` cannot match anything but the real holder.
 */
const freePort = (port) => 'pid=$(ss -ltnp 2>/dev/null | grep ":' + String(port) + ' " | grep -o "pid=[0-9]*" | head -1 | cut -d= -f2);'
  + ' if [ -n "$pid" ]; then kill "$pid" 2>/dev/null; sleep 1; fi; '

await run('devc_write', {
  path: PROBE_PATH,
  content: [
    "const http = require('http')",
    "http.createServer((q, s) => s.end(" + JSON.stringify(MARKER) + ")).listen(" + String(PORT) + ", '127.0.0.1')",
  ].join('\n') + '\n',
})
const served = await run('devc_exec', {
  command: freePort(PORT)
    + 'nohup node ' + PROBE_PATH + ' >/dev/null 2>&1 & '
    + 'sleep 1; ss -ltn 2>/dev/null | grep -q ":' + String(PORT) + ' " && echo listening || echo missing',
})
check('a loopback-bound server is running in the container', String(served.value).includes('listening'), String(served.value))
// And that it is OURS. Without this, a server left by an earlier run holds the port, ours fails
// to bind in silence, and the round trip below looks correct while testing the wrong process.
const insideCheck = await run('devc_exec', {
  command: 'node -e "require(\'http\').get({host:\'127.0.0.1\',port:' + String(PORT) + ',path:\'/\'},(r)=>{let b=\'\';r.on(\'data\',c=>b+=c);r.on(\'end\',()=>console.log(b))})"',
})
check('and it is the one this run started', String(insideCheck.value).includes(MARKER), String(insideCheck.value).slice(-80))

const forwarded = await run('devc_forward', { port: PORT })
check('the forward reports a local URL', String(forwarded.value).includes('http://127.0.0.1:' + String(PORT)), String(forwarded.value))

/**
 * One HTTP GET from THIS machine, through the forward.
 *
 * `agent: false` matters: Node's global agent keeps connections alive, so a later request would
 * ride the socket an earlier one opened — and a test that closes a forward would still get an
 * answer from the connection it is not testing.
 */
const fetchLocal = (port, timeoutMs = 8000) => new Promise((resolve) => {
  const request = httpGet({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs, agent: false }, (res) => {
    let body = ''
    res.on('data', (chunk) => { body += chunk.toString('utf8') })
    res.on('end', () => resolve({ status: res.statusCode, body }))
  })
  request.on('timeout', () => { request.destroy(); resolve({ error: 'timed out' }) })
  request.on('error', (error) => resolve({ error: String(error.code ?? error.message) }))
})
const roundTrip = await fetchLocal(PORT)
console.log('  from this machine ->', JSON.stringify(roundTrip))
check('a request from THIS machine reached the container', roundTrip.status === 200, JSON.stringify(roundTrip))
check('and came back with the container\'s own answer', roundTrip.body === MARKER, JSON.stringify(roundTrip.body))

// Two at once: one relay per connection is what makes a browser's parallel requests work.
const both = await Promise.all([fetchLocal(PORT), fetchLocal(PORT)])
check('two connections at once both get through', both.every((one) => one.status === 200 && one.body === MARKER), JSON.stringify(both))

// A port nobody listens on must FAIL, not hang: the helper answers in-band and the relay ends.
const dead = await run('devc_forward', { port: DEAD_PORT })
check('a forward for a dead port still binds locally', String(dead.value).includes(String(DEAD_PORT)), String(dead.value))
const refused = await fetchLocal(DEAD_PORT, 6000)
console.log('  dead port ->', JSON.stringify(refused))
check('but connecting to it fails instead of hanging', refused.status === undefined, JSON.stringify(refused))

// --- 9. stopping gives the port back ---------------------------------------------------------
await run('devc_unforward', { port: PORT })
const afterStop = await fetchLocal(PORT, 3000)
check('the released port no longer answers', afterStop.error === 'ECONNREFUSED', JSON.stringify(afterStop))
await run('devc_unforward', { port: DEAD_PORT })
await run('devc_exec', { command: freePort(PORT) + 'rm -f ' + PROBE_PATH + '; echo done' })

// --- 10. cleanup path ------------------------------------------------------------------------
for (const disposer of disposers) disposer()
console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'))
process.exit(failures === 0 ? 0 : 1)

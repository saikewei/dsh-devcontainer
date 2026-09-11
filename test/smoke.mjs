// Pre-install smoke test: drive the SHIPPED plugin code (lib/index.js) against the real
// container using a stand-in for the `ctx.subprocess` seam. This validates the code that
// will be installed into the profile, without touching the profile at all.
import { spawn as nodeSpawn } from 'node:child_process'
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
  subprocess: fakeSubprocess(),
  tools: { register: (definition) => { registry.set(definition.name, definition); return () => {} } },
  effect: (callback) => { const disposer = callback(); disposers.push(disposer); return () => {} },
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
check('read returns line-numbered content', /^\s*1\s+module shutterseek/m.test(String(read.value)))
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

// --- 8. cleanup path ------------------------------------------------------------------------
for (const disposer of disposers) disposer()
console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'))
process.exit(failures === 0 ? 0 : 1)

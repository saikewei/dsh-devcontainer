// Registry test: register the SHIPPED definitions against a REAL Cordis app carrying the
// REAL @deepseek-ai/dsh-tools registry, then drive them against the real container.
//
// This is the check that matters before installing into a profile: it proves the tool
// definitions are accepted by the actual registry (JSON Schema shape, output contract)
// and that every tool works, not merely that the code parses.
import { spawn as nodeSpawn } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import * as dshTools from '@deepseek-ai/dsh-tools'
import { apply, name, inject } from '../lib/index.js'
import { CONFIG, requireTarget } from './config.mjs'

requireTarget('sshHost', 'container', 'containerRoot')

/** Stand-in honouring the SubprocessRuntime contract the plugin relies on. */
function fakeSubprocess() {
  return {
    spawn(spec) {
      const [file, ...args] = spec.argv
      const stdinMode = spec.stdio.stdin
      const child = nodeSpawn(file, args, { cwd: spec.cwd, env: spec.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] })
      if (stdinMode === 'ignore') child.stdin.end()
      if (stdinMode && typeof stdinMode === 'object' && typeof stdinMode.data === 'string') child.stdin.end(stdinMode.data)

      const outChunks = []
      const errChunks = []
      child.stdout.on('data', (c) => outChunks.push(c))
      child.stderr.on('data', (c) => errChunks.push(c))
      const reader = (chunks) => ({
        readFrom(fromByte) {
          const all = Buffer.concat(chunks)
          return { text: all.subarray(fromByte).toString('utf8'), nextOffset: all.length, lossy: false }
        },
      })
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        collected: { stdout: reader(outChunks), stderr: reader(errChunks) },
        done: new Promise((resolve) => child.on('close', (code, signal) => resolve({ exitCode: code, signal }))),
        terminate() { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 500) },
        waitForExit: () => Promise.resolve(true),
      }
    },
  }
}

/** A module's plugin is its default export (class or object) or the namespace itself. */
function pluginOf(mod) {
  const fallback = mod.default
  if (typeof fallback === 'function') return fallback
  if (fallback && typeof fallback === 'object' && typeof fallback.apply === 'function') return fallback
  if (typeof mod.apply === 'function') return mod
  throw new Error('no Cordis plugin found in module')
}

// --- bring up a real harness tool registry ------------------------------------------------
// ToolRuntime injects `systemPrompt`, so that registry has to be up before it can activate.
const app = new Context()
app.plugin(pluginOf(await import('@deepseek-ai/dsh-system-prompt')))
app.plugin(pluginOf(dshTools))
await new Promise((resolve) => setTimeout(resolve, 500))

if (app.tools === undefined) {
  console.log('FAIL: the dsh-tools plugin did not publish ctx.tools')
  process.exit(1)
}
console.log('real registry up; existing tools:', app.tools.schemas().length)

// --- register the shipped definitions through the real registry ---------------------------
const captured = new Map()
const realRegister = app.tools.register.bind(app.tools)
const ctx = {
  // See smoke.mjs: a real Cordis context always offers `get`; this stands in for "the
  // optional webServer is not mounted", which is the standalone case.
  get: () => undefined,
  // Routing arms a workspace-world refresh timer through ctx.inject; a fake context has to
  // carry it, or the plugin's mount fails here rather than doing its job.
  inject: () => undefined,
  on: () => () => {},
  effect: (fn) => { const disposer = typeof fn === 'function' ? fn() : undefined; return typeof disposer === 'function' ? disposer : () => {} },
  tools: {
    register(definition) {
      captured.set(definition.name, definition)
      return realRegister(definition)
    },
  },
  subprocess: fakeSubprocess(),
  effect: (callback) => { const disposer = callback(); return () => {} },
}

apply(ctx, CONFIG)
console.log('plugin registered:', name, '| inject:', JSON.stringify(inject))

const advertised = new Map(app.tools.schemas().map((schema) => [schema.name, schema]))
const expected = ['devc_status', 'devc_exec', 'devc_read', 'devc_write', 'devc_edit', 'devc_ls', 'devc_grep', 'devc_glob']

let failures = 0
const check = (label, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
  if (!ok) failures++
}

console.log('\n-- registry acceptance --')
for (const toolName of expected) {
  const schema = advertised.get(toolName)
  check(toolName + ' is advertised by the real registry', schema !== undefined)
  if (schema) {
    const ok = schema.parameters && schema.parameters.type === 'object' && typeof schema.description === 'string'
    check(toolName + ' carries a valid argument schema', Boolean(ok), JSON.stringify(schema.parameters))
  }
}
check('registry advertises exactly the 8 devc_* tools', expected.every((t) => advertised.has(t)) && expected.length === 8)

console.log('\n-- live execution through the registered definitions --')
const call = async (toolName, args) => {
  const started = Date.now()
  const value = await captured.get(toolName).execute(args, { signal: undefined })
  const ms = Date.now() - started
  const text = String(value)
  console.log(`\n=== ${toolName}  (${ms} ms) ===`)
  console.log(text.split('\n').slice(0, 10).join('\n') + (text.split('\n').length > 10 ? '\n  …' : ''))
  return { value: text, ms }
}

const status = await call('devc_status', {})
check('status lands inside the container', status.value.includes('in_container=yes'))

const exec = await call('devc_exec', { command: 'echo "cwd=$(pwd)"; go version', workdir: CONFIG.containerRoot })
check('exec runs in the container workdir', exec.value.includes('cwd=' + CONFIG.containerRoot))
check('exec sees the container toolchain', /go1\.\d+/.test(exec.value))
check('resident channel keeps calls fast', exec.ms < 2000, String(exec.ms) + ' ms')

const read = await call('devc_read', { path: CONFIG.containerRoot + '/go.mod', limit: 3 })
check('read returns line-numbered content', /^\s*1\s+module \S+/m.test(read.value))

const scratch = '/tmp/dsh-devcontainer-registry/note.txt'
await call('devc_write', { path: scratch, content: 'alpha\nbeta\n' })
const edited = await call('devc_edit', { path: scratch, old_string: 'beta', new_string: 'BETA' })
check('edit applies one replacement', edited.value.includes('1 replacement'))
const reread = await call('devc_read', { path: scratch })
check('write/edit round trip persisted', reread.value.includes('BETA'))

const ambiguous = await call('devc_edit', { path: scratch, old_string: 'a', new_string: 'z' })
check('ambiguous edit is refused, not thrown', ambiguous.value.includes('appears'))

const ls = await call('devc_ls', { path: CONFIG.containerRoot })
check('ls lists project entries', ls.value.includes('go.mod'))

const glob = await call('devc_glob', { pattern: 'cmd/**/*.go', workdir: CONFIG.containerRoot })
check('glob finds Go entrypoints', glob.value.includes('cmd/server/main.go'))

const grep = await call('devc_grep', { pattern: 'func main', path: CONFIG.containerRoot + '/cmd', include: '*.go' })
check('grep returns file:line matches', /cmd\/server\/main\.go:\d+:/.test(grep.value))

const bad = await call('devc_read', { path: '/tmp/dsh-devcontainer-registry/missing' })
check('missing file surfaces an error string', bad.value.includes('dsh-devcontainer error'))

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'))
process.exit(failures === 0 ? 0 : 1)

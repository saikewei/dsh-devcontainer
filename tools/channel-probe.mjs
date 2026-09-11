// Probe: prove a PERSISTENT JSON-lines channel into the dev container over one SSH connection,
// and measure per-op latency vs. per-call `ssh docker exec`.
//
// Reuses the SHIPPED helper (lib/helper.mjs) so the numbers describe the real transport
// rather than a copy of it. Target comes from the same environment variables the test
// suites use — see test/config.mjs.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { CONFIG, requireTarget } from '../test/config.mjs'

requireTarget('sshHost', 'container', 'containerRoot')

const HERE = dirname(fileURLToPath(import.meta.url))
const NAS = CONFIG.sshHost
const CONTAINER = CONFIG.container
const HELPER_REMOTE = '/tmp/dsh-helper.mjs'

const sshBase = ['-T', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', NAS]

function sh(argv, { input, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('ssh', argv, { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    if (input) child.stdin.end(input)
    else child.stdin.end()
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })
  })
}

function fmt(ms) {
  return ms < 10 ? ms.toFixed(2) + 'ms' : Math.round(ms) + 'ms'
}

// ---- 1. install the helper into the container -------------------------------------------
const helperSource = readFileSync(join(HERE, '..', 'lib', 'helper.mjs'))
const install = await sh(
  [...sshBase, `docker exec -i ${CONTAINER} bash -c 'cat > ${HELPER_REMOTE}'`],
  { input: helperSource },
)
if (install.code !== 0) {
  console.log('INSTALL FAILED', install.code, install.err)
  process.exit(1)
}
console.log(`installed helper -> container:${HELPER_REMOTE} (${helperSource.length} bytes)`)

// ---- 2. baseline: one `ssh docker exec` per call -----------------------------------------
const baseline = []
for (let i = 0; i < 3; i++) {
  const t = Date.now()
  const r = await sh([...sshBase, `docker exec ${CONTAINER} bash -c 'echo hi'`])
  baseline.push(Date.now() - t)
  if (r.code !== 0) console.log('  baseline err:', r.err.trim())
}
console.log(`baseline per-call ssh+docker exec: ${baseline.map(fmt).join(', ')}`)

// ---- 3. persistent channel ---------------------------------------------------------------
const child = spawn(
  'ssh',
  [...sshBase, `docker exec -i ${CONTAINER} node ${HELPER_REMOTE}`],
  { stdio: ['pipe', 'pipe', 'pipe'] },
)
let stderrBuf = ''
child.stderr.on('data', (d) => (stderrBuf += d))
child.on('exit', (code) => {
  console.log(`channel exited code=${code}${stderrBuf ? ' stderr=' + stderrBuf.trim() : ''}`)
})

const rl = createInterface({ input: child.stdout })
const pending = new Map()
let nextId = 1
rl.on('line', (line) => {
  let resp
  try {
    resp = JSON.parse(line)
  } catch {
    console.log('  <- unparseable frame:', line.slice(0, 200))
    return
  }
  const p = pending.get(resp.id)
  if (p) {
    pending.delete(resp.id)
    p.resolve(resp)
  } else {
    console.log('  <- orphan frame id=', resp.id)
  }
})

function call(req, timeoutMs = 30000) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`timeout waiting for id=${id}`))
    }, timeoutMs)
    pending.set(id, {
      resolve: (r) => {
        clearTimeout(timer)
        resolve(r)
      },
    })
    child.stdin.write(JSON.stringify({ id, ...req }) + '\n')
  })
}

const t0 = Date.now()
const pong = await call({ op: 'ping' })
console.log(`channel ready in ${fmt(Date.now() - t0)}: pid=${pong.pid} host=${pong.host}`)

// ---- 4. measure each op over the persistent channel --------------------------------------
async function bench(label, req, n = 20) {
  const times = []
  let last
  for (let i = 0; i < n; i++) {
    const t = Date.now()
    last = await call(req)
    times.push(Date.now() - t)
    if (!last.ok) {
      console.log(`  ${label} FAILED:`, last.error)
      return last
    }
  }
  times.sort((a, b) => a - b)
  const med = times[Math.floor(times.length / 2)]
  console.log(
    `  ${label.padEnd(28)} med=${fmt(med).padStart(8)}  min=${fmt(times[0]).padStart(8)}  max=${fmt(times.at(-1)).padStart(8)}`,
  )
  return last
}

console.log('\npersistent channel latency:')
await bench('ping', { op: 'ping' })
await bench('exec: true', { op: 'exec', cmd: 'true' })
await bench('exec: pwd', { op: 'exec', cmd: 'pwd' })
const st = await bench('stat go.mod', { op: 'stat', path: CONFIG.containerRoot + '/go.mod' })
console.log('    ->', JSON.stringify(st))
const ls = await bench('list project root', { op: 'list', path: CONFIG.containerRoot })
console.log(`    -> ${ls.entries?.length} entries`)
const rd = await bench('read go.mod', { op: 'read', path: CONFIG.containerRoot + '/go.mod' })
console.log(`    -> ${rd.bytes} bytes`)
const wr = await bench('write+rename tmp', {
  op: 'write',
  path: '/tmp/dsh-probe-write.txt',
  text: 'hello from persistent channel\n',
})
console.log('    ->', JSON.stringify(wr))

// ---- 5. prove it is really the container, not the NAS host --------------------------------
const ident = await call({
  op: 'exec',
  cmd: 'echo "host=$(hostname)"; echo "in_container=$(test -f /.dockerenv && echo yes || echo no)"; go version; node -v; cat /etc/os-release | head -1',
  cwd: CONFIG.containerRoot,
})
console.log('\ncontainer identity proof:')
console.log(ident.stdout.trim())
console.log(`exit=${ident.code}`)

// ---- 6. a realistic read/grep round trip --------------------------------------------------
const t1 = Date.now()
await call({ op: 'exec', cmd: 'grep -rn "func main" --include=*.go cmd/ | head -5' })
console.log(`\none grep round trip: ${fmt(Date.now() - t1)}`)

child.stdin.end()
setTimeout(() => process.exit(0), 300)

// dsh-devcontainer helper — runs INSIDE the dev container and speaks JSON-lines RPC
// over stdin/stdout.
//
// Two frame directions:
//   * request/response — one JSON request per line in, one response line out carrying
//     the same `id`.
//   * push events — lines WITHOUT an `id`, emitted for long-running execs
//     (`{event:'chunk'|'exit', execId, …}`) so a background process can be streamed.
//
// stdout carries protocol frames only; child output is captured and framed, never
// written raw. This file is installed into the container by the host half on every
// connect, so the container never needs a pre-installed agent.
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { readFile, writeFile, stat, lstat, readdir, realpath, rename, mkdir, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

const CAP = 1048576
const Q = String.fromCharCode(39)
const BS = String.fromCharCode(92)
const NL = String.fromCharCode(10)

const send = (frame) => process.stdout.write(JSON.stringify(frame) + NL)

/** POSIX single-quote a value so it survives `bash -c` unchanged. */
const shq = (value) => Q + String(value).split(Q).join(Q + BS + Q + Q) + Q

const dirname = (path) => {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

const kindOf = (info) => (info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other')

/** Replace `path` atomically, and never leave the temp file behind if that fails. */
async function replaceAtomically(path, text) {
  const temp = path + '.dsh-tmp-' + randomBytes(4).toString('hex')
  try {
    await writeFile(temp, text, 'utf8')
    await rename(temp, path)
  } catch (error) {
    // The failures that land here — ENOSPC, EACCES, a read-only mount — are exactly the ones
    // where dropping a stray `.dsh-tmp-*` file into the user's project is least welcome.
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Turn one `run` outcome into a search reply.
 *
 * Exit 1 is the search tools' "nothing matched" — a successful, empty answer. Any other
 * non-zero status means the search did not run at all: a bad regex, a path that is not
 * there, a shell that could not start. Reporting that as an empty result is worse than
 * reporting a failure, because the caller renders empty as "the pattern is absent", which
 * is a wrong answer rather than a missing one.
 *
 * Both commands below end in `| head`, so `set -o pipefail` is what lets the search tool's
 * own status survive at all; without it the pipeline always reports `head`'s success.
 */
function searchResult(res, cap, noMatchCode) {
  if (res.ok !== true) return { ok: false, error: String(res.error ?? 'the search did not run') }
  const text = res.stdout ?? ''
  if (res.code !== 0 && res.code !== noMatchCode) {
    const detail = String(res.stderr ?? '').trim().split('\n')[0]
    return { ok: false, error: detail !== '' ? detail : 'search exited with code ' + res.code }
  }
  return { ok: true, text, cap }
}

/** Run one command through bash and collect bounded stdout/stderr. */
function run(command, cwd, timeoutMs, stdinText, args = []) {
  return new Promise((resolve) => {
    // `args` become `$1…` inside the script. That is how a caller-supplied value reaches a
    // shell construct that must EXPAND it — a glob — without being pasted into the program
    // text, where `$(…)` and backticks would execute.
    const child = spawn('/bin/bash', ['-c', command, 'dsh-helper', ...args], { cwd: cwd || undefined })
    const outSink = { value: '' }
    const errSink = { value: '' }
    let spilled = false
    const timer = timeoutMs ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null
    const capture = (sink) => (chunk) => {
      if (sink.value.length < CAP) sink.value += chunk.toString('utf8')
      else spilled = true
    }
    child.stdout.on('data', capture(outSink))
    child.stderr.on('data', capture(errSink))
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      // A missing `cwd` surfaces as `spawn /bin/bash ENOENT`, which names the shell rather
      // than the directory the caller actually got wrong. Say which one it was.
      const message = String(error && error.message ? error.message : error)
      const where = cwd ? ' (working directory ' + cwd + ')' : ''
      resolve({ ok: false, error: message + where })
    })
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      resolve({
        ok: true,
        stdout: outSink.value,
        stderr: errSink.value,
        code: code === null ? -1 : code,
        signal: signal || null,
        truncated: spilled,
      })
    })
    child.stdin.end(stdinText === undefined ? undefined : stdinText)
  })
}

/** Background execs, keyed by a helper-owned id, streamed to the host as push frames. */
const execs = new Map()
let nextExecId = 1

function startExec(request) {
  const execId = 'x' + String(nextExecId++)
  const child = spawn('/bin/bash', ['-c', request.cmd], { cwd: request.cwd || undefined })
  const record = { child, status: 'running' }
  execs.set(execId, record)

  child.stdout.on('data', (chunk) => send({ event: 'chunk', execId, stream: 'stdout', text: chunk.toString('utf8') }))
  child.stderr.on('data', (chunk) => send({ event: 'chunk', execId, stream: 'stderr', text: chunk.toString('utf8') }))
  child.on('error', (error) => {
    send({ event: 'chunk', execId, stream: 'stderr', text: String(error && error.message ? error.message : error) })
  })
  child.on('close', (code, signal) => {
    record.status = signal ? 'killed' : 'completed'
    send({ event: 'exit', execId, code: code === null ? -1 : code, signal: signal || null })
    // Retain the record briefly so a late kill() is a correct no-op, then drop it.
    const timer = setTimeout(() => execs.delete(execId), 60000)
    if (typeof timer.unref === 'function') timer.unref()
  })

  child.stdin.end(request.stdin === undefined ? undefined : request.stdin)
  return { ok: true, execId }
}

/**
 * TCP relays, one per forwarded connection, dialled from IN HERE.
 *
 * That is the whole reason port forwarding is implemented this way rather than as
 * `ssh -L local:containerIp:port host`: a dev server that listens on `127.0.0.1` inside the
 * container is unreachable from the host's network namespace — measured, not assumed, the
 * host gets ECONNREFUSED — so the connection has to be opened from inside. The bytes then
 * ride the resident channel that already exists.
 */
const relays = new Map()

function relayOpen(request) {
  const target = (request.host || '127.0.0.1') + ':' + String(request.port)
  return new Promise((resolve) => {
    const socket = connect({ host: request.host || '127.0.0.1', port: request.port })
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      socket.destroy()
      done({ ok: false, error: 'connecting to ' + target + ' timed out' })
    }, request.timeoutMs || 10000)
    if (typeof timer.unref === 'function') timer.unref()

    socket.on('connect', () => {
      // A dev server is interactive: Nagle would batch small frames and add latency to every
      // request. The channel already carries the throughput; this keeps the latency honest.
      socket.setNoDelay(true)
      relays.set(request.relayId, socket)
      done({ ok: true })
    })
    socket.on('error', (error) => {
      done({ ok: false, error: String(error && error.code ? error.code : error && error.message ? error.message : error) })
    })
    // A relay this end dropped deliberately was removed from the map first, and the host
    // already knows: announcing the close would be a second, contradictory notification.
    socket.on('close', () => {
      if (!relays.has(request.relayId)) return
      relays.delete(request.relayId)
      send({ event: 'relay_close', relayId: request.relayId })
    })
    socket.on('data', (chunk) => {
      // A false write means the pipe is full. Pausing here is real backpressure: the read
      // stops, the kernel's window closes, and the peer slows down — without it the buffered
      // output grows without bound while a download runs.
      if (!send({ event: 'relay_data', relayId: request.relayId, b64: chunk.toString('base64') })) {
        socket.pause()
        process.stdout.once('drain', () => socket.resume())
      }
    })
  })
}

/** Bytes arriving from the host for one relay. A NOTIFICATION: no reply frame is sent. */
function relayData(frame) {
  const socket = relays.get(frame.relayId)
  if (socket === undefined || socket.destroyed) return
  if (!socket.write(Buffer.from(String(frame.b64 === undefined ? '' : frame.b64), 'base64'))) {
    // The other direction's backpressure. Pausing the line reader stops reading stdin, which
    // propagates all the way back to the sender; everything waits, which is correct — there is
    // one pipe and no way to reorder around a full socket.
    lines.pause()
    socket.once('drain', () => lines.resume())
  }
}

function relayClose(relayId) {
  const socket = relays.get(relayId)
  if (socket === undefined) return { ok: true, closed: false }
  relays.delete(relayId)
  socket.destroy()
  return { ok: true, closed: true }
}

/**
 * The container's listening ports, as raw text.
 *
 * Deliberately unparsed: `ss` gives the process name and `/proc/net/tcp` is the fallback every
 * Linux has, and the host half owns the parsing so it can be tested against both formats
 * without a container.
 */
const PORT_LIST_COMMAND = 'ss -ltnp 2>/dev/null || cat /proc/net/tcp /proc/net/tcp6'

async function handle(request) {
  const started = Date.now()
  let result
  try {
    switch (request.op) {
      case 'ping': {
        const host = await run('hostname', request.cwd, 5000)
        result = { ok: true, pid: process.pid, host: host.stdout.trim(), cwd: process.cwd() }
        break
      }
      case 'exec':
        result = await run(request.cmd, request.cwd, request.timeoutMs, request.stdin)
        break
      case 'exec_start':
        result = startExec(request)
        break
      case 'exec_kill': {
        const record = execs.get(request.execId)
        if (record === undefined || record.status !== 'running') {
          result = { ok: true, killed: false }
          break
        }
        record.child.kill('SIGTERM')
        const escalate = setTimeout(() => {
          if (record.status === 'running') record.child.kill('SIGKILL')
        }, request.graceMs || 3000)
        if (typeof escalate.unref === 'function') escalate.unref()
        result = { ok: true, killed: true }
        break
      }
      case 'read': {
        const buffer = await readFile(request.path)
        if (buffer.includes(0)) throw new Error('refusing to read a binary file')
        result = { ok: true, text: buffer.toString('utf8'), bytes: buffer.length }
        break
      }
      case 'read_b64': {
        const buffer = await readFile(request.path)
        const offset = Math.max(0, request.offset || 0)
        const window = request.length === undefined ? buffer : buffer.subarray(offset, offset + request.length)
        result = { ok: true, base64: window.toString('base64'), bytes: window.length, total: buffer.length }
        break
      }
      case 'write': {
        await mkdir(dirname(request.path), { recursive: true })
        await replaceAtomically(request.path, request.text)
        const info = await stat(request.path)
        result = { ok: true, bytes: info.size, mtimeMs: info.mtimeMs }
        break
      }
      case 'edit': {
        const before = await readFile(request.path, 'utf8')
        const parts = before.split(request.old)
        if (parts.length === 1) {
          result = { ok: false, error: 'old_string not found in ' + request.path }
          break
        }
        if (parts.length > 2 && !request.replaceAll) {
          result = { ok: false, error: 'old_string appears ' + (parts.length - 1) + ' times; pass replace_all' }
          break
        }
        const after = parts.join(request.new)
        await replaceAtomically(request.path, after)
        const info = await stat(request.path)
        result = { ok: true, replacements: parts.length - 1, bytes: info.size, mtimeMs: info.mtimeMs }
        break
      }
      case 'stat': {
        try {
          const info = await stat(request.path)
          result = { ok: true, exists: true, type: kindOf(info), size: info.size, mtimeMs: info.mtimeMs }
        } catch {
          result = { ok: true, exists: false }
        }
        break
      }
      case 'lstat': {
        try {
          const info = await lstat(request.path)
          result = {
            ok: true,
            exists: true,
            type: info.isSymbolicLink() ? 'symlink' : kindOf(info),
            size: info.size,
            mtimeMs: info.mtimeMs,
          }
        } catch {
          result = { ok: true, exists: false }
        }
        break
      }
      case 'realpath': {
        try {
          result = { ok: true, path: await realpath(request.path) }
        } catch {
          // An absent path has no realpath; the host falls back to its lexical form.
          result = { ok: true, path: null }
        }
        break
      }
      case 'list': {
        const names = (await readdir(request.path)).sort()
        const entries = []
        for (const name of names) {
          const child = request.path + '/' + name
          try {
            const info = await stat(child)
            entries.push({ name, type: kindOf(info), size: info.size, mtimeMs: info.mtimeMs })
          } catch {
            entries.push({ name, type: 'other' })
          }
        }
        result = { ok: true, entries }
        break
      }
      case 'grep': {
        const include = request.include ? ' --include=' + shq(request.include) : ''
        // `pipefail` so grep's own status survives the `head` that bounds the output.
        const command = 'set -o pipefail; grep -rn -E' + include + ' -- ' + shq(request.pattern) + ' ' + shq(request.path) + ' | head -250'
        const res = await run(command, request.cwd, 60000)
        result = searchResult(res, 250, 1)
        break
      }
      case 'glob': {
        // The pattern arrives as `$1`, never as program text: it must still undergo pathname
        // expansion, but pasting it in would execute `$(…)`, and unquoted expansion would
        // word-split a name containing a space. `IFS=` suppresses that splitting while
        // leaving globbing intact, so both problems are solved by the same two characters.
        const command = 'set -o pipefail; shopt -s globstar nullglob dotglob; IFS=; for f in $1; do [ -f "$f" ] && echo "$f"; done | head -200'
        const res = await run(command, request.cwd || '/', 60000, undefined, [String(request.pattern ?? '')])
        result = searchResult(res, 200, 0)
        break
      }
      case 'listening': {
        const res = await run(PORT_LIST_COMMAND, request.cwd || '/', 20000)
        // A probe that could not run is reported as such: an empty list reads as "nothing is
        // listening", which is a wrong answer rather than a missing one.
        result = res.ok === true
          ? { ok: true, text: res.stdout }
          : { ok: false, error: String(res.error ?? 'the port probe did not run') }
        break
      }
      case 'relay_open':
        result = await relayOpen(request)
        break
      case 'relay_close':
        result = relayClose(request.relayId)
        break
      default:
        result = { ok: false, error: 'unknown op: ' + String(request.op) }
    }
  } catch (error) {
    result = { ok: false, error: String(error && error.message ? error.message : error) }
  }
  send(Object.assign({ id: request.id, elapsedMs: Date.now() - started }, result))
}

const lines = createInterface({ input: process.stdin, terminal: false })
lines.on('line', (line) => {
  if (!line.trim()) return
  let request
  try {
    request = JSON.parse(line)
  } catch {
    send({ id: null, ok: false, error: 'malformed request frame' })
    return
  }
  // A notification carries no `id` and expects no reply. `relay_data` is the host pushing
  // connection bytes in, and it is the hot path of a forward: answering each frame would
  // double the traffic on the one pipe both directions share.
  if (request.event === 'relay_data') {
    relayData(request)
    return
  }
  handle(request)
})
lines.on('close', () => {
  for (const record of execs.values()) {
    if (record.status === 'running') record.child.kill('SIGKILL')
  }
  // The channel is gone, so nothing can reach these sockets again; leaving them open would
  // hold the user's services in a connection that no longer has a reader.
  for (const socket of relays.values()) socket.destroy()
  relays.clear()
  process.exit(0)
})

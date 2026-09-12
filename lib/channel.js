/**
 * A resident JSON-lines channel to one remote execution world.
 *
 * Two targets, one protocol: `host` runs the helper directly on the remote machine,
 * `container` runs it inside a container via `docker exec`. Everything above this file —
 * the RPC ops, the push-event stream, the tool layer — is identical for both, which is why
 * the host side needed no new helper.
 *
 * The helper is rewritten on every connect, so a target can never drift from the plugin.
 *
 * @module dsh-devcontainer/channel
 */
import { readFile } from 'node:fs/promises'

const NL = String.fromCharCode(10)

/**
 * How one process ended, in words.
 *
 * A killed process reports `exitCode: null` and a signal, and only one of the two is ever set.
 * Printing the code alone reads as "exit null", which says nothing about whether it was the OOM
 * killer, a dropped ssh session, or a container going away — and that question cost real time
 * the first time this channel died in the field.
 */
function describeExit(outcome) {
  if (outcome.exitCode === null || outcome.exitCode === undefined) {
    return outcome.signal ? 'killed by ' + String(outcome.signal) : 'exit unknown'
  }
  return 'exit ' + String(outcome.exitCode) + (outcome.signal ? ', signal ' + String(outcome.signal) : '')
}
const HELPER_PATH = '/tmp/dsh-devcontainer-helper.mjs'

let helperSourcePromise
function helperSource() {
  helperSourcePromise ??= readFile(new URL('./helper.mjs', import.meta.url), 'utf8')
  return helperSourcePromise
}

/** POSIX single-quote, for the one place a path crosses into a shell. */
const shq = (value) => "'" + String(value).split("'").join("'\\''") + "'"

export class RemoteChannel {
  #transport
  #config
  #target
  #proc
  #connecting
  #nextId = 1
  #pending = new Map()
  #listeners = new Set()
  /** Told when the process behind this channel goes away. See {@link onClose}. */
  #closeListeners = new Set()
  /** Whether the CURRENT process generation has already been reported as gone. */
  #announced = false
  #stderrTail = ''
  #lastError

  /**
   * @param transport - the SSH transport to run over.
   * @param config - resolved plugin config (`sshHost`, `container`, …).
   * @param target - `'host'` for the remote machine itself, `'container'` for `docker exec`.
   */
  constructor(transport, config, target) {
    this.#transport = transport
    this.#config = config
    this.#target = target
  }

  get target() {
    return this.#target
  }

  get connected() {
    return this.#proc !== undefined
  }

  get lastError() {
    return this.#lastError
  }

  get config() {
    return this.#config
  }

  /** The default working directory for this target. */
  get defaultCwd() {
    return this.#target === 'host' ? this.#config.hostRoot || '/' : this.#config.containerRoot
  }

  /** The command that starts the helper inside this target. */
  #runCommand() {
    if (this.#target === 'host') return 'node ' + HELPER_PATH
    return 'docker exec -i ' + shq(this.#config.container) + ' node ' + HELPER_PATH
  }

  /** The command that writes the helper into this target, reading it from stdin. */
  #installCommand() {
    if (this.#target === 'host') return 'cat > ' + HELPER_PATH
    return 'docker exec -i ' + shq(this.#config.container) + ' bash -c ' + shq('cat > ' + HELPER_PATH)
  }

  /** Subscribe to push frames (long-running exec output). Returns an unsubscribe function. */
  onEvent(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * Run `listener` when the process behind this channel goes away, and return an unsubscribe.
   *
   * A consumer holding something OPEN across the channel's life needs this. Nothing else
   * reports the death: in-flight calls are rejected and the next one reconnects, so a caller
   * that never makes another call — a forwarded TCP connection, say — otherwise waits on a
   * channel that is already gone, with no event and no error to act on.
   */
  onClose(listener) {
    this.#closeListeners.add(listener)
    return () => this.#closeListeners.delete(listener)
  }

  /**
   * Tell every listener this channel's process is gone — ONCE per generation.
   *
   * Two paths reach here for one death: the process's own `done` handler, and `dispose()`
   * terminating it. Announcing twice would have a consumer tear down twice, and the second
   * teardown reports a count that no longer means anything.
   */
  #announceClose() {
    if (this.#announced) return
    this.#announced = true
    for (const listener of [...this.#closeListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('dsh-devcontainer: channel close listener failed: ' + String(error && error.message ? error.message : error))
      }
    }
  }

  /**
   * Write a frame that expects NO reply, and return whether the pipe accepted it.
   *
   * `request()` is the wrong shape for connection bytes: it allocates an id, registers a
   * pending entry and waits for a matching response, so a relay sending a chunk per round trip
   * would double the traffic on the one pipe both directions share. A notification carries no
   * `id`, and the helper's line handler dispatches it without answering.
   *
   * The boolean is the pipe's own backpressure signal: `false` means the consumer is behind and
   * the caller must stop producing until {@link onceDrain} fires, or the buffer grows without
   * bound. An unconnected channel reports `false` for the same reason — the caller must not
   * treat "the write went nowhere" as "the write succeeded".
   */
  notify(frame) {
    if (this.#proc === undefined || this.#proc.stdin === undefined) return false
    return this.#proc.stdin.write(JSON.stringify(frame) + NL)
  }

  /** Run `listener` when the pipe can accept more. */
  onceDrain(listener) {
    if (this.#proc === undefined || this.#proc.stdin === undefined) return
    this.#proc.stdin.once('drain', listener)
  }

  #describeTarget() {
    return this.#target === 'host'
      ? 'the host ' + this.#config.sshHost
      : this.#config.sshHost + ':' + this.#config.container
  }

  /**
   * Write the helper into the target. A duplex channel rather than SFTP, so the container
   * case — where only `docker exec` can reach the filesystem — and the host case share one
   * code path.
   */
  async #install() {
    // The helper is a Node script, so a host without Node cannot carry this channel. Say so
    // plainly: the raw symptom is an `exit 127` whose stderr reads `node: command not found`,
    // which reads like a plugin failure rather than a missing runtime.
    if (this.#target === 'host') {
      const probe = await this.#transport.collect('command -v node >/dev/null 2>&1 && echo yes || echo no')
      if (probe.stdout.trim() !== 'yes') {
        throw new Error(
          'the host ' + this.#config.sshHost + ' has no `node`. The host channel runs a Node helper, so '
          + 'those tools need it installed. Browsing hosts and registering a workspace need only sshd.',
        )
      }
    }
    const channel = await this.#transport.open(this.#installCommand(), { timeoutMs: 60000 })
    const source = await helperSource()
    channel.stdin.write(source)
    channel.stdin.end()
    const outcome = await channel.done
    if (outcome.exitCode !== 0) {
      throw new Error(
        'cannot install the helper into ' + this.#describeTarget()
        + ' (exit ' + String(outcome.exitCode) + ')',
      )
    }
  }

  #attach(handle) {
    const decoder = new TextDecoder('utf-8')
    let buffered = ''

    handle.stdout.on('data', (chunk) => {
      buffered += decoder.decode(chunk, { stream: true })
      let index = buffered.indexOf(NL)
      while (index !== -1) {
        const line = buffered.slice(0, index)
        buffered = buffered.slice(index + 1)
        index = buffered.indexOf(NL)
        if (!line.trim()) continue
        let frame
        try {
          frame = JSON.parse(line)
        } catch {
          console.error('dsh-devcontainer: malformed frame from ' + this.#target + ' helper: ' + line.slice(0, 200))
          continue
        }
        if (frame.id === undefined && typeof frame.event === 'string') {
          for (const listener of this.#listeners) {
            try {
              listener(frame)
            } catch (error) {
              console.error('dsh-devcontainer: event listener failed: ' + String(error && error.message ? error.message : error))
            }
          }
          continue
        }
        const entry = this.#pending.get(frame.id)
        if (entry === undefined) continue
        this.#pending.delete(frame.id)
        entry.settle()
        entry.resolve(frame)
      }
    })

    if (handle.stderr !== undefined) {
      handle.stderr.on('data', (chunk) => {
        this.#stderrTail = (this.#stderrTail + decoder.decode(chunk, { stream: true })).slice(-2000)
      })
    }

    const died = (message) => {
      this.#lastError = message
      this.#proc = undefined
      this.#connecting = undefined
      for (const entry of this.#pending.values()) {
        entry.settle()
        entry.reject(new Error('dsh-devcontainer: ' + message))
      }
      this.#pending.clear()
      // After the rejections, so a listener that makes a call finds a settled channel.
      this.#announceClose()
    }

    handle.done.then(
      (outcome) => died(
        this.#target + ' channel closed (' + describeExit(outcome) + ')'
        + (this.#stderrTail ? ': ' + this.#stderrTail.trim() : ''),
      ),
      (error) => died(this.#target + ' channel failed: ' + String(error && error.message ? error.message : error)),
    )
  }

  async connect() {
    if (this.#target === 'container' && this.#config.container === '') {
      throw new Error('dsh-devcontainer: no container configured; set `container` on the `devcontainer` row')
    }
    await this.#install()
    const handle = await this.#transport.open(this.#runCommand(), { timeoutMs: 30000 })
    this.#attach(handle)
    this.#proc = handle
    // A new process generation: whatever was reported about the previous one no longer applies.
    this.#announced = false
    try {
      const pong = await this.#call({ op: 'ping', cwd: this.defaultCwd }, 20000)
      // The handshake is a QUESTION, not just a round trip: a helper that answers `ok: false`
      // — no such container, a broken working directory — has not completed it, and returning
      // that frame as a success reported a healthy channel with `lastError` cleared.
      if (pong.ok !== true) throw new Error(String(pong.error ?? 'the helper refused the handshake'))
      // It answered, so it is up — and this process is meant to stay up for the whole session.
      // The budget that guarded its START must stop counting now, or it becomes a lifetime
      // limit and the helper dies half a minute into every session.
      if (typeof handle.disarm === 'function') handle.disarm()
      this.#lastError = undefined
      return pong
    } catch (error) {
      // A handshake that never completed must not leave the channel looking connected:
      // `ensure()` returns immediately while `#proc` is set, so a helper that failed to start,
      // never answered, or refused would be reported as live forever while every later call
      // wrote into it. A timeout and a refusal take this same path.
      this.dispose()
      throw error
    }
  }

  #call(request, timeoutMs, signal) {
    const proc = this.#proc
    if (proc === undefined || proc.stdin === undefined) {
      return Promise.reject(new Error('dsh-devcontainer: ' + this.#target + ' channel is not connected'))
    }
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const cleanups = []
      const settle = () => { for (const cleanup of cleanups) cleanup() }
      // EVERY terminal path releases the timer and the abort listener. Only the success path
      // used to, so a call that timed out left both behind — and a caller that passes the
      // tool's own signal would accumulate one listener per timeout on the same signal.
      const fail = (reason) => {
        this.#pending.delete(id)
        settle()
        reject(new Error('dsh-devcontainer: "' + String(request.op) + '" ' + reason))
      }
      if (timeoutMs) {
        const timer = setTimeout(() => fail('timed out after ' + String(timeoutMs) + 'ms'), timeoutMs)
        cleanups.push(() => clearTimeout(timer))
      }
      if (signal) {
        if (signal.aborted) {
          fail('was cancelled')
          return
        }
        const onAbort = () => fail('was cancelled')
        signal.addEventListener('abort', onAbort, { once: true })
        cleanups.push(() => signal.removeEventListener('abort', onAbort))
      }
      this.#pending.set(id, { resolve, reject, settle })
      proc.stdin.write(JSON.stringify(Object.assign({ id }, request)) + NL)
    })
  }

  async ensure() {
    if (this.#proc !== undefined) return
    if (this.#connecting === undefined) {
      this.#connecting = this.connect().catch((error) => {
        this.#connecting = undefined
        this.#lastError = String(error && error.message ? error.message : error)
        throw error
      })
    }
    await this.#connecting
  }

  /** Issue one RPC frame, connecting first when needed, and surface helper errors. */
  async request(request, timeoutMs, signal) {
    await this.ensure()
    const frame = await this.#call(request, timeoutMs, signal)
    if (frame.ok !== true) throw new Error(String(frame.error))
    return frame
  }

  dispose() {
    const proc = this.#proc
    this.#proc = undefined
    this.#listeners.clear()
    for (const entry of this.#pending.values()) {
      entry.settle()
      entry.reject(new Error('dsh-devcontainer: ' + this.#target + ' channel disposed'))
    }
    this.#pending.clear()
    this.#announceClose()
    if (proc !== undefined) {
      try {
        proc.terminate()
      } catch {
        // Disposal must not throw.
      }
    }
  }
}

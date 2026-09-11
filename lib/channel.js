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
    }

    handle.done.then(
      (outcome) => died(
        this.#target + ' channel closed (exit ' + String(outcome.exitCode) + ')'
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
    const pong = await this.#call({ op: 'ping', cwd: this.defaultCwd }, 20000)
    this.#lastError = undefined
    return pong
  }

  #call(request, timeoutMs, signal) {
    const proc = this.#proc
    if (proc === undefined || proc.stdin === undefined) {
      return Promise.reject(new Error('dsh-devcontainer: ' + this.#target + ' channel is not connected'))
    }
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const cleanups = []
      if (timeoutMs) {
        const timer = setTimeout(() => {
          this.#pending.delete(id)
          reject(new Error('dsh-devcontainer: "' + String(request.op) + '" timed out after ' + String(timeoutMs) + 'ms'))
        }, timeoutMs)
        cleanups.push(() => clearTimeout(timer))
      }
      if (signal) {
        if (signal.aborted) {
          reject(new Error('dsh-devcontainer: "' + String(request.op) + '" was cancelled'))
          return
        }
        const onAbort = () => {
          this.#pending.delete(id)
          reject(new Error('dsh-devcontainer: "' + String(request.op) + '" was cancelled'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        cleanups.push(() => signal.removeEventListener('abort', onAbort))
      }
      this.#pending.set(id, {
        resolve,
        reject,
        settle: () => { for (const cleanup of cleanups) cleanup() },
      })
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
    if (proc !== undefined) {
      try {
        proc.terminate()
      } catch {
        // Disposal must not throw.
      }
    }
  }
}

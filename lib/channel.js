/**
 * The resident channel: one long-lived SSH connection to the host that runs the
 * container, carrying one helper process inside it that speaks JSON-lines RPC.
 *
 * A frame on this channel costs single-digit milliseconds, where a fresh
 * `ssh host docker exec …` per call costs hundreds — which is the whole reason the
 * capability is usable at all.
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

export class ContainerChannel {
  #ctx
  #config
  #argv
  #proc
  #connecting
  #nextId = 1
  #pending = new Map()
  #listeners = new Set()
  #stderrTail = ''
  #lastError

  constructor(ctx, config) {
    this.#ctx = ctx
    this.#config = config
    this.#argv = [
      'ssh',
      '-T',
      '-o', 'BatchMode=yes',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ConnectTimeout=10',
      config.sshHost,
      'docker exec -i ' + config.container + ' node ' + HELPER_PATH,
    ]
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

  /** Subscribe to push frames (long-running exec output). Returns an unsubscribe function. */
  onEvent(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** One-shot ssh invocation with collected output; used for the helper install. */
  async runOnce(argv, stdinText) {
    const handle = this.#ctx.subprocess.spawn({
      argv,
      cwd: '/tmp',
      stdio: stdinText === undefined
        ? { stdin: 'ignore', stdout: { maxBytes: 262144 }, stderr: { maxBytes: 262144 } }
        : { stdin: { data: stdinText }, stdout: { maxBytes: 262144 }, stderr: { maxBytes: 262144 } },
      graceMs: 5000,
    })
    const outcome = await handle.done
    return {
      exitCode: outcome.exitCode,
      out: handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : '',
      err: handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : '',
    }
  }

  #attach(proc) {
    const decoder = new TextDecoder('utf-8')
    let buffered = ''

    proc.stdout.on('data', (chunk) => {
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
          console.error('dsh-devcontainer: malformed frame from helper: ' + line.slice(0, 200))
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

    proc.stderr.on('data', (chunk) => {
      this.#stderrTail = (this.#stderrTail + decoder.decode(chunk, { stream: true })).slice(-2000)
    })

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

    proc.done.then(
      (outcome) => died(
        'channel closed (exit ' + String(outcome.exitCode) + ')'
        + (this.#stderrTail ? ': ' + this.#stderrTail.trim() : ''),
      ),
      (error) => died('channel failed: ' + String(error && error.message ? error.message : error)),
    )
  }

  async connect() {
    if (this.#config.container === '') {
      throw new Error('dsh-devcontainer: no container configured; set `container` on the `devcontainer` row')
    }
    const install = await this.runOnce(
      ['ssh', '-T', '-o', 'BatchMode=yes', this.#config.sshHost,
        "docker exec -i " + this.#config.container + " bash -c 'cat > " + HELPER_PATH + "'"],
      await helperSource(),
    )
    if (install.exitCode !== 0) {
      throw new Error(
        'cannot install the helper into ' + this.#config.sshHost + ':' + this.#config.container
        + ' (ssh/docker exit ' + String(install.exitCode) + '): ' + (install.err || install.out).trim(),
      )
    }
    const proc = this.#ctx.subprocess.spawn({
      argv: this.#argv,
      cwd: '/tmp',
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 5000,
    })
    this.#attach(proc)
    this.#proc = proc
    const pong = await this.#call({ op: 'ping', cwd: this.#config.containerRoot }, 20000)
    this.#lastError = undefined
    return pong
  }

  #call(request, timeoutMs, signal) {
    const proc = this.#proc
    if (proc === undefined || proc.stdin === undefined) {
      return Promise.reject(new Error('dsh-devcontainer: channel is not connected'))
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
      entry.reject(new Error('dsh-devcontainer: plugin disposed'))
    }
    this.#pending.clear()
    if (proc !== undefined) {
      try {
        proc.terminate()
      } catch {
        // disposal must not throw
      }
    }
  }
}

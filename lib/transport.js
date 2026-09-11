/**
 * One remote execution world, reached over SSH.
 *
 * Two backends, chosen by what the deployment composed rather than by a config flag:
 *
 *   * **`ctx.ssh`** — dsh-ssh's shared connection owner, when a deployment mounts it. Gives
 *     an authenticated ssh2 client (its own `~/.ssh/config` handling, host-key policy,
 *     ProxyJump, keepalive) and a control-plane `exec`.
 *   * **the local `ssh` binary** — the fallback, and the reason this plugin needs no
 *     dependency at all. Shelling out to OpenSSH inherits the operator's real
 *     `~/.ssh/config`, keys, agent and jump hosts for free, which is the whole point.
 *
 * Callers never learn which one answered. The channel protocol above this is identical.
 *
 * @module dsh-devcontainer/transport
 */
import { spawn } from 'node:child_process'

const SSH_BASE = ['-T', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ConnectTimeout=10']

export class RemoteTransport {
  #ctx
  #config
  #childProcesses = new Set()

  constructor(ctx, config) {
    this.#ctx = ctx
    this.#config = config
  }

  /** Which backend is in use: `'ctx.ssh'` when a deployment mounted the owner, else `'ssh'`. */
  get backend() {
    return this.#ctx.get('ssh') === undefined ? 'ssh' : 'ctx.ssh'
  }

  get host() {
    return this.#config.sshHost
  }

  /** Endpoint description for status output, from whichever backend is answering. */
  async describe() {
    const runtime = this.#ctx.get('ssh')
    if (runtime === undefined) return { backend: 'ssh', host: this.#config.sshHost }
    return { backend: 'ctx.ssh', host: this.#config.sshHost }
  }

  /**
   * Run one command and collect its output. Control-plane only — probes, `docker ps`,
   * `docker inspect` — never model work, which belongs on a persistent channel.
   *
   * @param command - remote command text (the caller shell-quotes it).
   * @returns exit facts plus decoded stdout and stderr.
   */
  async collect(command, { cwd, timeoutMs = 60000, signal } = {}) {
    const runtime = this.#ctx.get('ssh')
    if (runtime !== undefined) {
      try {
        const outcome = await runtime.exec(command, { cwd, signal })
        return {
          exitCode: outcome.code ?? outcome.exitCode ?? null,
          stdout: outcome.stdout ?? '',
          stderr: outcome.stderr ?? '',
        }
      } catch (error) {
        return { exitCode: null, stdout: '', stderr: String(error && error.message ? error.message : error) }
      }
    }

    return this.#spawnCollected(['ssh', ...SSH_BASE, this.#config.sshHost, command], { timeoutMs, signal })
  }

  /**
   * Open a long-lived duplex channel running one command, for the resident helper.
   *
   * @param command - the remote command line.
   * @returns stdin writer, stdout/stderr readers, and a settlement promise.
   */
  async open(command, { timeoutMs } = {}) {
    const runtime = this.#ctx.get('ssh')
    if (runtime !== undefined) {
      const client = await runtime.getClient()
      const stream = await new Promise((resolve, reject) => {
        client.exec(command, (error, channel) => (error ? reject(error) : resolve(channel)))
      })
      return {
        stdin: stream,
        stdout: stream,
        stderr: stream.stderr,
        done: new Promise((resolve) => {
          stream.on('close', (code, signal) => resolve({ exitCode: code ?? null, signal: signal ?? null }))
        }),
        terminate: () => {
          try {
            stream.close()
          } catch {
            // Closing an already-closed channel is not an error at this layer.
          }
        },
      }
    }

    return this.#spawnStreaming(['ssh', ...SSH_BASE, this.#config.sshHost, command], timeoutMs)
  }

  async #spawnCollected(argv, { timeoutMs, signal }) {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
    this.#childProcesses.add(child)
    let out = ''
    let err = ''
    const cap = 1 << 20
    child.stdout.on('data', (chunk) => { if (out.length < cap) out += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { if (err.length < cap) err += chunk.toString('utf8') })
    const timer = timeoutMs ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null
    const onAbort = () => child.kill('SIGTERM')
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const exitCode = await new Promise((resolve) => {
      child.on('error', (error) => { err += String(error && error.message ? error.message : error) })
      child.on('close', (code) => resolve(code))
    })
    if (timer) clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
    this.#childProcesses.delete(child)
    return { exitCode, stdout: out, stderr: err }
  }

  #spawnStreaming(argv, timeoutMs) {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
    this.#childProcesses.add(child)
    const timer = timeoutMs ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      done: new Promise((resolve) => {
        if (timer) clearTimeout(timer)
        child.on('error', () => resolve({ exitCode: null, signal: null }))
        child.on('close', (code, signal) => {
          this.#childProcesses.delete(child)
          resolve({ exitCode: code, signal: signal ?? null })
        })
      }),
      terminate: () => {
        try {
          child.kill('SIGTERM')
          setTimeout(() => child.kill('SIGKILL'), 1000)
        } catch {
          // Already gone.
        }
      },
    }
  }

  dispose() {
    for (const child of this.#childProcesses) {
      try {
        child.kill('SIGKILL')
      } catch {
        // Disposal must not throw.
      }
    }
    this.#childProcesses.clear()
  }
}

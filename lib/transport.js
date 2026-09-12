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

/**
 * Bound a promise by a budget.
 *
 * The `ctx.ssh` backend offers no timeout of its own — `client.exec` and the callback that
 * delivers the stream simply never fire if the far side stops answering. Without this the
 * channel's `connect()` awaits forever, `#connecting` is never cleared, and every later call
 * blocks *before* it arms its own budget, so nothing above can recover the world either.
 *
 * @param promise - the work to bound.
 * @param timeoutMs - the budget, or a falsy value to leave it unbounded.
 * @param what - named in the error so the failure says which step stalled.
 */
function withTimeout(promise, timeoutMs, what) {
  if (!timeoutMs) return promise
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('ssh ' + what + ' did not complete within ' + timeoutMs + 'ms')),
      timeoutMs,
    )
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

export class RemoteTransport {
  #ctx
  #host
  #ctxSshHost
  #childProcesses = new Set()

  /**
   * @param ctx - the plugin context.
   * @param host - the SSH destination this transport reaches (an ssh-config alias, hostname
   *   or address). One transport reaches one machine; the plugin holds one per host in use.
   * @param ctxSshHost - the host `ctx.ssh` is connected to, when a deployment mounted it.
   */
  constructor(ctx, host, ctxSshHost) {
    this.#ctx = ctx
    this.#host = host
    this.#ctxSshHost = ctxSshHost
  }

  /**
   * The `ctx.ssh` runtime, but only for the host it is actually connected to.
   *
   * That provider owns ONE connection. Answering for any other host would silently run work
   * on the wrong machine, so every other host goes through the ssh binary instead.
   */
  #runtime() {
    if (this.#ctxSshHost === undefined || this.#ctxSshHost === '') return undefined
    if (this.#host !== this.#ctxSshHost) return undefined
    return this.#ctx.get('ssh')
  }

  /** Which backend is in use: `'ctx.ssh'` when this host is the one it owns, else `'ssh'`. */
  get backend() {
    return this.#runtime() === undefined ? 'ssh' : 'ctx.ssh'
  }

  /**
   * The destination to hand OpenSSH, refusing an unconfigured one.
   *
   * Without this an empty `sshHost` reaches the ssh binary, which answers with its own
   * complaint about a host named `''` — a message that names neither the plugin nor the
   * config key the operator has to set.
   */
  #destination() {
    if (this.#host === '') {
      throw new Error(
        'no sshHost configured; set `sshHost` on the `devcontainer` row to an alias from your ~/.ssh/config',
      )
    }
    // A destination is a DESTINATION, never an option — and ssh cannot tell the two apart: an
    // argv element starting with `-` is parsed as a flag, so `-oProxyCommand=…` would run a
    // command on THIS machine instead of reaching any machine at all. The string arrives from a
    // tool argument or from a segment of a mirrored path, so it is REFUSED rather than
    // sanitized: no legitimate ssh alias begins with a dash, and ssh offers no `--` that would
    // end its own option parsing. This is the last stop before argv, which is why the check
    // lives here instead of at each caller.
    if (this.#host.startsWith('-')) {
      throw new Error(
        'refusing an ssh destination that starts with "-": ' + JSON.stringify(this.#host)
        + ' — ssh would parse it as an option rather than as a machine',
      )
    }
    return this.#host
  }

  get host() {
    return this.#host
  }

  /** Endpoint description for status output, from whichever backend is answering. */
  async describe() {
    return { backend: this.backend, host: this.#host }
  }

  /**
   * Run one command and collect its output. Control-plane only — probes, `docker ps`,
   * `docker inspect` — never model work, which belongs on a persistent channel.
   *
   * @param command - remote command text (the caller shell-quotes it).
   * @returns exit facts plus decoded stdout and stderr.
   */
  async collect(command, { cwd, timeoutMs = 60000, signal } = {}) {
    const runtime = this.#runtime()
    if (runtime !== undefined) {
      try {
        const outcome = await withTimeout(runtime.exec(command, { cwd, signal }), timeoutMs, 'exec')
        return {
          exitCode: outcome.code ?? outcome.exitCode ?? null,
          stdout: outcome.stdout ?? '',
          stderr: outcome.stderr ?? '',
        }
      } catch (error) {
        return { exitCode: null, stdout: '', stderr: String(error && error.message ? error.message : error) }
      }
    }

    // Consistent with the `ctx.ssh` branch above: a failure to reach the machine is
    // reported as the command's stderr, not thrown at a caller expecting exit facts.
    let destination
    try {
      destination = this.#destination()
    } catch (error) {
      return { exitCode: null, stdout: '', stderr: String(error && error.message ? error.message : error) }
    }
    return this.#spawnCollected(['ssh', ...SSH_BASE, destination, command], { timeoutMs, signal })
  }

  /**
   * Open a long-lived duplex channel running one command, for the resident helper.
   *
   * @param command - the remote command line.
   * @returns stdin writer, stdout/stderr readers, and a settlement promise.
   */
  async open(command, { timeoutMs } = {}) {
    const runtime = this.#runtime()
    if (runtime !== undefined) {
      const client = await withTimeout(runtime.getClient(), timeoutMs, 'connect')
      const stream = await withTimeout(
        new Promise((resolve, reject) => {
          client.exec(command, (error, channel) => (error ? reject(error) : resolve(channel)))
        }),
        timeoutMs,
        'channel open',
      )
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
        // There is no startup timer on this branch, but the CONTRACT is one method either way:
        // a caller that opened a long-lived stream should not have to know which backend it got.
        disarm: () => {},
      }
    }

    return this.#spawnStreaming(['ssh', ...SSH_BASE, this.#destination(), command], timeoutMs)
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
    // A budget for STARTING, not a lifetime limit. `done` settles when the process ends and
    // would otherwise disarm this — which never happens for a stream that is meant to stay up,
    // so an armed timer here kills a working session the moment its budget elapses.
    let timer = timeoutMs ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      done: new Promise((resolve) => {
        // The executor runs synchronously, so clearing the timer at its top would disarm the
        // budget microseconds after arming it. Clearing belongs in the settlement handlers:
        // an ssh session that connects but never speaks must still hit its timeout, or the
        // channel's `connect()` never settles and every later call blocks before arming its
        // own budget.
        const finish = (outcome) => {
          if (timer) clearTimeout(timer)
          timer = null
          this.#childProcesses.delete(child)
          resolve(outcome)
        }
        child.on('error', () => finish({ exitCode: null, signal: null }))
        child.on('close', (code, signal) => finish({ exitCode: code, signal: signal ?? null }))
      }),
      /**
       * Stop counting the startup budget against this process.
       *
       * A caller that opened a LONG-LIVED stream calls this once the stream has proved it is up.
       * Without it, `open(…, { timeoutMs: 30000 })` silently becomes "kill this channel 30
       * seconds after it starts" — which is what it did: the resident helper was guaranteed to
       * die half a minute into every session, taking every in-flight call with it.
       */
      disarm: () => {
        if (timer) clearTimeout(timer)
        timer = null
      },
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

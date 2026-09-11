/**
 * Routing providers for the host-plane `ctx.fs` and `ctx.shell` seams.
 *
 * DSH composes exactly one `ctx.fs` and one `ctx.shell` per process, and both are
 * consumed well beyond the tool layer (the workspace registry, the sidebar file
 * browser, skills). That is why a container cannot simply be "another workspace":
 * the seam has to learn to dispatch.
 *
 * Each router extends the SHIPPED sandboxed implementation and overrides only the
 * methods that must pick a world. Anything outside the container subtree falls
 * through to `super`, so the local branch keeps the deployment's sandbox semantics
 * byte for byte — there is no second copy of that logic to drift.
 *
 * The container is its own isolation boundary, so a container-path mutation is not
 * fenced by the LOCAL sandbox policy: that policy fences local file effects, and a
 * write inside the container is not one. Local paths are still fenced exactly as
 * before.
 *
 * @module dsh-devcontainer/routing
 */
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'

const NL = String.fromCharCode(10)

const stripTrailing = (path) => (path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path)

/** True when `child` is `parent` or lives beneath it. */
function isUnder(parent, child) {
  if (child === parent) return true
  return child.startsWith(parent.endsWith('/') ? parent : parent + '/')
}

/**
 * The two-world path mapping.
 *
 * Two spellings of the same file must resolve to one target: a local stand-in path, and
 * the container path the tools report back. Three rules, in order:
 *
 *  1. **Structural mirror.** When `mountRoot` is configured, `mountRoot + containerPath`
 *     is the local stand-in for `containerPath`. The container path is therefore
 *     recoverable from the mount path alone, so any container directory can become a
 *     workspace without recording a mapping anywhere.
 *  2. **Explicit pair.** `mountPoint` ↔ `containerRoot`, for deployments configured that
 *     way before `mountRoot` existed.
 *  3. **Raw container spelling.** Paths already under a known container root — the primary
 *     `containerRoot`, plus every root derived from a registered mount-root workspace — are
 *     accepted as-is, because that is the spelling the tools hand back and the spelling a
 *     command inside the container prints.
 */
export class Worlds {
  #mountRoot
  #mountPoint
  #containerRoot
  #roots

  constructor(config) {
    this.#mountRoot = config.mountRoot ? stripTrailing(config.mountRoot) : undefined
    this.#mountPoint = config.mountPoint ? stripTrailing(config.mountPoint) : undefined
    this.#containerRoot = stripTrailing(config.containerRoot)
    this.#roots = new Set(this.#usableRoots([this.#containerRoot]))
  }

  /**
   * Drop `/` and empty roots: `containerRoot` defaults to `/`, and accepting it as a known
   * root would classify every absolute path — including ordinary local ones — as a
   * container path.
   */
  #usableRoots(roots) {
    return roots.filter((root) => root !== '/' && root !== '')
  }

  get mountRoot() {
    return this.#mountRoot
  }

  get mountPoint() {
    return this.#mountPoint
  }

  get containerRoot() {
    return this.#containerRoot
  }

  get knownRoots() {
    return [...this.#roots]
  }

  /** Replace the derived root set; the primary `containerRoot` is always retained. */
  setKnownRoots(roots) {
    this.#roots = new Set(this.#usableRoots([this.#containerRoot, ...roots].map(stripTrailing)))
  }

  /** The local stand-in path for a container path, in the structural mirror. */
  toMountRootPath(containerPath) {
    if (this.#mountRoot === undefined) return undefined
    return stripTrailing(this.#mountRoot + containerPath)
  }

  /** Map an absolute path in any accepted spelling to its container path, or undefined for a local path. */
  toContainer(absolute) {
    if (absolute === undefined) return undefined
    const path = stripTrailing(normalize(absolute))

    if (this.#mountRoot !== undefined && isUnder(this.#mountRoot, path)) {
      const rest = path.slice(this.#mountRoot.length)
      return rest === '' ? '/' : rest
    }

    if (this.#mountPoint !== undefined && isUnder(this.#mountPoint, path)) {
      const rest = path.slice(this.#mountPoint.length)
      return stripTrailing(this.#containerRoot + rest)
    }

    for (const root of this.#roots) if (isUnder(root, path)) return path
    return undefined
  }

  isContainer(absolute) {
    return this.toContainer(absolute) !== undefined
  }

  /** Express a container path in the mount spelling, when one is configured. */
  toMount(containerPath) {
    if (this.#mountRoot !== undefined) return stripTrailing(this.#mountRoot + containerPath)
    if (this.#mountPoint !== undefined && isUnder(this.#containerRoot, containerPath)) {
      return this.#mountPoint + containerPath.slice(this.#containerRoot.length)
    }
    return containerPath
  }
}

/**
 * The freshness token for one container target.
 *
 * Reads the size from whichever field the helper op reported: `stat`/`list` answer
 * with `size`, while `write`/`edit` answer with `bytes`. Treating a write's `bytes`
 * as a missing size stamped every fresh write with size 0, so the very next guarded
 * edit compared against the wrong version and reported a false `FS_STALE_VERSION`.
 */
const versionOf = (info) =>
  FsVersion(String(info.mtimeMs ?? 0) + ':' + String(info.size ?? info.bytes ?? 0))

/**
 * Resolve a caller-supplied path to an absolute, lexically normalized path.
 * Module-level rather than a private method: Cordis hands services out behind a
 * Proxy, and a `#private` member cannot be reached through one (the private brand
 * check fails with "Receiver must be an instance of class …").
 */
function absoluteOf(path, opts, cwd) {
  return stripTrailing(normalize(isAbsolute(path) ? path : join(opts?.cwd ?? cwd, path)))
}

async function probeContainer(channel, containerPath, signal, follow = true) {
  const frame = await channel.request({ op: follow ? 'stat' : 'lstat', path: containerPath }, 60000, signal)
  return frame.exists === true ? frame : undefined
}

const applyLiteralEdit = (content, oldString, newString, replaceAll, displayPath) => {
  const parts = content.split(oldString)
  if (parts.length === 1) throw new FsError(`cannot edit "${displayPath}": old_string not found`, 'FS_NOT_FOUND')
  if (parts.length > 2 && !replaceAll) {
    throw new FsError(`cannot edit "${displayPath}": old_string appears ${parts.length - 1} times; pass replace_all`, 'FS_INVALID_ARGS')
  }
  return { content: parts.join(newString), replacements: parts.length - 1 }
}

/**
 * Build the routing filesystem class against one channel.
 * @param channel - the resident container channel.
 * @param worlds - the path mapping.
 */
export function createRoutingFileSystem(channel, worlds) {
  return class RoutingFileSystem extends SandboxedFileSystem {
    async resolve(path, opts) {
      if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
      const containerPath = worlds.toContainer(absoluteOf(path, opts, this.config.cwd))
      if (containerPath === undefined) return super.resolve(path, opts)
      // Lexical canonicalization only: a container round trip per resolve would cost
      // a frame on every read and write, and the container subtree is a bind mount
      // where symlink aliasing is not a practical concern.
      return { targetKey: FsTargetKey(containerPath), displayPath: containerPath }
    }

    processPath(target) {
      const containerPath = worlds.toContainer(String(target.targetKey))
      return containerPath === undefined ? super.processPath(target) : containerPath
    }

    processPathFromHostPath(hostPath) {
      const containerPath = worlds.toContainer(hostPath)
      if (containerPath !== undefined) return containerPath
      return super.processPathFromHostPath(hostPath)
    }

    fileUrl(target) {
      const containerPath = worlds.toContainer(String(target.targetKey))
      return containerPath === undefined ? super.fileUrl(target) : 'file://' + containerPath
    }

    contains(parent, child) {
      const parentPath = worlds.toContainer(String(parent.targetKey))
      const childPath = worlds.toContainer(String(child.targetKey))
      if (parentPath === undefined || childPath === undefined) return super.contains(parent, child)
      const rel = relative(parentPath, childPath)
      return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
    }

    async stat(target, signal) {
      const containerPath = worlds.toContainer(String(target.targetKey))
      if (containerPath === undefined) return super.stat(target, signal)
      if (signal?.aborted) throw new FsError('stat aborted', 'FS_ABORTED')
      const info = await probeContainer(channel, containerPath, signal)
      if (info === undefined) return undefined
      return { version: versionOf(info), type: info.type, size: info.size }
    }

    async lstat(path, opts, signal) {
      const containerPath = worlds.toContainer(absoluteOf(path, opts, this.config.cwd))
      if (containerPath === undefined) return super.lstat(path, opts, signal)
      if (signal?.aborted) throw new FsError('lstat aborted', 'FS_ABORTED')
      const info = await probeContainer(channel, containerPath, signal, false)
      if (info === undefined) return undefined
      return { version: versionOf(info), type: info.type, size: info.size }
    }

    async readText(target, signal) {
      const containerPath = worlds.toContainer(String(target.targetKey))
      if (containerPath === undefined) return super.readText(target, signal)
      const frame = await channel.request({ op: 'read', path: containerPath }, 120000, signal)
      return frame.text
    }

    async streamText(target, signal) {
      const containerPath = worlds.toContainer(String(target.targetKey))
      if (containerPath === undefined) return super.streamText(target, signal)
      const text = await this.readText(target, signal)
      return (async function* stream() {
        yield text
      })()
    }

    async readBytes(target, signal, maxBytes) {
      const containerPath = worlds.toContainer(String(target.targetKey))
      if (containerPath === undefined) return super.readBytes(target, signal, maxBytes)
      const frame = await channel.request({ op: 'read_b64', path: containerPath }, 120000, signal)
      if (maxBytes !== undefined && frame.total > maxBytes) {
        throw new FsError(`cannot read "${target.displayPath}": file exceeds ${maxBytes} bytes`, 'FS_TOO_LARGE')
      }
      return new Uint8Array(Buffer.from(frame.base64, 'base64'))
    }

    async readByteRange(target, range, signal) {
      const containerPath = worlds.toContainer(String(target.targetKey))
      if (containerPath === undefined) return super.readByteRange(target, range, signal)
      const frame = await channel.request(
        { op: 'read_b64', path: containerPath, offset: range.offset, length: range.length },
        120000,
        signal,
      )
      return new Uint8Array(Buffer.from(frame.base64, 'base64'))
    }

    async listDir(target, signal) {
      const containerPath = worlds.toContainer(String(target.targetKey))
      if (containerPath === undefined) return super.listDir(target, signal)
      const frame = await channel.request({ op: 'list', path: containerPath }, 120000, signal)
      return (frame.entries ?? []).map((entry) => ({
        name: entry.name,
        type: entry.type,
        target: {
          targetKey: FsTargetKey(containerPath + '/' + entry.name),
          displayPath: containerPath + '/' + entry.name,
        },
        ...entry.mtimeMs === undefined ? {} : { version: versionOf(entry) },
        ...entry.size === undefined ? {} : { size: entry.size },
      }))
    }

    /**
     * Container writes bypass the local sandbox deliberately: `ctx.sandboxPolicy`
     * fences LOCAL file effects against a local workspace root, and a write inside
     * the container is not a local file effect. The container and the SSH access to
     * it are the boundary.
     */
    async writeText(target, content, expected, signal, _sandboxPolicy) {
      const containerPath = worlds.toContainer(String(target.targetKey))
      if (containerPath === undefined) return super.writeText(target, content, expected, signal, _sandboxPolicy)

      const existing = await probeContainer(channel, containerPath, signal)
      if (existing !== undefined && existing.type !== 'file') {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (expected?.kind === 'replaceIfVersion') {
        if (existing === undefined) throw new FsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
        if (versionOf(existing) !== expected.version) {
          throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
        }
      } else if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
        throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
      }

      let before = null
      if (existing !== undefined && Buffer.byteLength(content, 'utf8') < this.config.diffBasisMaxBytes) {
        try {
          before = (await channel.request({ op: 'read', path: containerPath }, 60000, signal)).text
        } catch {
          before = null
        }
      }

      const frame = await channel.request({ op: 'write', path: containerPath, text: content }, 120000, signal)
      return {
        operation: existing === undefined ? 'create' : 'update',
        version: versionOf(frame),
        before,
        after: content,
      }
    }

    async editText(target, edit, expected, signal, _sandboxPolicy) {
      const containerPath = worlds.toContainer(String(target.targetKey))
      if (containerPath === undefined) return super.editText(target, edit, expected, signal, _sandboxPolicy)

      const existing = await probeContainer(channel, containerPath, signal)
      if (existing === undefined) throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      if (existing.type !== 'file') throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      if (expected !== undefined && versionOf(existing) !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }

      const original = (await channel.request({ op: 'read', path: containerPath }, 60000, signal)).text
      const edited = applyLiteralEdit(original, edit.oldString, edit.newString, edit.replaceAll, target.displayPath)
      const frame = await channel.request({ op: 'write', path: containerPath, text: edited.content }, 120000, signal)
      return { version: versionOf(frame), before: original, after: edited.content }
    }
  }
}

/** Terminate one background container exec; the helper escalates to SIGKILL itself. */
function killExec(channel, execId) {
  channel.request({ op: 'exec_kill', execId }, 30000).catch(() => {})
}

/**
 * Per-channel background-exec fan-out.
 *
 * The listener is registered the FIRST time a container process starts, and it buffers any
 * `execId` it sees — including one whose `exec_start` response has not been read yet.
 *
 * Attaching a listener per `start()` instead loses the leading chunks: the helper writes
 * the response frame and the first chunks into the same TCP read, and the channel's line
 * loop drains every frame in that read before the promise `.then` that would have
 * registered the listener ever runs. The failure is intermittent — it depends on how the
 * kernel coalesces those writes — which is exactly why the streaming assertion exists.
 */
const channelStreams = new WeakMap()

function streamsFor(channel) {
  const existing = channelStreams.get(channel)
  if (existing !== undefined) return existing

  const byId = new Map()
  const state = { byId }
  channelStreams.set(channel, state)

  channel.onEvent((event) => {
    let stream = byId.get(event.execId)
    if (stream === undefined) {
      stream = { out: '', err: '', status: 'running', exitCode: null, signal: null, settled: false, claimed: false, waits: [] }
      byId.set(event.execId, stream)
      // An exec nobody ever claims (its start failed after the helper began) is dropped
      // rather than retained forever.
      const reap = setTimeout(() => {
        if (!stream.claimed) byId.delete(event.execId)
      }, 60000)
      if (typeof reap.unref === 'function') reap.unref()
    }
    if (event.event === 'chunk') {
      if (event.stream === 'stderr') stream.err += event.text
      else stream.out += event.text
      return
    }
    if (event.event === 'exit') {
      stream.status = event.signal ? 'killed' : 'completed'
      stream.exitCode = event.code
      stream.signal = event.signal
      stream.settled = true
      for (const waiter of stream.waits) waiter()
      stream.waits = []
    }
  })

  return state
}

/**
 * Build the routing bash executor against one channel.
 *
 * Read-modify-write for the same reasoning as the filesystem router: the local
 * branch is the shipped sandboxed executor, untouched.
 */
export function createRoutingShellExecutor(channel, worlds) {
  return class RoutingBashExecutor extends SandboxBashExecutor {
    resolve(request) {
      const spec = super.resolve(request)
      const containerPath = worlds.toContainer(spec.workdir)
      if (containerPath !== undefined) spec.workdir = containerPath
      return spec
    }

    async run(spec) {
      if (!worlds.isContainer(spec.workdir)) return super.run(spec)

      const started = Date.now()
      try {
        const frame = await channel.request(
          { op: 'exec', cmd: spec.command, cwd: spec.workdir, timeoutMs: spec.timeoutMs, stdin: spec.stdin },
          spec.timeoutMs + 15000,
          spec.signal,
        )
        return {
          exitCode: frame.code,
          signal: frame.signal ?? null,
          timedOut: false,
          aborted: false,
          timeoutMs: spec.timeoutMs,
          stdout: { text: frame.stdout, truncated: frame.truncated === true },
          stderr: { text: frame.stderr, truncated: frame.truncated === true },
        }
      } catch (error) {
        const message = String(error && error.message ? error.message : error)
        const timedOut = message.includes('timed out')
        const aborted = !timedOut && (spec.signal?.aborted === true || message.includes('cancelled'))
        return {
          exitCode: null,
          signal: aborted ? 'SIGTERM' : null,
          timedOut,
          aborted,
          timeoutMs: spec.timeoutMs,
          stdout: { text: '', truncated: false },
          stderr: { text: message + NL, truncated: false },
        }
      }
    }

    start(spec) {
      if (!worlds.isContainer(spec.workdir)) return super.start(spec)

      const { byId } = streamsFor(channel)
      let execId
      let stream
      let pendingKill = false
      let settle
      const done = new Promise((resolveDone) => { settle = resolveDone })

      const reap = (id) => {
        const timer = setTimeout(() => byId.delete(id), 60000)
        if (typeof timer.unref === 'function') timer.unref()
      }

      // Whatever the dispatcher already buffered for this id is the head of the output;
      // claiming only marks it owned and hands settlement to this handle.
      const claim = (id) => {
        execId = id
        let found = byId.get(id)
        if (found === undefined) {
          found = { out: '', err: '', status: 'running', exitCode: null, signal: null, settled: false, claimed: false, waits: [] }
          byId.set(id, found)
        }
        found.claimed = true
        if (found.settled) settle()
        else found.waits.push(settle)
        reap(id)
        if (pendingKill) killExec(channel, id)
        return found
      }

      channel.request(
        { op: 'exec_start', cmd: spec.command, cwd: spec.workdir, stdin: spec.stdin },
        60000,
      ).then((frame) => {
        stream = claim(frame.execId)
      }).catch((error) => {
        stream = {
          out: '',
          err: String(error && error.message ? error.message : error) + NL,
          status: 'killed',
          exitCode: null,
          signal: null,
          settled: true,
          claimed: true,
          waits: [],
        }
        settle()
      })

      return {
        get status() { return stream === undefined ? 'running' : stream.status },
        get exitCode() { return stream === undefined ? null : stream.exitCode },
        get signal() { return stream === undefined ? null : stream.signal },
        done,
        readOutput() {
          if (stream === undefined) return { delta: '', lossy: false }
          let delta = stream.out
          stream.out = ''
          if (stream.err) {
            delta += (delta ? NL : '') + '[stderr]' + NL + stream.err
            stream.err = ''
          }
          return { delta, lossy: false }
        },
        kill() {
          if (stream !== undefined && stream.status !== 'running') return false
          if (execId === undefined) {
            pendingKill = true
            return true
          }
          killExec(channel, execId)
          return true
        },
      }
    }
  }
}

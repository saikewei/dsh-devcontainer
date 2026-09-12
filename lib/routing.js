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
 * A target key carries its host AND its world, because neither is recoverable from the path
 * alone: with several machines in play, `/etc/hosts` may exist on two of them and inside a
 * container on a third. The tag is `<host>|<world>|<container>` and the separator before the
 * path is a NUL, which cannot occur in any of them.
 */
const KEY_SEP = String.fromCharCode(0)
const TAG_SEP = '|'
const makeKey = (located, path) =>
  located.host + TAG_SEP + located.world + TAG_SEP + (located.container ?? '') + KEY_SEP + path

function parseKey(key) {
  const text = String(key)
  const index = text.indexOf(KEY_SEP)
  if (index === -1) return undefined
  const [host, world, container] = text.slice(0, index).split(TAG_SEP)
  if (host === undefined || world === undefined) return undefined
  return { host, world, container: container === '' ? undefined : container, path: text.slice(index + 1) }
}

/**
 * The world a resolved shell spec belongs to.
 *
 * `resolve` decides it and `run`/`start` consume it, and the spec is the only thing that
 * travels between them. A symbol keeps the marker invisible to the shipped executor, which
 * receives the very same spec on the local branch.
 */
const REMOTE_WORLD = Symbol('dsh-devcontainer.world')

/** The machine, world and container a located path belongs to. */
const targetOf = (located) => ({ host: located.host, world: located.world, container: located.container })

/**
 * The world and path a marked spec runs in, waiting for the decision when `resolve` could not
 * make it.
 *
 * `ShellExecutor.resolve` is synchronous — the shipped tool chains `run(resolve(request))` —
 * so it cannot wait for a lookup that crosses SSH. It marks the spec with the path's LOCAL
 * spelling instead, and the answer is taken here, on the asynchronous side. Deciding from the
 * placeholder in `resolve` is what used to run a container command on the host.
 */
async function specTarget(worlds, spec) {
  const marked = spec[REMOTE_WORLD]
  if (marked.pending === undefined) return marked
  const located = await worlds.ensure(marked.pending)
  marked.pending = undefined
  marked.target = targetOf(located)
  marked.remotePath = located.path
  return marked
}

/** A run result that reports a failure instead of a command's output, in the shipped shape. */
const failedRun = (spec, message) => ({
  exitCode: null,
  signal: null,
  timedOut: false,
  aborted: spec.signal?.aborted === true,
  timeoutMs: spec.timeoutMs,
  stdout: { text: '', truncated: false },
  stderr: { text: message + NL, truncated: false },
})

/**
 * Build the routing bash executor against one channel.
 *
 * Read-modify-write for the same reasoning as the filesystem router: the local
 * branch is the shipped sandboxed executor, untouched.
 */
export function createRoutingShellExecutor(channels, worlds) {
  return class RoutingBashExecutor extends SandboxBashExecutor {
    resolve(request) {
      const spec = super.resolve(request)
      if (typeof spec.workdir !== 'string') return spec
      const located = worlds.locate(spec.workdir)
      if (located === undefined) return spec
      // A mirrored path with no decision yet keeps its LOCAL spelling in `workdir` and is
      // carried as pending: the remote path cannot be known before the world is, and writing
      // the host spelling there would run the command in the wrong place.
      if (located.provisional === true) {
        spec[REMOTE_WORLD] = { pending: spec.workdir }
        return spec
      }
      spec[REMOTE_WORLD] = { target: targetOf(located), remotePath: located.path }
      spec.workdir = located.path
      return spec
    }

    async run(spec) {
      const marked = spec[REMOTE_WORLD]
      if (marked === undefined) return super.run(spec)

      let remote
      let channel
      try {
        remote = await specTarget(worlds, spec)
        channel = channels.forTarget(remote.target)
      } catch (error) {
        return failedRun(spec, String(error && error.message ? error.message : error))
      }
      if (channel === undefined) {
        return failedRun(spec, 'no channel serves ' + remote.target.host + ' (' + remote.target.world + ')')
      }

      try {
        const frame = await channel.request(
          { op: 'exec', cmd: spec.command, cwd: remote.remotePath, timeoutMs: spec.timeoutMs, stdin: spec.stdin },
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
          ...failedRun(spec, message),
          signal: aborted ? 'SIGTERM' : null,
          timedOut,
          aborted,
        }
      }
    }

    start(spec) {
      if (spec[REMOTE_WORLD] === undefined) return super.start(spec)

      let channel
      let execId
      let stream
      let pendingKill = false
      let settle
      const done = new Promise((resolveDone) => { settle = resolveDone })

      // The handle has to come back synchronously, so the world decision, the stream
      // subscription and the request all happen inside this chain. Every accessor already reads
      // whatever state exists, and `status` reporting 'running' until the exec lands is true.
      void (async () => {
        try {
          const remote = await specTarget(worlds, spec)
          channel = channels.forTarget(remote.target)
          if (channel === undefined) {
            throw new Error('no channel serves ' + remote.target.host + ' (' + remote.target.world + ')')
          }

          const { byId } = streamsFor(channel)

          // Drop the entry once it can no longer be needed: an exec nobody claimed, or one
          // whose handle has already settled. A CLAIMED STREAM THAT IS STILL RUNNING must be
          // kept — deleting it orphans the handle, because the dispatcher then builds a fresh
          // object for the same execId on the next event, so the exit lands where no `waits`
          // are registered and `done` never resolves. Re-arm while the process is alive.
          const reap = (id) => {
            const timer = setTimeout(() => {
              const entry = byId.get(id)
              if (entry === undefined) return
              if (entry.claimed && !entry.settled) {
                reap(id)
                return
              }
              byId.delete(id)
            }, 60000)
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

          const frame = await channel.request(
            { op: 'exec_start', cmd: spec.command, cwd: remote.remotePath, stdin: spec.stdin },
            60000,
          )
          stream = claim(frame.execId)
        } catch (error) {
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
        }
      })()

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
/** A target's host, its world there, its path, and the channel that reaches it. */
function remoteOf(channels, target) {
  const parsed = parseKey(target.targetKey)
  if (parsed === undefined) return undefined
  const channel = channels.forTarget({
    host: parsed.host,
    world: parsed.world,
    container: parsed.container,
  })
  return channel === undefined ? undefined : { ...parsed, channel }
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
/**
 * One resolved mapping, in the shape {@link Worlds.locate} reads: the local stand-in, the
 * machine, the world, the container serving it, the path inside that world, and when it was
 * decided.
 */
function normalizeEntry(entry, defaultHost) {
  return {
    localPrefix: stripTrailing(normalize(entry.localPrefix)),
    host: entry.host === undefined || entry.host === '' ? defaultHost : entry.host,
    world: entry.world,
    container: entry.container,
    remotePath: stripTrailing(entry.remotePath),
    at: entry.at === undefined ? Date.now() : entry.at,
  }
}

export class Worlds {
  #mountRoot
  #mountPoint
  #containerRoot
  #roots
  /** Longest-prefix first: local stand-in → decided remote world. */
  #resolved = []
  /**
   * Raw spellings already handed to the model, so they resolve back to their origin.
   * Both carry the MACHINE: with several hosts in play a bare path list would attribute
   * `/srv/app` to whichever machine happened to be the default.
   */
  #hostRoots = []
  /** Extra container roots a deployment names explicitly, on top of the configured one. */
  #seedRoots = []
  /** The host that config-level paths (the mirror, the explicit pair) belong to. */
  #defaultHost
  /** Discovers which world serves one mirrored host folder. See {@link ensure}. */
  #resolver
  /** One in-flight lookup per folder, so two callers' first touch costs one round trip. */
  #pending = new Map()

  constructor(config, resolver) {
    this.#mountRoot = config.mountRoot ? stripTrailing(config.mountRoot) : undefined
    this.#mountPoint = config.mountPoint ? stripTrailing(config.mountPoint) : undefined
    this.#containerRoot = stripTrailing(config.containerRoot)
    this.#defaultHost = config.sshHost
    this.#resolver = resolver
    this.#reindex()
  }

  /**
   * Rebuild everything derived from the resolved mappings: the longest-prefix order, the host
   * roots that make a raw host spelling resolve back to its machine, and the container roots
   * that make a raw container spelling resolve at all.
   *
   * The container roots are DERIVED rather than fed in separately, because a mapping that
   * routes a path into a container while leaving that container's own spelling unrecognized is
   * a one-way door: the tools report container paths, and the model hands them straight back.
   */
  #reindex() {
    this.#resolved.sort((a, b) => b.localPrefix.length - a.localPrefix.length)
    this.#hostRoots = this.#usableRoots(
      this.#resolved
        .filter((entry) => entry.world === 'host')
        .map((entry) => ({ host: entry.host, path: entry.remotePath })),
    )
    this.#roots = this.#usableRoots([
      { host: this.#defaultHost, path: this.#containerRoot },
      ...this.#seedRoots,
      ...this.#resolved
        .filter((entry) => entry.world === 'container')
        .map((entry) => ({ host: entry.host, path: entry.remotePath })),
    ])
  }

  /**
   * Drop `/` and empty roots: `containerRoot` defaults to `/`, and accepting it as a known
   * root would classify every absolute path — including ordinary local ones — as a
   * container path.
   */
  #usableRoots(roots) {
    return roots
      .map((entry) => (typeof entry === 'string' ? { host: this.#defaultHost, path: entry } : entry))
      .map((entry) => ({ host: entry.host, path: stripTrailing(entry.path) }))
      // `/` is never a usable root: `containerRoot` defaults to it, and accepting it would
      // classify every absolute path as a container path.
      .filter((entry) => entry.path !== '/' && entry.path !== '')
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

  /**
   * The container roots this deployment can route, deduplicated.
   *
   * The configured `containerRoot` and the resolved mapping for the same folder are the SAME
   * root, and both are seeded deliberately — the configuration has to answer before any
   * discovery has run. Keeping both is right for `locate`, which only needs a match; reporting
   * both is wrong for a consumer that displays or forwards the list, so the duplicate is
   * collapsed here rather than at each call site.
   */
  get knownRoots() {
    const seen = new Set()
    return this.#roots.filter((entry) => {
      const key = entry.host + '|' + entry.path
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  /**
   * Name container roots a deployment knows about independently of any mapping. The
   * configured `containerRoot` is always retained.
   * @param roots - `{ host, path }` entries, or plain paths for the default host.
   */
  setKnownRoots(roots) {
    this.#seedRoots = roots
    this.#reindex()
  }

  /**
   * Install the resolved workspace mappings — one entry per local stand-in whose remote
   * world has been decided.
   *
   * Resolution happens OUTSIDE the hot path (a registry read plus a container lookup,
   * refreshed on a timer) precisely so that `locate` can stay synchronous: every filesystem
   * and shell call needs a world before it can do anything.
   *
   * @param entries - `{ localPrefix, host, world: 'host'|'container', remotePath }`.
   */
  setResolved(entries) {
    this.#resolved = entries.map((entry) => normalizeEntry(entry, this.#defaultHost))
    this.#reindex()
  }

  get resolved() {
    return this.#resolved
  }

  /**
   * The mapping that decides one path, or undefined when nothing has been resolved for it.
   *
   * Distinct from {@link locate} on purpose: `locate` always answers, falling back to the
   * mirror's structural reading of a path, while `covering` answers only from a decision.
   */
  covering(absolute) {
    const path = stripTrailing(normalize(absolute))
    return this.#resolved.find((entry) => isUnder(entry.localPrefix, path))
  }

  /**
   * Answer a path's world before a call acts on it.
   *
   * `locate` is synchronous because every filesystem call needs a world before it can do
   * anything, and the shipped `ShellExecutor.resolve` is synchronous by contract. A mirrored
   * path that no decision covers yet therefore carries only a PLACEHOLDER answer, and acting
   * on the placeholder is how a container command ends up running on the host: the two
   * spellings differ, so the mistake is silent — right machine, wrong toolchain, wrong paths,
   * and no error to notice.
   *
   * `ensure` is the asynchronous seam those callers use instead. It decides the folder through
   * the resolver — one discovery round trip, cached and single-flighted — and then answers from
   * the settled mapping. Once a folder has been touched, this costs nothing.
   *
   * @param absolute - the path about to be acted on.
   * @param options - `{ maxAgeMs }`: re-decide a folder whose decision is older than this.
   *   Used by the refresh pass, never by a call on the hot path.
   * @returns the settled `locate` result, or undefined for an ordinary local path.
   * @throws when the world cannot be decided — never a guess.
   */
  async ensure(absolute, options) {
    const path = stripTrailing(normalize(absolute))
    const covering = this.covering(path)
    if (covering !== undefined) {
      const stale = options?.maxAgeMs !== undefined
        && covering.localPrefix === path
        && Date.now() - covering.at >= options.maxAgeMs
      if (!stale) return this.locate(absolute)
    }
    const mirrored = this.mirrorPath(path)
    // Not a mirrored path: `locate` already answers structurally from the explicit pair, a
    // known container root, or nothing at all.
    if (mirrored === undefined) return this.locate(absolute)
    if (this.#resolver === undefined) {
      throw new Error(
        'cannot decide whether "' + path + '" is a dev container folder:'
        + ' this resolver was built without a discovery function',
      )
    }
    await this.#settle(mirrored)
    const settled = this.locate(absolute)
    if (settled === undefined || settled.provisional === true) {
      throw new Error('the world for "' + path + '" is still undecided after a lookup')
    }
    return settled
  }

  /** Decide one folder once, sharing the round trip with every concurrent caller. */
  #settle(mirrored) {
    const key = mirrored.host + '|' + mirrored.path
    const inFlight = this.#pending.get(key)
    if (inFlight !== undefined) return inFlight
    const run = (async () => {
      const decision = await this.#resolver(mirrored)
      this.#install(mirrored.host, decision)
    })()
    this.#pending.set(key, run)
    const clear = () => {
      if (this.#pending.get(key) === run) this.#pending.delete(key)
    }
    // A failure is reported to whoever awaited it; a second derived chain keeps the failed
    // promise from also surfacing as an unhandled rejection.
    run.then(clear, clear)
    return run
  }

  /**
   * Install one decided mapping.
   *
   * The decision names the FOLDER it is about, not the path that was asked about, because a
   * decision is only ever as broad as the question that produced it: "which container was
   * built from a folder containing this file" is a statement about that folder, so it is
   * recorded for the folder and covers its whole subtree. A decision that there is NO such
   * container is recorded for exactly the path asked about — claiming a whole directory would
   * shadow a dev-container project inside it, and that project would then never be found.
   *
   * The local prefix is derived structurally — the mirror's first segment is the machine — so
   * an arbitrary host folder becomes routable without being registered anywhere. That is the
   * same rule {@link mirrorPath} uses, and it is why a session can run in a folder the
   * workspace registry has never heard of.
   *
   * Existing mappings are kept, including ones a new decision covers: every mapping comes from
   * the same label index, and the resolver always answers for the MOST SPECIFIC folder above
   * the path, so a mapping deeper in the tree is strictly the better answer for its own
   * subtree. `locate` already takes the longest prefix; throwing the deeper one away would
   * route a nested project through its parent's container.
   */
  #install(host, decision) {
    const folder = decision.folder ?? decision.remotePath
    const localPrefix = this.toMountRootPath(host, folder)
    if (localPrefix === undefined) return
    const entry = normalizeEntry({
      localPrefix,
      host,
      world: decision.world,
      container: decision.container,
      remotePath: decision.remotePath,
    }, this.#defaultHost)
    this.#resolved = this.#resolved.filter((existing) => existing.localPrefix !== entry.localPrefix)
    this.#resolved.push(entry)
    this.#reindex()
  }

  /** The local stand-in for `<host>:<hostPath>`, in the structural mirror. */
  toMountRootPath(host, hostPath) {
    if (this.#mountRoot === undefined) return undefined
    return stripTrailing(this.#mountRoot + '/' + host + hostPath)
  }

  /**
   * The machine and path a local stand-in mirrors, derived structurally — independent of any
   * registry entry or already-resolved world, which is what makes it usable WHILE resolving.
   *
   * The host is the mirror's FIRST segment, so it is recoverable from the stand-in alone:
   * several machines can hold the same path, and the stand-in has to say which one.
   *
   * @returns `{ host, path }`, or undefined when the path is not under the mirror.
   */
  mirrorPath(absolute) {
    if (this.#mountRoot === undefined) return undefined
    const path = stripTrailing(normalize(absolute))
    if (!isUnder(this.#mountRoot, path)) return undefined
    const rest = path.slice(this.#mountRoot.length + 1)
    if (rest === '') return undefined
    const split = rest.indexOf('/')
    if (split === -1) return { host: rest, path: '/' }
    return { host: rest.slice(0, split), path: rest.slice(split) }
  }

  /**
   * Decide which world an absolute path belongs to, and its path within that world.
   *
   * Longest registered prefix first, then the structural mirror, then the explicit container
   * pair, then any raw spelling already handed out. Synchronous by design — see
   * {@link setResolved}.
   *
   * A mirrored path no decision covers yet is answered as `host` and flagged `provisional`.
   * That is a PLACEHOLDER, not a decision: whether the folder is reached on the host or inside
   * the dev container that serves it is a question only discovery answers, and the two
   * spellings differ, so guessing is silent and wrong. Callers that are about to ACT on a path
   * must go through {@link ensure}; callers that are only asking where a path is may read this.
   *
   * @returns `{ world, path, provisional? }`, or undefined when the path is an ordinary local one.
   */
  locate(absolute) {
    if (absolute === undefined) return undefined
    const path = stripTrailing(normalize(absolute))

    for (const entry of this.#resolved) {
      if (!isUnder(entry.localPrefix, path)) continue
      const rest = path.slice(entry.localPrefix.length)
      return {
        host: entry.host,
        world: entry.world,
        container: entry.container,
        path: rest === '' ? entry.remotePath : stripTrailing(entry.remotePath + rest),
      }
    }

    if (this.#mountRoot !== undefined && isUnder(this.#mountRoot, path)) {
      // The mirror's first segment is the machine, so the same derivation mirrorPath uses
      // answers here too — one rule, not two that can drift.
      const mirrored = this.mirrorPath(path)
      if (mirrored !== undefined) {
        return { host: mirrored.host, world: 'host', path: mirrored.path, provisional: true }
      }
    }

    if (this.#mountPoint !== undefined && isUnder(this.#mountPoint, path)) {
      const rest = path.slice(this.#mountPoint.length)
      return { host: this.#defaultHost, world: 'container', path: stripTrailing(this.#containerRoot + rest) }
    }

    for (const root of this.#roots) {
      if (isUnder(root.path, path)) return { host: root.host, world: 'container', path }
    }
    for (const root of this.#hostRoots) {
      if (isUnder(root.path, path)) return { host: root.host, world: 'host', path }
    }
    return undefined
  }

  /** A path's container spelling, or undefined when it is not in the container world. */
  toContainer(absolute) {
    const located = this.locate(absolute)
    return located !== undefined && located.world === 'container' ? located.path : undefined
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

async function probeContainer(remote, signal, follow = true) {
  const frame = await remote.channel.request({ op: follow ? 'stat' : 'lstat', path: remote.path }, 60000, signal)
  return frame.exists === true ? frame : undefined
}

/**
 * Settle a path's world before the filesystem acts on it, translating a failed lookup into the
 * vocabulary the filesystem's own callers switch on.
 *
 * This never falls through to the local branch. A mirrored path whose world could not be
 * decided is an error the caller has to see; silently returning the local file that shares the
 * spelling is exactly the failure this exists to prevent.
 */
async function settledWorld(worlds, absolute) {
  try {
    return await worlds.ensure(absolute)
  } catch (error) {
    throw new FsError(
      'cannot decide where "' + absolute + '" runs: ' + String(error && error.message ? error.message : error),
      'FS_IO_ERROR',
      { cause: error },
    )
  }
}

const applyLiteralEdit = (content, oldString, newString, replaceAll, displayPath) => {
  const parts = content.split(oldString)
  if (parts.length === 1) throw new FsError(`cannot edit "${displayPath}": old_string not found`, 'FS_NOT_FOUND')
  if (parts.length > 2 && !replaceAll) {
    throw new FsError(`cannot edit "${displayPath}": old_string appears ${parts.length - 1} times; pass replace_all`, 'FS_AMBIGUOUS_EDIT')
  }
  return { content: parts.join(newString), replacements: parts.length - 1 }
}

/**
 * Build the routing filesystem class against the per-world channels.
 * @param channels - `{ forTarget(host, world) }`, resolving a target's channel.
 * @param worlds - the world resolver.
 */
export function createRoutingFileSystem(channels, worlds) {
  return class RoutingFileSystem extends SandboxedFileSystem {
    async resolve(path, opts) {
      if (opts?.signal?.aborted) throw new FsError('resolve aborted', 'FS_ABORTED')
      const located = await settledWorld(worlds, absoluteOf(path, opts, this.config.cwd))
      if (located === undefined) return super.resolve(path, opts)
      // Lexical canonicalization only: a round trip per resolve would cost a frame on
      // every read and write, and these subtrees are bind mounts or plain trees where
      // symlink aliasing is not a practical concern.
      return { targetKey: FsTargetKey(makeKey(located, located.path)), displayPath: located.path }
    }

    processPath(target) {
      const remote = remoteOf(channels, target)
      return remote === undefined ? super.processPath(target) : remote.path
    }

    processPathFromHostPath(hostPath) {
      // Synchronous by contract, and used for display mapping (attachments, deliverables)
      // only — never to decide where work runs. A provisional answer is therefore fine here.
      const located = worlds.locate(hostPath)
      return located === undefined ? super.processPathFromHostPath(hostPath) : located.path
    }

    fileUrl(target) {
      const remote = remoteOf(channels, target)
      return remote === undefined ? super.fileUrl(target) : 'file://' + remote.path
    }

    contains(parent, child) {
      const a = remoteOf(channels, parent)
      const b = remoteOf(channels, child)
      // Containment is only meaningful within ONE world: the same path exists in both.
      if (a === undefined || b === undefined || a.host !== b.host || a.world !== b.world || a.container !== b.container) {
        return super.contains(parent, child)
      }
      const rel = relative(a.path, b.path)
      return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
    }

    async stat(target, signal) {
      const remote = remoteOf(channels, target)
      if (remote === undefined) return super.stat(target, signal)
      if (signal?.aborted) throw new FsError('stat aborted', 'FS_ABORTED')
      const info = await probeContainer(remote, signal)
      if (info === undefined) return undefined
      return { version: versionOf(info), type: info.type, size: info.size }
    }

    async lstat(path, opts, signal) {
      const located = await settledWorld(worlds, absoluteOf(path, opts, this.config.cwd))
      if (located === undefined) return super.lstat(path, opts, signal)
      if (signal?.aborted) throw new FsError('lstat aborted', 'FS_ABORTED')
      const remote = remoteOf(channels, { targetKey: makeKey(located, located.path) })
      const info = await probeContainer(remote, signal, false)
      if (info === undefined) return undefined
      return { version: versionOf(info), type: info.type, size: info.size }
    }

    async readText(target, signal) {
      const remote = remoteOf(channels, target)
      if (remote === undefined) return super.readText(target, signal)
      const frame = await remote.channel.request({ op: 'read', path: remote.path }, 120000, signal)
      return frame.text
    }

    async streamText(target, signal) {
      const remote = remoteOf(channels, target)
      if (remote === undefined) return super.streamText(target, signal)
      const text = await this.readText(target, signal)
      return (async function* stream() {
        yield text
      })()
    }

    async readBytes(target, signal, maxBytes) {
      const remote = remoteOf(channels, target)
      if (remote === undefined) return super.readBytes(target, signal, maxBytes)
      const frame = await remote.channel.request({ op: 'read_b64', path: remote.path }, 120000, signal)
      if (maxBytes !== undefined && frame.total > maxBytes) {
        throw new FsError(`cannot read "${target.displayPath}": file exceeds ${maxBytes} bytes`, 'FS_TOO_LARGE')
      }
      return new Uint8Array(Buffer.from(frame.base64, 'base64'))
    }

    async readByteRange(target, range, signal) {
      const remote = remoteOf(channels, target)
      if (remote === undefined) return super.readByteRange(target, range, signal)
      const frame = await remote.channel.request(
        { op: 'read_b64', path: remote.path, offset: range.offset, length: range.length },
        120000,
        signal,
      )
      return new Uint8Array(Buffer.from(frame.base64, 'base64'))
    }

    async listDir(target, signal) {
      const remote = remoteOf(channels, target)
      if (remote === undefined) return super.listDir(target, signal)
      const frame = await remote.channel.request({ op: 'list', path: remote.path }, 120000, signal)
      const base = remote.path === '/' ? '' : remote.path
      return (frame.entries ?? []).map((entry) => ({
        name: entry.name,
        type: entry.type,
        target: {
          // Children stay in the parent's world, so the key keeps carrying it.
          targetKey: FsTargetKey(makeKey(remote, base + '/' + entry.name)),
          displayPath: base + '/' + entry.name,
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
      const remote = remoteOf(channels, target)
      if (remote === undefined) return super.writeText(target, content, expected, signal, _sandboxPolicy)

      const existing = await probeContainer(remote, signal)
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
          before = (await remote.channel.request({ op: 'read', path: remote.path }, 60000, signal)).text
        } catch {
          before = null
        }
      }

      const frame = await remote.channel.request({ op: 'write', path: remote.path, text: content }, 120000, signal)
      return {
        operation: existing === undefined ? 'create' : 'update',
        version: versionOf(frame),
        before,
        after: content,
      }
    }

    async editText(target, edit, expected, signal, _sandboxPolicy) {
      const remote = remoteOf(channels, target)
      if (remote === undefined) return super.editText(target, edit, expected, signal, _sandboxPolicy)

      const existing = await probeContainer(remote, signal)
      if (existing === undefined) throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      if (existing.type !== 'file') throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      if (expected !== undefined && versionOf(existing) !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }

      const original = (await remote.channel.request({ op: 'read', path: remote.path }, 60000, signal)).text
      const edited = applyLiteralEdit(original, edit.oldString, edit.newString, edit.replaceAll, target.displayPath)
      const frame = await remote.channel.request({ op: 'write', path: remote.path, text: edited.content }, 120000, signal)
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


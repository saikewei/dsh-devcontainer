/**
 * Where one session's work should run.
 *
 * The routing decision is per SESSION, not per process: it is read from the session's own
 * `cwd`, so a local session and a container session can coexist in one profile without
 * either knowing about the other. That is what lets this plugin ship with no composition
 * surgery — nothing global is replaced, so nothing global has to be turned off.
 *
 * @module dsh-devcontainer/route
 */
import { foldersContaining } from './discover.js'

/**
 * Build the resolver that decides which WORLD serves one mirrored host path.
 *
 * The question is "which dev container was built from a folder that contains this path", and
 * Docker's `devcontainer.local_folder` label answers it — but only for the exact folder it was
 * asked about. So the whole label index is read once per host and matched locally; asking per
 * path with `--filter` could never answer for a file, and reported "no container", which is
 * how a container path came to be run on the host.
 *
 * Two rules shape the answer:
 *
 *   * A FAILURE IS NOT AN ANSWER. An unreachable machine or an unusable docker leaves the
 *     folder undecided and the error propagates, because "pretend it is the host" is how a
 *     container command ends up running on the NAS — same machine, wrong toolchain, wrong
 *     paths, and nothing to notice.
 *   * "NO CONTAINER" IS AN ANSWER. The path is then genuinely a host path, and the caller
 *     caches it like any other decision.
 *
 * The answer names the FOLDER it is about rather than the path that was asked about: a
 * container serves its whole labelled folder, so recording it for the folder decides every
 * path beneath it at once. A "no container" answer is recorded for the path alone. Both rules
 * live in `Worlds`.
 *
 * @param deps - `{ containersFor, foldersOn, describedOn }`: the per-host discovery handle, and
 *   the two cached-and-single-flighted lookups `(key, run) => Promise`.
 * @returns `async ({ host, path }) => { world, folder, remotePath, container? }`.
 */
export function createFolderResolver({ containersFor, foldersOn, describedOn }) {
  return async function resolveFolder({ host, path }) {
    // Most specific folder first, and the first one whose container can actually serve it
    // wins. A container that does not bind-mount its folder cannot stand in for it, and the
    // answer is then the next folder up — not the host, which this path may well be inside.
    for (const owner of foldersContaining(await foldersOn(host, () => containersFor(host).folders()), path)) {
      const described = await describedOn(host + '|' + owner.name, () => containersFor(host).describe(owner.name))
      if (described === undefined || described.containerPath === undefined) continue
      return {
        world: 'container',
        container: owner.name,
        folder: owner.hostFolder,
        remotePath: described.containerPath,
      }
    }
    return { world: 'host', folder: path, remotePath: path }
  }
}

/** The session cwd this decision is based on, or `undefined` when there is none. */
export function sessionCwdOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/**
 * Classify one absolute path.
 *
 * `worlds.locate` answers only for the two REMOTE worlds; a local path resolves to
 * `undefined`. So the default is local, and only a path inside a configured stand-in is
 * ever sent anywhere.
 *
 * @param worlds - the world resolver.
 * @param path - an absolute path, or `undefined`.
 * @returns `{ kind: 'local' }`, or the located remote target.
 */
export function routeOf(worlds, path) {
  if (typeof path !== 'string' || path === '') return { kind: 'local' }
  const located = worlds.locate(path)
  if (located === undefined) return { kind: 'local' }
  return {
    kind: located.world === 'host' ? 'host' : 'container',
    host: located.host,
    remotePath: located.path,
    container: located.container,
  }
}

/** Whether a session rooted at `cwd` is served by the container/host routers at all. */
export function isRoutedSession(worlds, cwd) {
  return routeOf(worlds, cwd).kind !== 'local'
}

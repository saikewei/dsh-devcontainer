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

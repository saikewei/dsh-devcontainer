/**
 * The host half of the browser API: the workspace picker and the port panel.
 *
 * The shipped "Add workspace" flow asks a directory-flow occupant for one absolute host path
 * and adopts it. This module answers a tiny JSON API over the web server; the client half
 * turns a MACHINE + HOST DIRECTORY the operator picked into the local stand-in path the flow
 * expects.
 *
 * The picker browses hosts, not containers, because that is the direction the causality runs:
 * a host folder is the project, and a dev container is an execution environment derived from
 * it. A folder that carries `.devcontainer` and already has a container is reported with the
 * container path it will be reached at.
 *
 * Routes, under one `prefix` registration so there is a single collision surface:
 *
 *   GET    /dsh-devcontainer/config   what this profile is attached to, and which hosts exist
 *   GET    /dsh-devcontainer/list     one directory level of one host, annotated
 *   POST   /dsh-devcontainer/prepare  materialize the stand-in for a host directory
 *   GET    /dsh-devcontainer/ports    live forwards, and what the container is listening on
 *   POST   /dsh-devcontainer/ports    start a forward
 *   DELETE /dsh-devcontainer/ports    stop one
 *   GET    /dsh-devcontainer/file     one CONTAINER file's text, for the browser's previewer
 *
 * The ports routes live in THIS handler rather than a second registration: `webServer.register`
 * throws on a duplicate `(kind, path)`, and whether an `exact` route would take precedence over
 * this `prefix` one for the same URL is not a documented guarantee — so the prefix stays single
 * and dispatches on method, exactly as it already does.
 *
 * @module dsh-devcontainer/browse
 */
import { mkdir } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { listHosts } from './hosts.js'

const PREFIX = '/dsh-devcontainer'
const MAX_BODY_BYTES = 64 * 1024

/**
 * How much of one container file the previewer will be handed.
 *
 * The helper's `read` op loads the WHOLE file, so without a cap a single click on a 2 GB log
 * would become this process's memory problem. Larger files are served truncated from the head
 * rather than refused: a preview of the first two megabytes is the useful answer for a log,
 * and refusing would make the panel useless exactly where a reader wants it most.
 */
const MAX_FILE_BYTES = 2 * 1024 * 1024

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** A path is meaningful only if it is absolute and free of traversal. */
function normalizeHostPath(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const path = raw.trim()
  if (!path.startsWith('/')) return undefined
  const parts = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return '/' + parts.join('/')
}

const parentOf = (path) => {
  if (path === '/') return undefined
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

/** POSIX single-quote a value that crosses into a remote shell. */
const shq = (value) => "'" + String(value).split("'").join("'\\''") + "'"

/**
 * One POSIX-sh pass that lists a level's directories and marks the ones carrying a
 * `.devcontainer`: `S` for the level itself, then `D<name>` / `F<name>` per child.
 *
 * Deliberately plain shell rather than the resident helper, because the PICKER must work on
 * any machine reachable over ssh. The helper is a Node script, and a host without Node is
 * still a perfectly good place to keep a project.
 */
export function buildListCommand(path) {
  const target = shq(path)
  return [
    'p=' + target,
    '[ -d "$p" ] || exit 3',
    'if [ -d "$p/.devcontainer" ]; then echo S; fi',
    'cd "$p" 2>/dev/null || exit 0',
    'for d in */; do',
    '  [ -d "$d" ] || continue',
    '  n=${d%/}',
    '  case "$n" in .*) continue;; esac',
    '  if [ -d "$n/.devcontainer" ]; then printf "D%s\\n" "$n"; else printf "F%s\\n" "$n"; fi',
    'done',
  ].join('\n')
}

/**
 * Register the host directory API.
 *
 * @param ctx - the plugin's context, used to reach `webServer` and `workspaceRegistry`.
 * @param deps - `{ forTarget, transportFor, containersFor, worlds, cfg }` from the plugin.
 * @returns the route disposer, or undefined when this deployment has no web server.
 */
export function registerContainerApi(ctx, deps) {
  const { forTarget, transportFor, containersFor, worlds, forwards, cfg } = deps
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return undefined

  const browseRoot = cfg.browseRoot !== ''
    ? cfg.browseRoot
    : cfg.hostRoot !== '' ? dirname(cfg.hostRoot) : '/'

  /**
   * The machine a request names, checked against the roster.
   *
   * Whatever arrives here travels two very different roads. It becomes an argv element for the
   * `ssh` binary, where a leading `-` is parsed as an OPTION — `-oProxyCommand=…` runs a local
   * command — and it becomes a path segment under the mirror, where `..` walks out of the mount
   * root and the result is then created with `mkdir`. Neither string is an ssh alias, and the
   * roster already knows which strings are.
   *
   * @returns the host, or `undefined` when it is not one of the machines on offer.
   */
  const pickHost = async (requested) => {
    const wanted = requested === undefined || String(requested) === '' ? cfg.sshHost : String(requested)
    // The roster is the single authority, so an unconfigured `sshHost` is refused here too
    // rather than reaching ssh as an empty destination.
    const roster = await listHosts(cfg)
    return roster.hosts.some((entry) => entry.alias === wanted) ? wanted : undefined
  }

  const describe = async () => {
    const roster = await listHosts(cfg)
    let workspaces = []
    const registry = ctx.get('workspaceRegistry')
    if (registry !== undefined) {
      try {
        workspaces = registry.list().map((workspace) => {
          const located = worlds.locate(workspace.path)
          return {
            title: workspace.title,
            path: workspace.path,
            host: located === undefined ? undefined : located.host,
            world: located === undefined ? 'local' : located.world,
            remotePath: located === undefined ? undefined : located.path,
          }
        })
      } catch {
        workspaces = []
      }
    }
    return {
      defaultHost: roster.defaultHost,
      hosts: roster.hosts,
      hostsError: roster.error,
      sshConfigPath: roster.configPath,
      container: cfg.container,
      hostRoot: cfg.hostRoot,
      containerRoot: cfg.containerRoot,
      mountRoot: cfg.mountRoot,
      mountPoint: cfg.mountPoint,
      browseRoot,
      workspaces,
      // Every root this profile can route into a container. The browser half needs this to
      // decide, synchronously, whether an address names a container file — the same question
      // the `/file` route answers authoritatively, so publishing the list keeps the two from
      // drifting into disagreement.
      knownRoots: worlds.knownRoots,
    }
  }

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const route = url.pathname.slice(PREFIX.length) || '/'

      if (req.method === 'GET' && (route === '/config' || route === '/')) {
        sendJson(res, 200, await describe())
        return
      }

      if (route === '/ports') {
        // No forwards object means this profile mounted the package without a container
        // configured. Say that, rather than answering an empty list the panel would draw as
        // "nothing is forwarding" about a feature that is not there.
        if (forwards === undefined) {
          sendJson(res, 503, { error: 'port forwarding needs `container` set on the devcontainer row' })
          return
        }
        if (req.method === 'GET') {
          const found = await forwards.listening({ host: cfg.sshHost, container: cfg.container })
          sendJson(res, 200, {
            bind: forwards.bind,
            container: cfg.container,
            host: cfg.sshHost,
            forwards: forwards.list(),
            // A probe that failed is reported as a failure. Rendering it as an empty list was
            // the bug this codebase already fixed once for directory listings, and the same
            // reasoning holds here: "nothing is listening" is a wrong answer when the truth is
            // "the machine did not answer".
            listening: found.ok === true ? found.ports : [],
            listeningError: found.ok === true ? undefined : found.error,
            listeningSource: found.ok === true ? found.source : undefined,
            forwardAuto: cfg.forwardAuto,
          })
          return
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req)
          const started = await forwards.add({
            host: body.host === undefined || String(body.host) === '' ? cfg.sshHost : String(body.host),
            container: cfg.container,
            port: Number(body.port),
            localPort: body.localPort === undefined ? undefined : Number(body.localPort),
          })
          if (started.ok !== true) {
            sendJson(res, 400, { error: String(started.error) })
            return
          }
          sendJson(res, 200, { forward: started.forward })
          return
        }
        if (req.method === 'DELETE') {
          const body = await readJsonBody(req)
          const stopped = forwards.remove({
            host: body.host === undefined || String(body.host) === '' ? undefined : String(body.host),
            container: cfg.container,
            port: body.port === undefined ? undefined : Number(body.port),
            localPort: body.localPort === undefined ? undefined : Number(body.localPort),
          })
          if (stopped.ok !== true) {
            sendJson(res, 404, { error: String(stopped.error) })
            return
          }
          sendJson(res, 200, { stopped: stopped.stopped })
          return
        }
        sendJson(res, 405, { error: 'method not allowed: ' + String(req.method) })
        return
      }

      if (req.method === 'GET' && route === '/list') {
        const host = await pickHost(url.searchParams.get('host'))
        if (host === undefined) {
          sendJson(res, 400, { error: 'unknown host: it is not in the roster this profile offers' })
          return
        }
        const path = normalizeHostPath(url.searchParams.get('path') ?? '') ?? browseRoot
        // ONE call per level, and plain shell: a level can hold dozens of directories, and the
        // picker has to work on a machine that has no Node to run the helper with.
        const listed = await transportFor(host).collect(buildListCommand(path), { timeoutMs: 60000 })
        if (listed.exitCode === 3) {
          sendJson(res, 404, { error: 'no such directory on ' + host + ': ' + path })
          return
        }
        if (listed.exitCode !== 0) {
          // ssh itself failed — unreachable machine, rejected key, no route. Rendering that as
          // an EMPTY directory told the operator "nothing here" about a machine the picker
          // never reached, which reads as an answer rather than as a failure.
          sendJson(res, 502, {
            error: listed.stderr.trim()
              || 'could not list ' + path + ' on ' + host + ' (exit ' + String(listed.exitCode) + ')',
          })
          return
        }
        const lines = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
        const entries = lines
          .filter((line) => line.startsWith('D') || line.startsWith('F'))
          .map((line) => {
            const name = line.slice(1)
            return {
              name,
              path: path === '/' ? '/' + name : path + '/' + name,
              hasDevcontainer: line.startsWith('D'),
            }
          })
          .sort((a, b) => a.name.localeCompare(b.name))
        sendJson(res, 200, {
          host,
          path,
          parent: parentOf(path),
          entries,
          root: browseRoot,
          hasDevcontainer: lines.includes('S'),
        })
        return
      }

      if (req.method === 'POST' && route === '/prepare') {
        const body = await readJsonBody(req)
        const host = await pickHost(body.host)
        if (host === undefined) {
          sendJson(res, 400, { error: 'unknown host: it is not in the roster this profile offers' })
          return
        }
        const hostFolder = normalizeHostPath(body.path)
        if (hostFolder === undefined) {
          sendJson(res, 400, { error: 'path must be an absolute host path' })
          return
        }
        const mountPath = worlds.toMountRootPath(host, hostFolder)
        if (mountPath === undefined) {
          sendJson(res, 409, {
            error: 'this profile has no mountRoot, so it cannot express an arbitrary host directory '
              + 'as a workspace. Set `mountRoot`.',
          })
          return
        }
        // Plain shell again, for the same reason as /list.
        const probe = await transportFor(host).collect(
          '[ -d ' + shq(hostFolder) + ' ] && echo yes || echo no',
          { timeoutMs: 30000 },
        )
        if (probe.stdout.trim() !== 'yes') {
          sendJson(res, 404, { error: 'no such directory on ' + host + ': ' + hostFolder })
          return
        }
        // Resolve now so the dialog can say what this workspace will actually be, and so the
        // container is warm in the cache by the time the owner registers the workspace.
        let world = 'host'
        let remotePath = hostFolder
        let container = null
        try {
          const resolved = await containersFor(host).resolve(hostFolder)
          if (resolved.usable === true) {
            world = 'container'
            remotePath = resolved.container.containerPath
            container = { name: resolved.container.name, status: resolved.container.status }
          }
        } catch {
          // Discovery is best-effort here; the refresh loop re-decides within its interval.
        }
        // The registry canonicalizes with node:fs realpath, so the stand-in has to exist.
        await mkdir(mountPath, { recursive: true })
        sendJson(res, 200, {
          host,
          hostFolder,
          mountPath,
          world,
          remotePath,
          container,
          title: basename(hostFolder) || 'host root',
        })
        return
      }

      if (req.method === 'GET' && route === '/file') {
        // The path names its own target. `worlds.locate` already recognizes a raw CONTAINER
        // spelling — the configured `containerRoot` is seeded into its known roots — so the
        // browser never has to name a machine or a container, and nothing it sends has to be
        // trusted. A path that resolves nowhere is an ordinary local one, which this route
        // does not serve: the local filesystem is the one thing the caller can already read.
        const path = normalizeHostPath(url.searchParams.get('path') ?? '')
        if (path === undefined) {
          sendJson(res, 400, { error: 'path must be an absolute path' })
          return
        }
        const located = worlds.locate(path)
        if (located === undefined || located.world !== 'container') {
          sendJson(res, 400, {
            error: located === undefined
              ? 'this profile routes no such path: ' + path
              : path + ' belongs to the machine ' + located.host + ', which has no container for it',
          })
          return
        }
        const channel = forTarget({
          host: located.host,
          world: 'container',
          container: located.container,
        })
        if (channel === undefined) {
          sendJson(res, 502, {
            error: 'no channel serves ' + located.host + ': this profile is not attached to it',
          })
          return
        }
        try {
          // Look before reading. The read op loads the whole file, so the size probe is what
          // keeps one click on an enormous text file from becoming a memory problem here.
          const probe = await channel.request({ op: 'stat', path: located.path }, 60000)
          if (probe.exists !== true) {
            sendJson(res, 404, { error: 'no such file in ' + located.host + ': ' + located.path })
            return
          }
          const truncated = probe.size > MAX_FILE_BYTES
          const frame = truncated
            ? await channel.request(
              { op: 'read_b64', path: located.path, offset: 0, length: MAX_FILE_BYTES },
              120000,
            )
            : await channel.request({ op: 'read', path: located.path }, 120000)
          // The helper refuses a binary only on the whole-file `read`. The windowed path has no
          // such guard, so without this check a 48 MB executable arrives as a 200 and a screenful
          // of mojibake — which is exactly what the shipped binary guard exists to prevent. Same
          // criterion the helper uses (a NUL byte), applied to the window.
          const window = truncated ? Buffer.from(frame.base64, 'base64') : undefined
          if (window !== undefined && window.includes(0)) {
            sendJson(res, 415, { error: 'this file is not text, so the panel does not render it' })
            return
          }
          sendJson(res, 200, {
            host: located.host,
            container: located.container ?? cfg.container,
            path,
            remotePath: located.path,
            // A head slice can end mid-character; the previewer shows the replacement glyph
            // rather than this route pretending the byte boundary is a character boundary.
            text: window === undefined ? frame.text : window.toString('utf8'),
            bytes: truncated ? frame.total : frame.bytes,
            truncated,
          })
        } catch (problem) {
          // The helper refuses binary reads by design. That is a different answer from "the
          // machine did not answer", and the panel has to be able to say which one it got.
          const message = String(problem && problem.message ? problem.message : problem)
          if (message.includes('binary')) {
            sendJson(res, 415, { error: 'this file is not text, so the panel does not render it' })
            return
          }
          if (message.includes('ENOENT') || message.includes('no such file')) {
            sendJson(res, 404, { error: 'no such file in ' + located.host + ': ' + located.path })
            return
          }
          sendJson(res, 502, { error: message })
        }
        return
      }

      sendJson(res, 404, { error: 'no such route: ' + req.method + ' ' + route })
    } catch (error) {
      sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
    }
  }

  return webServer.register({ kind: 'prefix', path: PREFIX, handler })
}

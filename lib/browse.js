/**
 * The host half of the workspace picker.
 *
 * The shipped "Add workspace" flow asks a directory-flow occupant for one absolute host path
 * and adopts it. This module answers a tiny JSON API over the web server; the client half
 * turns a HOST directory the operator picked into the local stand-in path the flow expects.
 *
 * The picker browses the **host**, not the container, because that is the direction the
 * causality runs: the host folder is the project, and a dev container is an execution
 * environment derived from it. A folder that carries `.devcontainer` and already has a
 * container is reported with the container path it will be reached at.
 *
 * Routes, under one `prefix` registration so there is a single collision surface:
 *
 *   GET  /dsh-devcontainer/config   what this profile is attached to
 *   GET  /dsh-devcontainer/list     one host directory level, annotated
 *   POST /dsh-devcontainer/prepare  materialize the stand-in for a host directory
 *
 * @module dsh-devcontainer/browse
 */
import { mkdir } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

const PREFIX = '/dsh-devcontainer'
const MAX_BODY_BYTES = 64 * 1024

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

/** A host path is meaningful only if it is absolute and free of traversal. */
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
 * Register the host directory API.
 *
 * @param ctx - the plugin's context, used to reach `webServer` and `workspaceRegistry`.
 * @param hostChannel - the channel to the remote host itself.
 * @param transport - for the one control-plane `find` per level.
 * @param containers - dev container discovery.
 * @param worlds - the world resolver, so the prepared stand-in is one the routers accept.
 * @param cfg - resolved plugin config.
 * @returns the route disposer, or undefined when this deployment has no web server.
 */
export function registerContainerApi(ctx, hostChannel, transport, containers, worlds, cfg) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return undefined

  const browseRoot = cfg.browseRoot !== ''
    ? cfg.browseRoot
    : cfg.hostRoot !== '' ? dirname(cfg.hostRoot) : '/'

  const describe = async () => {
    let workspaces = []
    const registry = ctx.get('workspaceRegistry')
    if (registry !== undefined) {
      try {
        workspaces = registry.list().map((workspace) => {
          const located = worlds.locate(workspace.path)
          return {
            title: workspace.title,
            path: workspace.path,
            world: located === undefined ? 'local' : located.world,
            remotePath: located === undefined ? undefined : located.path,
          }
        })
      } catch {
        workspaces = []
      }
    }
    return {
      sshHost: cfg.sshHost,
      container: cfg.container,
      hostRoot: cfg.hostRoot,
      containerRoot: cfg.containerRoot,
      mountRoot: cfg.mountRoot,
      mountPoint: cfg.mountPoint,
      // Whether THIS profile routes remote paths. The picker still works without it — the
      // workspace is simply an inert local stand-in there.
      routing: cfg.provideFs === true || cfg.provideShell === true,
      browseRoot,
      workspaces,
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

      if (req.method === 'GET' && route === '/list') {
        const path = normalizeHostPath(url.searchParams.get('path') ?? '') ?? browseRoot
        // Two calls per level rather than one probe per entry: a level can hold dozens of
        // directories and each probe would be a round trip.
        const [listing, devcontainers] = await Promise.all([
          hostChannel.request({ op: 'list', path }, 60000),
          transport.collect('find ' + shq(path) + ' -mindepth 1 -maxdepth 2 -type d -name .devcontainer 2>/dev/null'),
        ])
        const marked = new Set(
          devcontainers.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((found) => dirname(found)),
        )
        const entries = (listing.entries ?? [])
          .filter((entry) => entry.type === 'directory' && !entry.name.startsWith('.'))
          .map((entry) => {
            const child = path === '/' ? '/' + entry.name : path + '/' + entry.name
            return { name: entry.name, path: child, hasDevcontainer: marked.has(child) }
          })
          .sort((a, b) => a.name.localeCompare(b.name))
        sendJson(res, 200, {
          path,
          parent: parentOf(path),
          entries,
          root: browseRoot,
          hasDevcontainer: marked.has(path),
        })
        return
      }

      if (req.method === 'POST' && route === '/prepare') {
        const body = await readJsonBody(req)
        const hostFolder = normalizeHostPath(body.path)
        if (hostFolder === undefined) {
          sendJson(res, 400, { error: 'path must be an absolute host path' })
          return
        }
        const mountPath = worlds.toMountRootPath(hostFolder)
        if (mountPath === undefined) {
          sendJson(res, 409, {
            error: 'this profile has no mountRoot, so it cannot express an arbitrary host directory '
              + 'as a workspace. Set `mountRoot`.',
          })
          return
        }
        const probe = await hostChannel.request({ op: 'stat', path: hostFolder }, 30000)
        if (probe.exists !== true || probe.type !== 'directory') {
          sendJson(res, 404, { error: 'no such directory on ' + cfg.sshHost + ': ' + hostFolder })
          return
        }
        // Resolve now so the dialog can say what this workspace will actually be, and so the
        // container is warm in the cache by the time the owner registers the workspace.
        let world = 'host'
        let remotePath = hostFolder
        let container = null
        try {
          const resolved = await containers.resolve(hostFolder)
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
          hostFolder,
          mountPath,
          world,
          remotePath,
          container,
          title: basename(hostFolder) || 'host root',
        })
        return
      }

      sendJson(res, 404, { error: 'no such route: ' + req.method + ' ' + route })
    } catch (error) {
      sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
    }
  }

  return webServer.register({ kind: 'prefix', path: PREFIX, handler })
}

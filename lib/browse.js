/**
 * The host half of the container workspace picker.
 *
 * The shipped "Add workspace" flow asks a directory-flow occupant for one absolute host
 * path and adopts it. So this module answers a tiny JSON API over the web server, and the
 * client half (`lib/client.js`) turns a container directory the operator picked into the
 * local stand-in path the flow expects.
 *
 * Routes, all under a single `prefix` registration so there is exactly one collision
 * surface:
 *
 *   GET  /dsh-devcontainer/config   what this profile is attached to
 *   GET  /dsh-devcontainer/list     one container directory level
 *   POST /dsh-devcontainer/prepare  materialize the stand-in for a container directory
 *
 * The server binds loopback by default, which is the same exposure the rest of the UI has.
 *
 * @module dsh-devcontainer/browse
 */
import { mkdir } from 'node:fs/promises'
import { basename } from 'node:path'

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

/** A container path is meaningful only if it is absolute and free of traversal. */
function normalizeContainerPath(raw) {
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

/**
 * Register the container directory API.
 *
 * @param ctx - the plugin's context, used only to reach `webServer` and `workspaceRegistry`.
 * @param channel - the resident container channel.
 * @param worlds - the path mapping, so the prepared stand-in is the one the routers accept.
 * @param cfg - resolved plugin config.
 * @returns the route disposer, or undefined when this deployment has no web server.
 */
export function registerContainerApi(ctx, channel, worlds, cfg) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return undefined

  const describe = async () => {
    let workspaces = []
    const registry = ctx.get('workspaceRegistry')
    if (registry !== undefined) {
      try {
        workspaces = registry
          .list()
          .filter((workspace) => worlds.toContainer(workspace.path) !== undefined)
          .map((workspace) => ({
            title: workspace.title,
            path: workspace.path,
            containerPath: worlds.toContainer(workspace.path),
          }))
      } catch {
        workspaces = []
      }
    }
    return {
      sshHost: cfg.sshHost,
      container: cfg.container,
      containerRoot: cfg.containerRoot,
      mountRoot: cfg.mountRoot,
      mountPoint: cfg.mountPoint,
      // Whether THIS profile routes container paths. The picker still works without it —
      // the workspace is simply an inert local stand-in there.
      routing: cfg.provideFs === true || cfg.provideShell === true,
      browseRoot: cfg.containerRoot === '' ? '/' : cfg.containerRoot,
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
        const requested = normalizeContainerPath(url.searchParams.get('path') ?? '') ?? cfg.containerRoot
        const path = requested === '' ? '/' : requested
        const frame = await channel.request({ op: 'list', path }, 60000)
        const entries = (frame.entries ?? [])
          .filter((entry) => entry.type === 'directory' && !entry.name.startsWith('.'))
          .map((entry) => ({
            name: entry.name,
            path: path === '/' ? '/' + entry.name : path + '/' + entry.name,
          }))
          .sort((a, b) => a.name.localeCompare(b.name))
        sendJson(res, 200, { path, parent: parentOf(path), entries })
        return
      }

      if (req.method === 'POST' && route === '/prepare') {
        const body = await readJsonBody(req)
        const containerPath = normalizeContainerPath(body.path)
        if (containerPath === undefined) {
          sendJson(res, 400, { error: 'path must be an absolute container path' })
          return
        }
        const mountPath = worlds.toMountRootPath(containerPath)
        if (mountPath === undefined) {
          sendJson(res, 409, {
            error: 'this profile has no mountRoot, so it cannot express an arbitrary container directory '
              + 'as a workspace. Set `mountRoot` (and keep `mountPoint` for the primary project).',
          })
          return
        }
        // The registry canonicalizes with node:fs realpath, so refuse a directory the
        // container does not actually have rather than registering a stand-in for nothing.
        const probe = await channel.request({ op: 'stat', path: containerPath }, 30000)
        if (probe.exists !== true || probe.type !== 'directory') {
          sendJson(res, 404, { error: 'no such directory inside the container: ' + containerPath })
          return
        }
        // The stand-in has to exist on disk before the owner adopts it.
        await mkdir(mountPath, { recursive: true })
        sendJson(res, 200, {
          containerPath,
          mountPath,
          title: basename(containerPath) || 'container root',
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

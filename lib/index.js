/**
 * dsh-devcontainer — develop inside a Docker dev container on a remote machine.
 *
 * The plugin owns ONE long-lived SSH connection to the host that runs the container,
 * and inside it ONE resident helper process (`lib/helper.mjs`) that speaks JSON-lines
 * RPC. Every operation is a frame on that channel, which is what makes the capability
 * usable: a naive `ssh host docker exec …` per call costs ~320 ms over a Tailscale
 * link, while a frame on the resident channel costs ~7 ms.
 *
 * ONE mode. Installing the plugin is the whole installation: a session whose cwd falls under
 * the stand-in mirror gets the harness's ORDINARY `bash`, `read`, `write`, `edit`, `glob` and
 * `grep` routed into the container, and a session whose cwd is local is untouched — not
 * "still works", but not reached at all. Nothing global is replaced and no row is disabled,
 * so the plugin is purely additive and uninstalling restores the deployment exactly.
 *
 * The `devc_*` tools are additionally registered for container paths outside the mirror
 * (`/go`, `/usr/local/go`, `/home/vscode`), which the mirror is a HOST view and cannot
 * address. They are an extra, not a mode.
 *
 * The container is the execution world and the isolation boundary. Commands run as
 * whatever user the container runs as, with the container's own toolchain and paths;
 * the harness's local file sandbox does not reach inside it.
 *
 * @module dsh-devcontainer
 */
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { RemoteChannel } from './channel.js'
import { RemoteTransport } from './transport.js'
import { DevContainers } from './discover.js'
import { Worlds } from './routing.js'
import { createFolderResolver } from './route.js'
import { Forwards } from './ports.js'
import { installAgentRouting } from './agent-hook.js'
import { registerContainerApi } from './browse.js'

export const name = 'dsh-devcontainer'

export const inject = ['subprocess', 'tools']

const NL = String.fromCharCode(10)

/**
 * How long a folder's world decision is trusted, and how often the background pass re-reads
 * the workspace registry.
 *
 * Two SSH commands answer one folder (a labelled `docker ps`, then a `docker inspect`), so the
 * decision is deliberately long-lived: a folder that already has a container is never re-asked,
 * and only a folder with NO container is probed again — that is the state that changes when
 * someone opens the project in an editor.
 */
const PROBE_TTL_MS = 10000
const PROBE_INTERVAL_MS = 10000

/**
 * One cached, single-flighted asynchronous answer per key, for a fixed lifetime.
 *
 * A FAILURE IS NEVER CACHED. An unreachable machine settles nothing about where a path runs,
 * so the next caller asks again instead of inheriting a wrong answer for ten seconds — and,
 * because the promise is shared, concurrent askers still cost one round trip.
 *
 * The cache also keeps a value that is legitimately `undefined` (a container that has since
 * been removed): the entry is a wrapper, so "we asked, the answer was nothing" is
 * distinguishable from "we have not asked".
 *
 * Exported because that failure rule is a real guarantee about where work runs, and a
 * guarantee with no test is only a comment.
 */
export function probeCache(ttlMs) {
  const values = new Map()
  const running = new Map()
  return (key, run) => {
    const cached = values.get(key)
    if (cached !== undefined && Date.now() - cached.at < ttlMs) return Promise.resolve(cached.value)
    const inFlight = running.get(key)
    if (inFlight !== undefined) return inFlight
    const promise = Promise.resolve().then(run)
    running.set(key, promise)
    const clear = () => {
      if (running.get(key) === promise) running.delete(key)
    }
    promise.then(
      (value) => {
        values.set(key, { at: Date.now(), value })
        clear()
      },
      clear,
    )
    return promise
  }
}

/**
 * The stand-in every install can use without configuring anything: a directory under the
 * harness home, which is already the place this plugin owns. `DSH_HOME` is read the same way
 * the harness itself reads it.
 */
function defaultMountRoot() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'devcontainer', 'root')
}

const DEFAULT_CONFIG = {
  /**
   * SSH destination, resolved through the user's own ssh config (alias or host).
   *
   * Deliberately empty rather than a plausible-looking alias: a default naming somebody
   * else's machine would send a new installation's commands there. Empty is reported at
   * boot and refused by `devc_status`, so the failure names the missing key.
   */
  sshHost: '',
  /** Container name or id on that host. */
  container: '',
  /** Absolute path inside the container that tools and routed paths default to. */
  containerRoot: '/',
  /** The same directory as the host sees it, reported for orientation only. */
  hostRoot: '',
  /**
   * A LOCAL directory that stands for `containerRoot`. Everything beneath it is
   * executed inside the container, because a
   * DSH workspace must be a real local directory (the registry canonicalizes it with
   * `node:fs` realpath, which never sees the container).
   */
  mountPoint: '',
  /**
   * A LOCAL directory whose subtree MIRRORS the HOST's whole filesystem, with the machine as
   * the first segment: `mountRoot/my-nas/volume1/docker/proj` stands for `/volume1/docker/proj`
   * on `my-nas`. Because the host path is recoverable from the mount path by prefix alone, any
   * host directory can become a workspace without recording a mapping — which is what lets the
   * workspace picker offer directories on any machine. The container a folder belongs to is a
   * separate question, answered from Docker's own labels.
   *
   * `mountPoint` remains the explicit one-to-one pair for the primary project; `mountRoot`
   * is what makes arbitrary host directories addressable. Routing works with either, and
   * with both.
   *
   * Empty means `$DSH_HOME/devcontainer/root`, so a fresh install needs to configure nothing
   * but `sshHost`, `container` and `containerRoot` before routing works.
   */
  mountRoot: '',
  /** Where the workspace picker starts browsing on the host. Defaults to `hostRoot`'s parent. */
  browseRoot: '',
  /**
   * Extra SSH destinations to offer in the picker, alongside the ones parsed out of
   * `~/.ssh/config`. A destination can also be a bare hostname or address.
   */
  extraHosts: [],
  /** The ssh_config file to read. Empty means `~/.ssh/config`. */
  sshConfigPath: '',
  /** Register the `devc_*` tools. */
  tools: true,
  /** Register the `devc_host_*` tools and `devc_containers`: the remote host itself, and its dev containers. */
  hostTools: true,
  /**
   * Register the mount point as a DSH workspace on boot, so the profile needs no manual
   * "Add workspace" step.
   */
  autoWorkspace: false,
  /** Display title for the auto-registered workspace. Defaults to the container root's basename. */
  workspaceTitle: '',
  /** Per-command ceiling when the caller states none. */
  defaultTimeoutMs: 120000,
  /** Ceiling applied to any caller-supplied timeout. */
  maxTimeoutMs: 600000,
  /**
   * Container ports to forward to this machine on boot, so a dev server is reachable without
   * asking again after every restart. Empty means none.
   */
  forward: [],
  /**
   * The local address a forward binds. Loopback by default: binding every interface would
   * publish a container's dev server to the whole network, which is not a default anybody
   * should get by accident.
   */
  forwardBind: '127.0.0.1',
  /**
   * Forward every listening port the container has, as it appears. Off by default — a forward
   * occupies a port on THIS machine, and taking ports nobody asked for is the operator's call.
   */
  forwardAuto: false,
  /** How often the auto-forward poll looks for new ports. */
  forwardIntervalMs: 5000,
}

/**
 * Build the registered tool shape from a compact parameter spec, producing exactly the
 * `{ type, properties, required }` JSON Schema the registry's own `defineTool` produces.
 */
function parameters(spec) {
  const properties = {}
  const required = []
  for (const [key, entry] of Object.entries(spec)) {
    const property = { type: entry.type }
    if (entry.description !== undefined) property.description = entry.description
    properties[key] = property
    if (entry.required === true) required.push(key)
  }
  const schema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  return schema
}

const OUTPUT_TEXT = {
  schema: { type: 'string' },
  render(_args, value) {
    return [{ type: 'text', text: value === undefined ? '' : String(value) }]
  },
}

function registerTools(ctx, channel, cfg) {
  const root = cfg.containerRoot
  const report = (error) =>
    '[dsh-devcontainer error] ' + String(error && error.message ? error.message : error)
    + (channel.lastError ? NL + '[channel] ' + channel.lastError : '')

  const runCommand = async (command, workdir, timeoutMs, signal) => {
    const budget = Math.min(timeoutMs ?? cfg.defaultTimeoutMs, cfg.maxTimeoutMs)
    const frame = await channel.request(
      { op: 'exec', cmd: command, cwd: workdir ?? root, timeoutMs: budget },
      budget + 15000,
      signal,
    )
    const parts = []
    if (frame.stdout) parts.push(frame.stdout)
    if (frame.stderr) parts.push('[stderr]' + NL + frame.stderr)
    if (frame.truncated) parts.push('[output truncated at 1 MiB]')
    if (frame.code !== 0) parts.push('[exit code: ' + String(frame.code) + ']')
    return parts.join(NL) || '[no output, exit code 0]'
  }

  ctx.tools.register({
    name: 'devc_status',
    description:
      'Report the remote dev-container channel: the SSH host, the container, the container working root, '
      + 'and whether the resident channel is live. Call this first when any devc_* call fails.',
    parameters: parameters({}),
    output: OUTPUT_TEXT,
    async execute() {
      const lines = [
        'ssh host      : ' + cfg.sshHost,
        'container     : ' + cfg.container,
        'container root: ' + root,
        cfg.hostRoot ? 'host path     : ' + cfg.hostRoot + ' (bind-mounted to the container root)' : '',
        cfg.mountPoint ? 'mount point   : ' + cfg.mountPoint + ' (routed into the container)' : '',
        'channel       : ' + (channel.connected ? 'connected' : 'idle (connects on first use)'),
      ].filter(Boolean)
      try {
        const frame = await channel.request({
          op: 'exec',
          cmd: 'hostname; test -f /.dockerenv && echo in_container=yes || echo in_container=no; uname -sm; node -v 2>/dev/null; go version 2>/dev/null',
          cwd: root,
        }, 45000)
        lines.push('', 'live probe:', frame.stdout.trim())
      } catch (error) {
        lines.push('', 'live probe failed: ' + report(error))
      }
      return lines.join(NL)
    },
  })

  ctx.tools.register({
    name: 'devc_exec',
    description:
      'Execute a bash command INSIDE the remote dev container and return its stdout/stderr. This is the '
      + "container's real development shell, with its own toolchain and paths. Each call runs in a fresh "
      + 'shell, so pass workdir instead of using cd. Non-zero exits are reported as [exit code: N]. '
      + 'The container is the isolation boundary: the local file sandbox does not apply inside it.',
    parameters: parameters({
      command: { type: 'string', required: true, description: 'The bash command to run inside the container.' },
      workdir: { type: 'string', description: 'Working directory inside the container. Defaults to ' + root + '.' },
      timeoutMs: { type: 'number', description: 'Kill the command after this many milliseconds.' },
    }),
    output: OUTPUT_TEXT,
    async execute(args, exec) {
      try {
        return await runCommand(
          String(args.command),
          args.workdir === undefined ? undefined : String(args.workdir),
          args.timeoutMs === undefined ? undefined : Number(args.timeoutMs),
          exec && exec.signal,
        )
      } catch (error) {
        return report(error)
      }
    },
  })

  ctx.tools.register({
    name: 'devc_read',
    description:
      'Read a UTF-8 text file inside the remote dev container and return line-numbered content. '
      + 'Use container paths (for example ' + root + '/go.mod). Binary files are refused.',
    parameters: parameters({
      path: { type: 'string', required: true, description: 'Absolute path inside the container.' },
      offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
      limit: { type: 'number', description: 'Maximum number of lines to return. Defaults to 2000.' },
    }),
    output: OUTPUT_TEXT,
    async execute(args, exec) {
      try {
        const frame = await channel.request(
          { op: 'read', path: String(args.path) },
          60000,
          exec && exec.signal,
        )
        const all = String(frame.text).split(NL)
        const offset = args.offset === undefined ? 1 : Math.max(1, Number(args.offset))
        const limit = args.limit === undefined ? 2000 : Math.max(1, Number(args.limit))
        const window = all.slice(offset - 1, offset - 1 + limit)
        const width = String(offset + window.length - 1).length
        const body = window
          .map((line, index) => String(offset + index).padStart(width, ' ') + String.fromCharCode(9) + line)
          .join(NL)
        const more = offset - 1 + window.length < all.length
          ? NL + '[... truncated at line ' + String(offset + window.length) + '; pass offset to continue]'
          : ''
        return String(frame.bytes) + ' bytes, ' + String(all.length) + ' lines total' + NL + body + more
      } catch (error) {
        return report(error)
      }
    },
  })

  ctx.tools.register({
    name: 'devc_write',
    description:
      'Create or fully replace a UTF-8 text file inside the remote dev container. The write is atomic '
      + '(temp file plus rename) and missing parent directories are created.',
    parameters: parameters({
      path: { type: 'string', required: true, description: 'Absolute path inside the container.' },
      content: { type: 'string', required: true, description: 'Full UTF-8 text content to write.' },
    }),
    output: OUTPUT_TEXT,
    async execute(args, exec) {
      try {
        const frame = await channel.request(
          { op: 'write', path: String(args.path), text: String(args.content) },
          60000,
          exec && exec.signal,
        )
        return 'wrote ' + String(frame.bytes) + ' bytes to ' + String(args.path)
      } catch (error) {
        return report(error)
      }
    },
  })

  ctx.tools.register({
    name: 'devc_edit',
    description:
      'Edit a file inside the remote dev container by replacing literal text. old_string must match exactly '
      + 'once unless replace_all is true.',
    parameters: parameters({
      path: { type: 'string', required: true, description: 'Absolute path inside the container.' },
      old_string: { type: 'string', required: true, description: 'Literal text to replace.' },
      new_string: { type: 'string', required: true, description: 'Literal replacement text; empty deletes the match.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence. Defaults to false.' },
    }),
    output: OUTPUT_TEXT,
    async execute(args, exec) {
      try {
        const frame = await channel.request({
          op: 'edit',
          path: String(args.path),
          old: String(args.old_string),
          new: String(args.new_string),
          replaceAll: args.replace_all === true,
        }, 60000, exec && exec.signal)
        return 'applied ' + String(frame.replacements) + ' replacement(s) in ' + String(args.path)
      } catch (error) {
        return report(error)
      }
    },
  })

  ctx.tools.register({
    name: 'devc_ls',
    description: 'List the direct children of a directory inside the remote dev container, with type and size.',
    parameters: parameters({
      path: { type: 'string', required: true, description: 'Absolute directory path inside the container.' },
    }),
    output: OUTPUT_TEXT,
    async execute(args, exec) {
      try {
        const frame = await channel.request(
          { op: 'list', path: String(args.path) },
          60000,
          exec && exec.signal,
        )
        const entries = frame.entries ?? []
        if (entries.length === 0) return '[empty directory]'
        return entries
          .map((entry) => {
            const marker = entry.type === 'directory' ? 'd' : entry.type === 'file' ? '-' : '?'
            const size = entry.type === 'file' ? String(entry.size) + 'b' : '-'
            return marker + ' ' + size.padStart(10, ' ') + '  ' + entry.name
          })
          .join(NL)
      } catch (error) {
        return report(error)
      }
    },
  })

  ctx.tools.register({
    name: 'devc_grep',
    description:
      'Search file contents inside the remote dev container with an extended regular expression, returning '
      + 'matching lines with file names and line numbers. Capped at 250 matching lines; narrow the path or '
      + 'include filter when that cap is hit.',
    parameters: parameters({
      pattern: { type: 'string', required: true, description: 'POSIX extended regular expression (grep -E).' },
      path: { type: 'string', description: 'Directory or file inside the container. Defaults to ' + root + '.' },
      include: { type: 'string', description: 'One glob filter for which files to search, for example *.go.' },
    }),
    output: OUTPUT_TEXT,
    async execute(args, exec) {
      try {
        const frame = await channel.request({
          op: 'grep',
          pattern: String(args.pattern),
          path: args.path === undefined ? root : String(args.path),
          include: args.include === undefined ? undefined : String(args.include),
          cwd: root,
        }, 120000, exec && exec.signal)
        // A search that never ran — a bad pattern, a directory that is gone — now says so,
        // instead of arriving as an empty result the caller renders as "the pattern is
        // absent", which is a wrong answer rather than a missing one.
        if (frame.ok === false) return report(new Error(String(frame.error ?? 'the grep search did not run')))
        return String(frame.text ?? '').trim() || '[no matches]'
      } catch (error) {
        return report(error)
      }
    },
  })

  ctx.tools.register({
    name: 'devc_glob',
    description:
      'Find files inside the remote dev container by bash glob pattern with globstar enabled, for example '
      + '**/*.go or cmd/**/*.go. Returns matching file paths only, capped at 200, resolved against workdir.',
    parameters: parameters({
      pattern: { type: 'string', required: true, description: 'Bash glob pattern, for example **/*.go.' },
      workdir: { type: 'string', description: 'Directory the pattern resolves against inside the container. Defaults to ' + root + '.' },
    }),
    output: OUTPUT_TEXT,
    async execute(args, exec) {
      try {
        const frame = await channel.request({
          op: 'glob',
          pattern: String(args.pattern),
          cwd: args.workdir === undefined ? root : String(args.workdir),
        }, 120000, exec && exec.signal)
        // A search that never ran — a bad pattern, a directory that is gone — now says so,
        // instead of arriving as an empty result the caller renders as "the pattern is
        // absent", which is a wrong answer rather than a missing one.
        if (frame.ok === false) return report(new Error(String(frame.error ?? 'the glob search did not run')))
        return String(frame.text ?? '').trim() || '[no matches]'
      } catch (error) {
        return report(error)
      }
    },
  })
}

/**
 * The host half of the SSH foundation: run commands and touch files on the remote machine
 * itself, and find the dev containers it hosts.
 *
 * Deliberately a smaller surface than the container tools. The container is where
 * development happens; the host is where you look at what exists and decide what to attach
 * to. Duplicating all eight file tools for a machine you mostly read would be noise.
 */
function registerHostTools(ctx, forTarget, containersFor, cfg) {
  const hostRoot = cfg.hostRoot || '/'
  /** The machine a call names, or the configured default. */
  const pickHost = (requested) => (requested === undefined || String(requested) === '' ? cfg.sshHost : String(requested))
  const channelFor = (requested) => forTarget({ host: pickHost(requested), world: 'host' })
  const report = (channel) => (error) =>
    '[dsh-devcontainer error] ' + String(error && error.message ? error.message : error)
    + (channel.lastError ? NL + '[host channel ' + channel.config.sshHost + '] ' + channel.lastError : '')

  const HOST_PARAM = { type: 'string', description: 'SSH destination to act on — an alias from your ~/.ssh/config. Defaults to ' + cfg.sshHost + '.' }

  ctx.tools.register({
    name: 'devc_host_exec',
    description:
      'Execute a bash command on the REMOTE HOST that runs the dev container — not inside the container. '
      + 'Use it to inspect the machine: list directories, read its docker state, check what a project '
      + 'directory contains. The transport is your own ssh configuration, so aliases, keys and jump '
      + 'hosts behave exactly as in your terminal.',
    parameters: parameters({
      command: { type: 'string', required: true, description: 'The bash command to run on the remote host.' },
      host: HOST_PARAM,
      workdir: { type: 'string', description: 'Working directory on the host. Defaults to ' + hostRoot + '.' },
      timeoutMs: { type: 'number', description: 'Kill the command after this many milliseconds.' },
    }),
    output: OUTPUT_TEXT,
    async execute(args, exec) {
      try {
        const channel = channelFor(args.host)
        const budget = Math.min(args.timeoutMs === undefined ? cfg.defaultTimeoutMs : Number(args.timeoutMs), cfg.maxTimeoutMs)
        const frame = await channel.request({
          op: 'exec',
          cmd: String(args.command),
          cwd: args.workdir === undefined ? hostRoot : String(args.workdir),
          timeoutMs: budget,
        }, budget + 15000, exec && exec.signal)
        const parts = []
        if (frame.stdout) parts.push(frame.stdout)
        if (frame.stderr) parts.push('[stderr]' + NL + frame.stderr)
        if (frame.truncated) parts.push('[output truncated at 1 MiB]')
        if (frame.code !== 0) parts.push('[exit code: ' + String(frame.code) + ']')
        return parts.join(NL) || '[no output, exit code 0]'
      } catch (error) {
        return report(channelFor(args.host))(error)
      }
    },
  })

  ctx.tools.register({
    name: 'devc_host_read',
    description:
      'Read a UTF-8 text file on the remote host, with line numbers. Host paths, not container paths — '
      + 'for a file inside the container use `devc_read` instead.',
    parameters: parameters({
      path: { type: 'string', required: true, description: 'Absolute path on the remote host.' },
      host: HOST_PARAM,
      offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
      limit: { type: 'number', description: 'Maximum number of lines to return. Defaults to 2000.' },
    }),
    output: OUTPUT_TEXT,
    async execute(args, exec) {
      try {
        const frame = await channelFor(args.host).request({ op: 'read', path: String(args.path) }, 60000, exec && exec.signal)
        const all = String(frame.text).split(NL)
        const offset = args.offset === undefined ? 1 : Math.max(1, Number(args.offset))
        const limit = args.limit === undefined ? 2000 : Math.max(1, Number(args.limit))
        const window = all.slice(offset - 1, offset - 1 + limit)
        const width = String(offset + window.length - 1).length
        const body = window
          .map((line, index) => String(offset + index).padStart(width, ' ') + String.fromCharCode(9) + line)
          .join(NL)
        const more = offset - 1 + window.length < all.length
          ? NL + '[... truncated at line ' + String(offset + window.length) + '; pass offset to continue]'
          : ''
        return String(frame.bytes) + ' bytes, ' + String(all.length) + ' lines total' + NL + body + more
      } catch (error) {
        return report(error)
      }
    },
  })

  ctx.tools.register({
    name: 'devc_host_write',
    description: 'Create or fully replace a UTF-8 text file on the remote host. The write is atomic and missing parent directories are created.',
    parameters: parameters({
      path: { type: 'string', required: true, description: 'Absolute path on the remote host.' },
      content: { type: 'string', required: true, description: 'Full UTF-8 text content to write.' },
      host: HOST_PARAM,
    }),
    output: OUTPUT_TEXT,
    async execute(args, exec) {
      try {
        const frame = await channelFor(args.host).request(
          { op: 'write', path: String(args.path), text: String(args.content) },
          60000,
          exec && exec.signal,
        )
        return 'wrote ' + String(frame.bytes) + ' bytes to ' + String(args.path)
      } catch (error) {
        return report(error)
      }
    },
  })

  ctx.tools.register({
    name: 'devc_host_ls',
    description: 'List the direct children of a directory on the remote host, with type and size.',
    parameters: parameters({
      path: { type: 'string', required: true, description: 'Absolute directory path on the remote host.' },
      host: HOST_PARAM,
    }),
    output: OUTPUT_TEXT,
    async execute(args, exec) {
      try {
        const frame = await channelFor(args.host).request({ op: 'list', path: String(args.path) }, 60000, exec && exec.signal)
        const entries = frame.entries ?? []
        if (entries.length === 0) return '[empty directory]'
        return entries
          .map((entry) => {
            const marker = entry.type === 'directory' ? 'd' : entry.type === 'file' ? '-' : '?'
            const size = entry.type === 'file' ? String(entry.size) + 'b' : '-'
            return marker + ' ' + size.padStart(10, ' ') + '  ' + entry.name
          })
          .join(NL)
      } catch (error) {
        return report(error)
      }
    },
  })

  ctx.tools.register({
    name: 'devc_containers',
    description:
      'Dev containers on the remote host. Without `folder`, lists every container created from a '
      + '.devcontainer, with the host folder it belongs to and the container path that folder is mounted '
      + 'at. With `folder`, answers for one host directory: whether it carries a .devcontainer, whether a '
      + 'container exists for it, and whether that container can serve as its execution world. This is how '
      + 'a host directory becomes a container path — no devcontainer build is involved.',
    parameters: parameters({
      folder: { type: 'string', description: 'A host directory to resolve. Omit to list every dev container on the host.' },
      host: HOST_PARAM,
      start: { type: 'boolean', description: 'With `folder`, start the container when it exists but is stopped.' },
    }),
    output: OUTPUT_TEXT,
    async execute(args) {
      try {
        const target = pickHost(args.host)
        const containers = containersFor(target)
        if (args.folder === undefined) {
          const found = await containers.list()
          if (found.length === 0) return '[no dev containers on ' + target + ']'
          return found
            .map((entry) =>
              (entry.running ? '● ' : '○ ') + entry.name
              + NL + '    folder    : ' + (entry.hostFolder || '(unlabelled)')
              + NL + '    container : ' + (entry.containerPath ?? '(folder not bind-mounted)')
              + NL + '    status    : ' + entry.status)
            .join(NL)
        }

        const folder = String(args.folder)
        const resolved = await containers.resolve(folder)
        const lines = [
          'folder              : ' + folder,
          '.devcontainer       : ' + (resolved.hasDevcontainerConfig ? 'present' : 'absent'),
        ]
        if (resolved.container === undefined) {
          lines.push('container           : none — this folder was never opened as a dev container')
          if (resolved.hasDevcontainerConfig) {
            lines.push('', 'It has a .devcontainer but no container yet. Building one is the devcontainer')
            lines.push('CLI\'s job, not this plugin\'s; open it once in VS Code, or run `devcontainer up`,')
            lines.push('and it will appear here afterwards.')
          }
          return lines.join(NL)
        }
        lines.push('container           : ' + resolved.container.name + '  (' + resolved.container.status + ')')
        lines.push('container path      : ' + (resolved.container.containerPath ?? '(folder not bind-mounted)'))
        if (resolved.container.running !== true && args.start === true) {
          const started = await containers.start(resolved.container.name)
          lines.push('start               : ' + (started.ok ? 'requested' : 'failed — ' + started.message))
        }
        if (resolved.usable !== true) {
          lines.push('', 'This container cannot stand in for that folder: it is not bind-mounted into it.')
        }
        return lines.join(NL)
      } catch (error) {
        return report(error)
      }
    },
  })
}

/**
 * The port-forwarding tools: what the container listens on, and what is already mapped here.
 *
 * Kept apart from `registerTools` because a forward is about the container's NETWORK, while
 * that surface is about its filesystem — and because these three answer one question between
 * them, which is the question an operator actually has when a dev server is running.
 */
function registerPortTools(ctx, forwards, cfg) {
  const host = () => cfg.sshHost
  const container = () => cfg.container

  /** One listening entry as a line the model can read without parsing. */
  const listeningLine = (entry, forwarded) => {
    const where = entry.loopback ? 'loopback' : entry.address
    return '  ' + String(entry.port).padEnd(6)
      + (entry.process === undefined ? '(unknown)' : entry.process).padEnd(18)
      + where.padEnd(16)
      + (forwarded ? 'forwarded' : '')
  }

  ctx.tools.register({
    name: 'devc_ports',
    description:
      'Ports in the remote dev container. Lists what is already forwarded to this machine and '
      + 'what the container is listening on. A forward makes a container port reachable here at '
      + 'http://127.0.0.1:<local port> — including services bound to the container\'s own '
      + 'loopback, which nothing else can reach.',
    parameters: parameters({}),
    output: OUTPUT_TEXT,
    async execute() {
      const lines = ['forwards (' + cfg.forwardBind + '):']
      const active = forwards.list()
      if (active.length === 0) lines.push('  (none)')
      for (const forward of active) {
        lines.push('  ' + forward.localAddress + ' -> ' + forward.container + ':' + String(forward.remotePort)
          + (forward.auto ? '  [auto]' : '')
          + (forward.connections > 0 ? '  (' + String(forward.connections) + ' live)' : ''))
      }

      const found = await forwards.listening({ host: host(), container: container() })
      lines.push('', 'listening in ' + container() + ':')
      if (found.ok !== true) {
        // Reported, never rendered as an empty list: "nothing is listening" and "the probe did
        // not run" are different facts, and printing the first for the second is a wrong answer.
        lines.push('  probe failed: ' + String(found.error))
        return lines.join(NL)
      }
      // The container's own plumbing is not the operator's work.
      const shown = found.ports.filter((entry) => !entry.internal)
      if (shown.length === 0) lines.push('  (nothing listening)')
      for (const entry of shown) {
        lines.push(listeningLine(entry, forwards.has(host(), container(), entry.port)))
      }
      lines.push('', 'Forward one with devc_forward; stop one with devc_unforward.')
      return lines.join(NL)
    },
  })

  ctx.tools.register({
    name: 'devc_forward',
    description:
      'Make a port inside the remote dev container reachable on THIS machine, like an editor\'s '
      + 'port forwarding. The connection is dialled from inside the container, so a server bound '
      + 'to the container\'s own loopback works. Returns the local URL to open.',
    parameters: parameters({
      port: { type: 'number', required: true, description: 'Port inside the container to forward.' },
      localPort: { type: 'number', description: 'Local port to answer on. Defaults to the same number.' },
      host: { type: 'string', description: 'SSH destination, when not the configured one.' },
    }),
    output: OUTPUT_TEXT,
    async execute(args) {
      const target = args.host === undefined || String(args.host) === '' ? host() : String(args.host)
      const started = await forwards.add({
        host: target,
        container: container(),
        port: Number(args.port),
        localPort: args.localPort === undefined ? undefined : Number(args.localPort),
      })
      if (started.ok !== true) return '[dsh-devcontainer error] ' + String(started.error)
      const forward = started.forward
      return 'forwarding ' + forward.url + '  ->  ' + forward.container + ':' + String(forward.remotePort)
        + (forward.substituted
          ? NL + '(local port ' + String(args.localPort ?? args.port) + ' was already taken here, so this answers on '
            + String(forward.localPort) + ')'
          : '')
    },
  })

  ctx.tools.register({
    name: 'devc_unforward',
    description: 'Stop a port forward started with devc_forward and release its local port.',
    parameters: parameters({
      port: { type: 'number', description: 'Container port whose forward should stop.' },
      localPort: { type: 'number', description: 'Local port to release instead, when the two differ.' },
    }),
    output: OUTPUT_TEXT,
    async execute(args) {
      if (args.port === undefined && args.localPort === undefined) {
        return '[dsh-devcontainer error] name the forward by `port` or by `localPort`'
      }
      const stopped = forwards.remove({
        host: host(),
        container: container(),
        port: args.port === undefined ? undefined : Number(args.port),
        localPort: args.localPort === undefined ? undefined : Number(args.localPort),
      })
      if (stopped.ok !== true) return '[dsh-devcontainer error] ' + String(stopped.error)
      return 'stopped ' + stopped.stopped.localAddress + ' -> ' + stopped.stopped.container + ':' + String(stopped.stopped.remotePort)
    },
  })
}

export async function apply(ctx, config) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, config ?? {})
  // One SSH transport, two execution worlds over it. `ctx.ssh` answers when a deployment
  // mounted dsh-ssh's connection owner; otherwise the local ssh binary does.
  // One transport per machine actually in use, created on first reference: a deployment may
  // list a dozen ssh hosts and touch one. `ctx.ssh` answers only for the host it owns.
  const transports = new Map()
  const transportFor = (host) => {
    const name = host === undefined || host === '' ? cfg.sshHost : host
    let found = transports.get(name)
    if (found === undefined) {
      found = new RemoteTransport(ctx, name, cfg.sshHost)
      transports.set(name, found)
    }
    return found
  }
  const containersFor = (host) => new DevContainers(transportFor(host))

  // Channels are per (host, world, container): the container differs per workspace, so it
  // cannot come from config once more than one machine is in play.
  const channels = new Map()
  const forTarget = (target) => {
    if (target === undefined || target.host === undefined || target.host === '' || target.world === undefined) {
      return undefined
    }
    const key = [target.host, target.world, target.container ?? ''].join('|')
    let channel = channels.get(key)
    if (channel === undefined) {
      const channelConfig = target.container === undefined
        ? cfg
        : { ...cfg, container: target.container }
      channel = new RemoteChannel(transportFor(target.host), channelConfig, target.world)
      channels.set(key, channel)
    }
    return channel
  }

  // The container tools address the container configured for the DEFAULT host — the one
  // project this row was set up for. Reaching a DIFFERENT machine is what the host tools and
  // `devc_containers` are for, and the workspace picker is how a second project arrives.
  if (cfg.tools && cfg.container !== '') {
    registerTools(ctx, forTarget({ host: cfg.sshHost, world: 'container', container: cfg.container }), cfg)
  }
  if (cfg.hostTools) registerHostTools(ctx, forTarget, containersFor, cfg)

  // Port forwarding. Independent of the stand-ins: it is about the container's network, not
  // about which directories are routable, so it works in a profile that configured neither.
  const forwards = new Forwards({
    channels: { forTarget },
    bind: cfg.forwardBind,
    onChange: (message) => console.error('dsh-devcontainer: ' + message),
  })
  if (cfg.tools && cfg.container !== '') {
    registerPortTools(ctx, forwards, cfg)
  }
  for (const port of cfg.forward) {
    if (cfg.container === '') break
    const started = await forwards.add({ host: cfg.sshHost, container: cfg.container, port: Number(port) })
    if (started.ok !== true) {
      console.error('dsh-devcontainer: could not forward port ' + String(port) + ': ' + String(started.error))
    }
  }
  if (cfg.forwardAuto && cfg.container !== '') {
    forwards.watch({ host: cfg.sshHost, container: cfg.container, intervalMs: cfg.forwardIntervalMs })
  }
  ctx.effect(() => () => forwards.disposeAll())

  // A stand-in is what makes a path routable AND what the workspace picker offers. `mountRoot`
  // defaults to a directory under the harness home, so a fresh install has one without
  // configuring anything.
  if (cfg.mountRoot === '') cfg.mountRoot = defaultMountRoot()
  const hasStandIn = cfg.mountPoint !== '' || cfg.mountRoot !== ''

  if (hasStandIn) {
    // Both stand-ins must be REAL local directories: a DSH workspace is canonicalized
    // with node:fs realpath, which never sees the container. Creating them here means the
    // row is self-sufficient on a fresh machine.
    for (const directory of [cfg.mountPoint, cfg.mountRoot]) {
      if (directory === '') continue
      try {
        await mkdir(directory, { recursive: true })
      } catch (error) {
        console.error(
          'dsh-devcontainer: could not create ' + directory + ': '
          + String(error && error.message ? error.message : error),
        )
      }
    }

    // The world decision for a mirrored path: one label index per host, the most specific
    // folder above the path that has a container able to serve it, or the host. See
    // `lib/route.js` for the rules and why "no container" and "cannot ask" are different.
    const resolveFolder = createFolderResolver({
      containersFor,
      foldersOn: probeCache(PROBE_TTL_MS),
      describedOn: probeCache(PROBE_TTL_MS),
    })

    const worlds = new Worlds(cfg, resolveFolder)

    {
      // What a routed session's tools dispatch through: the same per-(host, world, container)
      // channel lookup the `devc_*` tools use, so one connection serves both.
      const providerChannels = { forTarget }

      /**
       * Keep the decisions warm for every registered workspace.
       *
       * This is an OPTIMIZATION, not the source of truth: `Worlds.ensure` decides any folder on
       * demand, so nothing about correctness depends on a pass having completed. What the pass
       * buys is latency — a session whose cwd was decided before the model's first call never
       * waits for a lookup — and the ability to notice a folder that gained a container with
       * nobody touching it.
       */
      const refreshWorlds = async () => {
        const registry = ctx.get('workspaceRegistry')
        if (registry === undefined) return
        for (const workspace of registry.list()) {
          const covering = worlds.covering(workspace.path)
          // A folder an ancestor already covers routes through that ancestor; re-deciding it
          // here would only be undone by the ancestor's own pass.
          if (covering !== undefined && covering.localPrefix !== workspace.path) continue
          // A folder that already has a container keeps it: re-probing one costs an SSH round
          // trip and can only confirm the binding. The state worth re-asking about is the
          // OTHER one — a folder with no container, which is what changes when someone opens
          // the project in an editor.
          if (covering !== undefined && covering.world === 'container') continue
          try {
            await worlds.ensure(workspace.path, { maxAgeMs: PROBE_TTL_MS })
          } catch {
            // An unreachable machine is not an error for a background pass: the next tick
            // retries, and a call that actually needs the answer reports it itself.
          }
        }
      }
      ctx.inject(['workspaceRegistry'], (scoped) => {
        refreshWorlds()
        const tick = setInterval(refreshWorlds, PROBE_INTERVAL_MS)
        scoped.effect(() => () => clearInterval(tick))
      })

      // The routing itself: per session, in the agent's own scope. Nothing global is
      // replaced and nothing is disabled, so a session whose cwd is local is untouched and
      // uninstalling restores the deployment exactly.
      await installAgentRouting(ctx, { worlds, channels: providerChannels, cfg })
    }

    // The picker is registered whenever a stand-in exists — NOT only when routing is on,
    // because the profile an operator is actually looking at is often the one without it.
    ctx.effect(() => registerContainerApi(ctx, { forTarget, transportFor, containersFor, worlds, forwards, cfg }))
  }

  if (cfg.autoWorkspace && cfg.mountPoint !== '') {
    // Wait for the registry rather than probing once: it initializes after session
    // persistence, which may land after this plugin's own first pass.
    ctx.inject(['workspaceRegistry'], (scoped) => {
      const title = cfg.workspaceTitle || basename(cfg.containerRoot) || 'dev container'
      scoped.workspaceRegistry
        .create(cfg.mountPoint, title)
        .then((workspace) => {
          console.error('dsh-devcontainer: workspace "' + title + '" ready at ' + cfg.mountPoint)
          return workspace
        })
        .catch((error) => {
          console.error(
            'dsh-devcontainer: could not register the workspace at ' + cfg.mountPoint + ': '
            + String(error && error.message ? error.message : error),
          )
        })
    })
  }

  ctx.effect(() => () => {
    for (const channel of channels.values()) channel.dispose()
    for (const transport of transports.values()) transport.dispose()
  })

  // A row that still carries the shipped placeholders is the first thing a new installation
  // hits, and every tool would otherwise fail later with an ssh message about a host named
  // '' or a container named ''. Say it once, here, where the operator is already looking.
  const unconfigured = [
    cfg.sshHost === '' ? 'sshHost' : '',
    cfg.container === '' ? 'container' : '',
  ].filter(Boolean)

  if (unconfigured.length > 0) {
    // Name what actually changes. A missing `container` means the container tools are never
    // registered at all (`registerTools` below requires one), and in routing mode the
    // container is legitimately resolved per workspace — so this cannot claim they "fail".
    const effect = cfg.sshHost === ''
      ? 'Nothing can reach the machine until you do.'
      : 'The container tools (devc_exec, devc_read, …) are not registered without one;'
        + ' the devc_host_* tools and the workspace picker still work.'
    console.error(
      'dsh-devcontainer: ' + unconfigured.map((key) => '`' + key + '`').join(' and ')
      + ' not configured — set ' + (unconfigured.length > 1 ? 'them' : 'it')
      + ' on the `devcontainer` row of your profile. ' + effect,
    )
  }

  console.error(
    unconfigured.length > 0
      ? 'dsh-devcontainer: loaded but not configured'
      : 'dsh-devcontainer: ready for ' + cfg.sshHost + ':' + cfg.container
        + ' (routing sessions under ' + (cfg.mountRoot || cfg.mountPoint) + ')',
  )}

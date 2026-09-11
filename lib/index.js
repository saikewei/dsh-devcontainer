/**
 * dsh-devcontainer — develop inside a Docker dev container on a remote machine.
 *
 * The plugin owns ONE long-lived SSH connection to the host that runs the container,
 * and inside it ONE resident helper process (`lib/helper.mjs`) that speaks JSON-lines
 * RPC. Every operation is a frame on that channel, which is what makes the capability
 * usable: a naive `ssh host docker exec …` per call costs ~320 ms over a Tailscale
 * link, while a frame on the resident channel costs ~7 ms.
 *
 * Two ways to consume it, both driven by this row's config:
 *
 *   * **Tools** (`tools: true`) — `devc_*` tools that address the container directly
 *     by container path. Purely additive; touches nothing in the harness.
 *   * **Routing** (`provideFs` / `provideShell`) — replace the host-plane `ctx.fs`
 *     and `ctx.shell` providers with routers, so the harness's ORDINARY `bash`,
 *     `read`, `write`, `edit`, `glob` and `grep` operate inside the container for
 *     any path under the configured mount point. This needs `fs-sandbox` and
 *     `bash-sandbox` disabled in the same composition.
 *
 * The container is the execution world and the isolation boundary. Commands run as
 * whatever user the container runs as, with the container's own toolchain and paths;
 * the harness's local file sandbox does not reach inside it.
 *
 * @module dsh-devcontainer
 */
import { mkdir } from 'node:fs/promises'
import { basename } from 'node:path'
import { RemoteChannel } from './channel.js'
import { RemoteTransport } from './transport.js'
import { DevContainers } from './discover.js'
import { Worlds, createRoutingFileSystem, createRoutingShellExecutor } from './routing.js'
import { registerRoutingSearch } from './search.js'
import { registerContainerApi } from './browse.js'

export const name = 'dsh-devcontainer'

export const inject = ['subprocess', 'tools']

const NL = String.fromCharCode(10)

const DEFAULT_CONFIG = {
  /** SSH destination, resolved through the user's own ssh config (alias or host). */
  sshHost: 'nas',
  /** Container name or id on that host. */
  container: '',
  /** Absolute path inside the container that tools and routed paths default to. */
  containerRoot: '/',
  /** The same directory as the host sees it, reported for orientation only. */
  hostRoot: '',
  /**
   * A LOCAL directory that stands for `containerRoot`. Everything beneath it is
   * executed inside the container. Required by `provideFs`/`provideShell`, because a
   * DSH workspace must be a real local directory (the registry canonicalizes it with
   * `node:fs` realpath, which never sees the container).
   */
  mountPoint: '',
  /**
   * A LOCAL directory whose subtree MIRRORS the container's whole filesystem:
   * `mountRoot/workspaces/my-project` stands for `/workspaces/my-project`. Because the
   * container path is recoverable from the mount path by prefix alone, any container
   * directory can become a workspace without recording a mapping — which is what lets the
   * workspace picker offer container directories.
   *
   * `mountPoint` remains the explicit one-to-one pair for the primary project; `mountRoot`
   * is what makes arbitrary container directories addressable. Routing works with either,
   * and with both.
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
  /** Provide the routing `ctx.fs`. Requires `fs-sandbox` disabled in this composition. */
  provideFs: false,
  /** Provide the routing `ctx.shell`. Requires `bash-sandbox` disabled in this composition. */
  provideShell: false,
  /**
   * Register path-routed `glob`/`grep`. Requires the shipped `tool-fs-search` row disabled
   * in this composition: those tools spawn a packaged local ripgrep through `ctx.subprocess`
   * rather than going through `ctx.fs`, so no seam can route them.
   */
  provideSearch: false,
  /** Register a system-prompt section explaining the container to the model. */
  prompt: false,
  /**
   * Register the mount point as a DSH workspace on boot, so the profile needs no manual
   * "Add workspace" step. The workspace registry is shared across profiles under
   * `$DSH_HOME/storages`, so the entry is visible everywhere — it is only *routed* in a
   * profile that enables `provideFs`/`provideShell`.
   */
  autoWorkspace: false,
  /** Display title for the auto-registered workspace. Defaults to the container root's basename. */
  workspaceTitle: '',
  /** Per-command ceiling when the caller states none. */
  defaultTimeoutMs: 120000,
  /** Ceiling applied to any caller-supplied timeout. */
  maxTimeoutMs: 600000,
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
        return String(frame.text).trim() || '[no matches]'
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
        return String(frame.text).trim() || '[no matches]'
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
    + (channel.lastError ? NL + '[host channel ' + channel.host + '] ' + channel.lastError : '')

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
      host: HOST_PARAM,
      host: HOST_PARAM,
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

function registerPrompt(ctx, cfg) {
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt === undefined) {
    console.error('dsh-devcontainer: ctx.systemPrompt unavailable; the container prompt section was not registered')
    return
  }
  systemPrompt.section({
    name: 'devcontainer-environment',
    order: 200,
    text: [
      '## Remote dev container',
      '',
      'Your execution world is a remote machine, not this one. Each workspace resolves to its own',
      'world: a HOST directory, or a Docker dev container derived from it. Nothing here is hardcoded —',
      'a workspace registered under the mirror below carries its own machine in the path.',
      '',
      '- default host: `' + cfg.sshHost + '`',
      cfg.mountPoint ? '- mount point: `' + cfg.mountPoint + '` (a local stand-in for the container root)' : '',
      cfg.containerRoot !== '/' ? '- container root: `' + cfg.containerRoot + '`' : '',
      cfg.mountRoot ? '- mirror: `' + cfg.mountRoot + '/<host>/<host path>` stands for `<host>:<host path>`' : '',
      '',
      'Paths reported back by tools and by commands are container paths — use them directly.',
      'Paths outside the mount point are ordinary local paths and run on this machine.',
    ].filter((line) => line !== '').join(NL),
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

  // Routing needs a stand-in; so does the workspace picker. They are separate concerns: a
  // profile may want to CREATE container workspaces without routing every operation into
  // the container, and the picker reports that distinction to the client.
  const wantsRouting = cfg.provideFs || cfg.provideShell
  const hasStandIn = cfg.mountPoint !== '' || cfg.mountRoot !== ''

  if (wantsRouting && !hasStandIn) {
    console.error(
      'dsh-devcontainer: provideFs/provideShell need `mountPoint` or `mountRoot` — a local directory '
      + 'standing for the container. Routing is disabled.',
    )
  } else if (hasStandIn) {
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

    const worlds = new Worlds(cfg)

    if (wantsRouting) {
      // Every registered mount-root workspace names a container root whose RAW spelling the
      // tools will hand back, so the mapping has to keep accepting it. Re-derived on a timer
      // rather than once, because a workspace can also arrive through the shipped flow.
      const providerChannels = { forTarget }

      /**
       * Decide the world for every registered stand-in.
       *
       * A mirrored workspace is a HOST directory; whether it should be reached on the host
       * or inside a dev container is answered by the discovery chain (folder → label →
       * bind mount). Doing it here, on a timer, is what keeps `Worlds.locate` synchronous
       * on the hot path — every filesystem and shell call needs a world before it can act.
       *
       * The lookup is cached per folder and only retried while it says "no container", so a
       * folder that gains one shows up within a refresh without paying for a probe forever.
       */
      const containerCache = new Map()
      let refreshing = false
      const refreshWorlds = async () => {
        if (refreshing) return
        refreshing = true
        try {
          const registry = ctx.get('workspaceRegistry')
          if (registry === undefined) return
          const entries = []
          for (const workspace of registry.list()) {
            const mirrored = worlds.mirrorPath(workspace.path)
            if (mirrored === undefined) {
              // The explicit pair, or an ordinary local workspace: nothing to look up.
              const located = worlds.locate(workspace.path)
              if (located !== undefined) {
                entries.push({
                  localPrefix: workspace.path,
                  host: located.host,
                  world: located.world,
                  container: located.container,
                  remotePath: located.path,
                })
              }
              continue
            }
            const cacheKey = mirrored.host + '|' + mirrored.path
            let resolved = containerCache.get(cacheKey)
            if (resolved === undefined || resolved.usable !== true) {
              try {
                resolved = await containersFor(mirrored.host).resolve(mirrored.path)
                containerCache.set(cacheKey, resolved)
              } catch {
                resolved = undefined
              }
            }
            if (resolved !== undefined && resolved.usable === true) {
              entries.push({
                localPrefix: workspace.path,
                host: mirrored.host,
                world: 'container',
                container: resolved.container.name,
                remotePath: resolved.container.containerPath,
              })
            } else {
              entries.push({
                localPrefix: workspace.path,
                host: mirrored.host,
                world: 'host',
                remotePath: mirrored.path,
              })
            }
          }
          worlds.setResolved(entries)
          worlds.setKnownRoots(
            entries
              .filter((entry) => entry.world === 'container')
              .map((entry) => ({ host: entry.host, path: entry.remotePath })),
          )
        } catch {
          // A registry or host that is not ready yet is not an error; the next tick retries.
        } finally {
          refreshing = false
        }
      }
      ctx.inject(['workspaceRegistry'], (scoped) => {
        refreshWorlds()
        const tick = setInterval(refreshWorlds, 10000)
        scoped.effect(() => () => clearInterval(tick))
      })

      if (cfg.provideFs) ctx.plugin(createRoutingFileSystem(providerChannels, worlds))
      if (cfg.provideShell) ctx.plugin(createRoutingShellExecutor(providerChannels, worlds))
      if (cfg.provideSearch) registerRoutingSearch(ctx, forTarget, worlds)
      if (cfg.prompt) registerPrompt(ctx, cfg)
    }

    // The picker is registered whenever a stand-in exists — NOT only when routing is on,
    // because the profile an operator is actually looking at is often the one without it.
    ctx.effect(() => registerContainerApi(ctx, { forTarget, transportFor, containersFor, worlds, cfg }))
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

  console.error(
    'dsh-devcontainer: ready for ' + cfg.sshHost + ':' + cfg.container
    + (cfg.provideFs || cfg.provideShell ? ' (routing ' + cfg.mountPoint + ')' : ' (tools only)'),
  )}

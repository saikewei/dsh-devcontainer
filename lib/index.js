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
import { ContainerChannel } from './channel.js'
import { Worlds, createRoutingFileSystem, createRoutingShellExecutor } from './routing.js'
import { registerRoutingSearch } from './search.js'

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
  /** Register the `devc_*` tools. */
  tools: true,
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
      'Your execution world is a Docker dev container on `' + cfg.sshHost + '`, not this machine.',
      'Every `bash`, `read`, `write`, `edit`, `glob` and `grep` call on a path under `' + cfg.mountPoint + '`',
      'runs inside that container, with its own toolchain and its own paths.',
      '',
      '- container root: `' + cfg.containerRoot + '`',
      cfg.hostRoot ? '- host path: `' + cfg.hostRoot + '` (bind-mounted to the container root)' : '',
      '- mount point: `' + cfg.mountPoint + '` (a local stand-in for the container root)',
      '',
      'Paths reported back by tools and by commands are container paths — use them directly.',
      'Paths outside the mount point are ordinary local paths and run on this machine.',
    ].filter((line) => line !== '').join(NL),
  })
}

export async function apply(ctx, config) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, config ?? {})
  const channel = new ContainerChannel(ctx, cfg)

  if (cfg.tools) registerTools(ctx, channel, cfg)

  if (cfg.provideFs || cfg.provideShell) {
    if (cfg.mountPoint === '') {
      console.error(
        'dsh-devcontainer: provideFs/provideShell need `mountPoint` — a local directory standing for the '
        + 'container root. Routing is disabled.',
      )
    } else {
      // The mount point must be a REAL local directory: a DSH workspace is
      // canonicalized with node:fs realpath, which never sees the container. Creating
      // it here means the row is self-sufficient on a fresh machine.
      try {
        await mkdir(cfg.mountPoint, { recursive: true })
      } catch (error) {
        console.error(
          'dsh-devcontainer: could not create the mount point ' + cfg.mountPoint + ': '
          + String(error && error.message ? error.message : error),
        )
      }
      const worlds = new Worlds(cfg)
      if (cfg.provideFs) ctx.plugin(createRoutingFileSystem(channel, worlds))
      if (cfg.provideShell) ctx.plugin(createRoutingShellExecutor(channel, worlds))
      if (cfg.provideSearch) registerRoutingSearch(ctx, channel, worlds)
      if (cfg.prompt) registerPrompt(ctx, cfg)
    }
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

  ctx.effect(() => () => channel.dispose())

  console.error(
    'dsh-devcontainer: ready for ' + cfg.sshHost + ':' + cfg.container
    + (cfg.provideFs || cfg.provideShell ? ' (routing ' + cfg.mountPoint + ')' : ' (tools only)'),
  )}

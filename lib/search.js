/**
 * Path-routed search tools.
 *
 * The shipped `glob` and `grep` (`@deepseek-ai/dsh-tool-fs-search`) do NOT go through
 * `ctx.fs`. They spawn a **packaged ripgrep binary** through `ctx.subprocess` with a plain
 * argv vector — the module says so itself: *"never `ctx.shell`"*. That makes them
 * unroutable from either the filesystem or the shell seam, and in a container profile they
 * fail outright, because the mount point is an empty local directory and ripgrep does not
 * exist inside the container.
 *
 * So routing mode owns these two tools and dispatches on the requested path:
 *
 *   * container world — the container's own `find`/`grep`, through the resident channel.
 *   * local world — the same packaged ripgrep the shipped tool uses, resolved through the
 *     shipped module so the two can never disagree about which binary that is.
 *
 * They are registered on the routed session's own scope, so they shadow the shipped names for
 * that session only. A local session keeps the shipped pair untouched and never reaches here.
 *
 * @module dsh-devcontainer/search
 */
import { isAbsolute, join, normalize } from 'node:path'

const NL = String.fromCharCode(10)
const RG_MAX_BYTES = 1 << 20
const GLOB_CAP = 200
const GREP_CAP = 250

let shippedSearchPromise
function shippedSearch() {
  // `@deepseek-ai/*` resolves from the harness install, so this reaches the very module
  // the profile's own search rows would have used.
  shippedSearchPromise ??= import('@deepseek-ai/dsh-tool-fs-search')
  return shippedSearchPromise
}

const sessionCwd = (exec) => exec?.agent?.session?.header?.cwd ?? process.cwd()

const OUTPUT_TEXT = {
  schema: { type: 'string' },
  render(_args, value) {
    return [{ type: 'text', text: value === undefined ? '' : String(value) }]
  },
}

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

async function runLocalRipgrep(ctx, argv, cwd, timeoutMs) {
  const { resolveRgPath } = await shippedSearch()
  const handle = ctx.subprocess.spawn({
    argv: [await resolveRgPath(), '--no-config', ...argv],
    cwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes: RG_MAX_BYTES }, stderr: { maxBytes: 65536 } },
    graceMs: timeoutMs,
  })
  const outcome = await handle.done
  return {
    code: outcome.exitCode,
    stdout: handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : '',
    stderr: handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : '',
  }
}

/**
 * Register container-aware `glob` and `grep`.
 *
 * Registered on the agent's own scope, so they shadow the shipped `tool-fs-search` names for a
 * routed session only; a local session keeps the shipped pair untouched and this one is never
 * reached.
 */
export function registerRoutingSearch(ctx, forTarget, worlds) {
  const absoluteOf = (path, cwd) => normalize(isAbsolute(path) ? path : join(cwd, path))

  /**
   * Settle the search root's world before ripgrep or a remote search is chosen.
   *
   * `locate` answers a mirrored path with a placeholder host world until something decides it,
   * and a search run against that placeholder hits the empty local stand-in and reports "no
   * matches" — the pattern is absent, says the tool, about a tree it never looked at.
   */
  const settle = async (searchPath) => {
    try {
      return { located: await worlds.ensure(searchPath) }
    } catch (error) {
      return { failure: '[dsh-devcontainer error] ' + String(error && error.message ? error.message : error) }
    }
  }

  ctx.tools.register({
    name: 'glob',
    description:
      'Find files whose paths match a glob pattern. Returns matching file paths, never directories. '
      + 'A pattern with no "/" matches the basename at any depth, so "*" and "*.ts" both search the whole '
      + 'tree; include a separator to anchor the depth. Paths under the dev-container mount point are '
      + 'searched inside the container.',
    parameters: parameters({
      pattern: { type: 'string', required: true, description: 'Glob pattern to match file paths against, e.g. "**/*.ts".' },
      path: { type: 'string', description: 'Directory to search in. Defaults to the session working directory.' },
    }),
    output: OUTPUT_TEXT,
    async execute(args, exec) {
      const cwd = sessionCwd(exec)
      const searchPath = absoluteOf(args.path === undefined ? cwd : String(args.path), cwd)
      const { located, failure } = await settle(searchPath)
      if (failure !== undefined) return failure

      // `locate` answers only for the two REMOTE worlds; a local path resolves to undefined.
      // Anything it places is therefore remote, and ripgrep must not run for it — a mirrored
      // folder with no dev container resolves to world 'host', where bash and read already run,
      // and searching it locally hit the empty stand-in and answered "no matches". `forTarget`
      // picks the matching channel from `located`.
      if (located === undefined) {
        const result = await runLocalRipgrep(
          ctx,
          ['--files', '--glob', String(args.pattern), searchPath],
          cwd,
          20000,
        )
        // ripgrep exits 1 for "nothing matched", which is an answer, not a failure. Treating
        // it as one made every empty glob report `glob search failed: ripgrep exited 1`.
        if (result.code !== 0 && result.code !== 1 && result.stdout.trim() === '') {
          return 'glob search failed: ' + (result.stderr.trim() || 'ripgrep exited ' + String(result.code))
        }
        const paths = result.stdout.split(NL).filter(Boolean)
        if (paths.length === 0) return '[no matches]'
        // Same cap and the same notice as the container branch; they used to differ.
        return paths.slice(0, GLOB_CAP).join(NL)
          + (paths.length > GLOB_CAP ? NL + '[... capped at ' + String(GLOB_CAP) + ' paths]' : '')
      }

      try {
        const frame = await forTarget(located).request({
          op: 'glob',
          pattern: String(args.pattern),
          cwd: located.path,
        }, 90000, exec && exec.signal)
        // The op now reports a search that did not run at all — a bad pattern, a directory
        // that is gone — instead of an empty result, so it has to be read rather than
        // stringified into `undefined`.
        if (frame.ok === false) {
          return '[dsh-devcontainer error] ' + String(frame.error ?? 'the glob search did not run')
        }
        const paths = String(frame.text ?? '').split(NL).filter(Boolean)
        if (paths.length === 0) return '[no matches]'
        const capped = paths.length >= GLOB_CAP
        return paths.join(NL) + (capped ? NL + '[... capped at ' + String(GLOB_CAP) + ' paths]' : '')
      } catch (error) {
        return '[dsh-devcontainer error] ' + String(error && error.message ? error.message : error)
      }
    },
  })

  ctx.tools.register({
    name: 'grep',
    description:
      'Search file contents with a regular expression. Returns matching lines with file names and line '
      + 'numbers, grouped by file. Paths under the dev-container mount point are searched inside the '
      + 'container.',
    parameters: parameters({
      pattern: { type: 'string', required: true, description: 'Regular expression to search for.' },
      path: { type: 'string', description: 'File or directory to search. Defaults to the session working directory.' },
      include: { type: 'string', description: 'One glob filter for which files to search, e.g. "*.ts".' },
    }),
    output: OUTPUT_TEXT,
    async execute(args, exec) {
      const cwd = sessionCwd(exec)
      const searchPath = absoluteOf(args.path === undefined ? cwd : String(args.path), cwd)
      const { located, failure } = await settle(searchPath)
      if (failure !== undefined) return failure
      const include = args.include === undefined ? undefined : String(args.include)

      // `locate` answers only for the two REMOTE worlds; a local path resolves to undefined.
      // Anything it places is therefore remote, and ripgrep must not run for it — a mirrored
      // folder with no dev container resolves to world 'host', where bash and read already run,
      // and searching it locally hit the empty stand-in and answered "no matches". `forTarget`
      // picks the matching channel from `located`.
      if (located === undefined) {
        const argv = ['-n', '--no-heading', '--color', 'never']
        if (include !== undefined) argv.push('--glob', include)
        argv.push('-e', String(args.pattern), searchPath)
        const result = await runLocalRipgrep(ctx, argv, cwd, 20000)
        const text = result.stdout.trim()
        if (text === '') {
          return result.code === 1 ? '[no matches]'
            : 'grep search failed: ' + (result.stderr.trim() || 'ripgrep exited ' + String(result.code))
        }
        const lines = text.split(NL)
        return lines.slice(0, GREP_CAP).join(NL)
          + (lines.length > GREP_CAP ? NL + '[... capped at ' + String(GREP_CAP) + ' matching lines]' : '')
      }

      try {
        const frame = await forTarget(located).request({
          op: 'grep',
          pattern: String(args.pattern),
          path: located.path,
          include,
          cwd: located.path,
        }, 120000, exec && exec.signal)
        if (frame.ok === false) {
          return '[dsh-devcontainer error] ' + String(frame.error ?? 'the grep search did not run')
        }
        const text = String(frame.text ?? '').trim()
        return text === '' ? '[no matches]' : text
      } catch (error) {
        return '[dsh-devcontainer error] ' + String(error && error.message ? error.message : error)
      }
    },
  })
}

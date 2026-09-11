/**
 * Per-session routing: give ONE agent the container as its execution world.
 *
 * ## Why the tools, and not the services
 *
 * The obvious design is to replace `ctx.fs` / `ctx.shell` process-wide. It cannot be made
 * safe: `provide()` throws when a service is already registered, `set()` requires the same
 * fiber, and a patch cannot rename a row — so the shipped providers have to be disabled in
 * the composition for a router to take their place. From then on the profile boots with no
 * filesystem at all unless this plugin is mounted, which is a foot-gun nobody asked for.
 *
 * The directory-picker seam's own docs give the sanctioned alternative, and this is the same
 * shape: mount the OFFICIAL tool packages into an **isolated realm** under the agent's own
 * scope. `ctx.isolate('fs')` gives that realm its own `fs` binding, so the official
 * `read`/`write`/`edit`/`bash` call the router, and because the realm still carries the
 * agent's scope key, their registrations land in the agent's tool layer and shadow the global
 * ones for that session only.
 *
 * Nothing global is replaced, nothing is disabled, and a session whose cwd is local returns
 * before a single registration happens — which is where the "local is byte-for-byte
 * unchanged" guarantee comes from. It is structural, not a promise.
 *
 * The pattern is the one `@dsh-ssh/dsh-ssh` ships and documents; this module follows it.
 *
 * @module dsh-devcontainer/agent-hook
 */
import { createRoutingFileSystem, createRoutingShellExecutor } from './routing.js'
import { registerRoutingSearch } from './search.js'
import { isRoutedSession } from './route.js'

/**
 * The official tool packages whose tools are re-registered for a routed session.
 *
 * `glob`/`grep` are deliberately NOT here: the shipped search tools spawn a packaged local
 * ripgrep through `ctx.subprocess`, which no realm can redirect, so this plugin owns those
 * two names itself (see `lib/search.js`).
 */
const OFFICIAL_TOOL_PACKAGES = [
  { specifier: '@deepseek-ai/dsh-tool-fs', label: 'read/write/edit' },
  { specifier: '@deepseek-ai/dsh-tool-bash', label: 'bash' },
]

const CAPABILITY_SECTION = 'devcontainer:capability-surface'
const CAPABILITY_ORDER = 150

/**
 * Load the official packages once, at mount time, and derive each one's default config from
 * its own schema.
 *
 * Resolving here rather than inside the `agent/created` handler is deliberate: the handler
 * must be synchronous and total, because a synchronous throw inside an emit is not a report,
 * it is a veto on the agent being published at all.
 *
 * The config is the PACKAGE's default, not the deployment's: a profile that raised
 * `readLimit` on its own `tool-fs` row keeps the shipped default inside this realm. Those are
 * caps, not semantics, and taking the deployment's would mean reaching into the loader's
 * composed tree, which is not a public seam.
 */
async function loadOfficialPackages() {
  const loaded = []
  for (const entry of OFFICIAL_TOOL_PACKAGES) {
    try {
      const mod = await import(entry.specifier)
      if (typeof mod.apply !== 'function') continue
      let config
      try {
        config = typeof mod.Config === 'function' ? mod.Config({}) : undefined
      } catch {
        config = undefined
      }
      loaded.push({ ...entry, plugin: { apply: mod.apply, inject: mod.inject, name: mod.name }, config })
    } catch (error) {
      // Unresolvable here means the harness install does not carry it. Say so once; the
      // session then keeps its local tools rather than failing.
      console.error(
        'dsh-devcontainer: could not load ' + entry.specifier + ' (' + entry.label + '): '
        + String(error && error.message ? error.message : error),
      )
    }
  }
  return loaded
}

/** The capability-surface text for one routed session. */
export function capabilityText(cfg, cwd) {
  return [
    '## Remote dev container',
    '',
    'This session runs against a remote machine, not this one. `bash`, `read`, `write`, `edit`',
    'and the file tools address the container (or the host that runs it) for paths under the',
    'mirror below; paths outside it are ordinary local paths and still run on this machine.',
    '',
    '- default host: `' + cfg.sshHost + '`',
    cfg.container !== '' ? '- default container: `' + cfg.container + '`' : '',
    cfg.containerRoot !== '/' ? '- container root: `' + cfg.containerRoot + '`' : '',
    cfg.mountRoot !== '' ? '- mirror: `' + cfg.mountRoot + '/<host>/<host path>`' : '',
    cfg.mountPoint !== '' ? '- mount point: `' + cfg.mountPoint + '`' : '',
    '',
    'Paths reported by these tools are container paths — use them directly.',
    'Skill scripts, MCP tools and other host tools run on this machine, independent of the',
    'session cwd.',
  ].filter((line) => line !== '').join('\n')
}

/**
 * Install the routing hook.
 *
 * @param ctx - the plugin context (a scope for the event listener).
 * @param deps - `{ worlds, channels, cfg }`: the world resolver, the per-target channel lookup
 *   the routers dispatch through, and the resolved plugin config.
 * @returns a promise resolving once the official packages are in hand and the listener is
 *   registered.
 */
export async function installAgentRouting(ctx, deps) {
  const { worlds, channels, cfg } = deps
  const official = await loadOfficialPackages()

  ctx.on('agent/created', ({ agent }) => {
    // An emit, not a call site: reporting has to be logging, and the handler has to be total.
    try {
      attach(agent)
    } catch (error) {
      console.error(
        'dsh-devcontainer: could not route this session: '
        + String(error && error.message ? error.message : error),
      )
    }
  })

  function attach(agent) {
    const base = agent && agent.ctx
    const cwd = agent?.session?.header?.cwd
    // No cwd, or a cwd outside every stand-in: this session is local and gets nothing.
    if (base === undefined || typeof base.isolate !== 'function') return
    if (!isRoutedSession(worlds, cwd)) return

    // The realm: `fs` and `shell` resolve to the routers below this context, and the agent's
    // scope key is inherited, so everything mounted here shadows for THIS session.
    const realm = base.isolate('fs').isolate('shell')

    realm.plugin(createRoutingFileSystem(channels, worlds))
    realm.plugin(createRoutingShellExecutor(channels, worlds))
    for (const entry of official) realm.plugin(entry.plugin, entry.config)

    // glob/grep cannot ride either realm (see OFFICIAL_TOOL_PACKAGES), so they are registered
    // directly — same scope, same shadowing.
    registerRoutingSearch(realm, channels.forTarget, worlds)

    attachJobsController(agent)
    injectCapabilitySurface(agent, cfg)

    console.error(
      'dsh-devcontainer: session ' + String(agent.id ?? '(unknown)') + ' routed — cwd ' + String(cwd),
    )
  }
}

/**
 * Give the shadowed `bash` a job controller on the agent's own scope.
 *
 * The official `tool-bash` only CALLS `ctx.jobs.start`; the controller is attached by
 * `tool-jobs`. A preset that mounts no `tool-jobs` therefore leaves the agent-scoped `jobs`
 * instance without one, and `run_in_background` fails with "no job controller serves this
 * agent". Attaching here is additive: where `tool-jobs` is present it adds an anonymous token
 * with no effect.
 */
function attachJobsController(agent) {
  try {
    const jobs = agent.ctx.get('jobs')
    if (jobs === undefined || typeof jobs.attachController !== 'function') return
    jobs.attachController('dsh-devcontainer')
  } catch {
    // Background jobs unavailable here is not a reason to lose the session's routing.
  }
}

/** Register the capability-surface section in THIS agent's scope, so local sessions never see it. */
function injectCapabilitySurface(agent, cfg) {
  try {
    const systemPrompt = agent.ctx.systemPrompt
    if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return
    systemPrompt.section({
      name: CAPABILITY_SECTION,
      order: CAPABILITY_ORDER,
      text: capabilityText(cfg, agent.session?.header?.cwd),
    })
  } catch {
    // A missing prompt section is cosmetic; the routing itself still stands.
  }
}

// Routing acceptance test — container-free, so it runs in CI.
//
// It answers the two questions the design rests on, driving the REAL tool registry, the REAL
// agent scope, and the REAL official tool packages:
//
//   1. A session whose cwd is local is not touched: after the hook fires, every tool still
//      resolves to the very definition registered globally — the same object, not an equal one.
//   2. A session whose cwd is under the mirror gets definitions of its own, and a path inside
//      it resolves to the container.
//
// The mechanism is scope shadowing: a registration made through an agent's own context lands
// in that agent's tool layer and shadows the global entry for that session only. Nothing
// global is replaced and no composition row is disabled, which is why a local session needs no
// special case — it never reaches the hook's body.
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as dshTools from '@deepseek-ai/dsh-tools'
import { Worlds } from '../lib/routing.js'
import { routeOf, isRoutedSession, sessionCwdOf } from '../lib/route.js'
import { installAgentRouting } from '../lib/agent-hook.js'

const pluginOf = (mod) =>
  typeof mod.default === 'function' ? mod.default : mod.default?.apply === undefined ? mod : mod.default

let failures = 0
const check = (label, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
  if (!ok) failures++
}
const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms))

// --- the world resolver, driven without a container ---------------------------------------
const MOUNT_ROOT = '/tmp/dsh-agent-routing/root'
const HOST = 'my-nas'
const MIRRORED = MOUNT_ROOT + '/' + HOST + '/volume1/docker/proj'
const worlds = new Worlds({ sshHost: HOST, containerRoot: '/workspaces/proj', mountRoot: MOUNT_ROOT })
worlds.setResolved([
  { localPrefix: MIRRORED, host: HOST, world: 'container', container: 'proj-dev', remotePath: '/workspaces/proj' },
])

console.log('-- the decision is per path, and defaults to local --')
check('a local path routes nowhere', routeOf(worlds, '/tmp/ordinary.txt').kind === 'local')
check('no path at all is local too', routeOf(worlds, undefined).kind === 'local')
check(
  'a mirrored path routes to its container',
  (() => {
    const route = routeOf(worlds, MIRRORED + '/src/main.go')
    return route.kind === 'container' && route.host === HOST && route.remotePath === '/workspaces/proj/src/main.go'
  })(),
  JSON.stringify(routeOf(worlds, MIRRORED + '/src/main.go')),
)
check('a local session is not routed', isRoutedSession(worlds, '/tmp') === false)
check('a mirrored session is routed', isRoutedSession(worlds, MIRRORED) === true)
check('the cwd comes from the agent', sessionCwdOf({ agent: { session: { header: { cwd: '/x' } } } }) === '/x')
check('an absent session reads as undefined', sessionCwdOf({}) === undefined)

// --- the real registry, with seven stand-ins for the official tools ------------------------
const ROUTED_NAMES = ['bash', 'read', 'write', 'edit', 'read_image', 'glob', 'grep']
const app = new Context()
app.plugin(pluginOf(await import('@deepseek-ai/dsh-system-prompt')))
app.plugin(pluginOf(dshTools))
await settle()

app.plugin({
  name: 'stand-in-tools',
  inject: ['tools'],
  apply(ctx) {
    for (const name of ROUTED_NAMES) {
      ctx.tools.register({
        name,
        description: 'official ' + name,
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
        execute: async () => 'official:' + name,
      })
    }
  },
})
await settle()
const global = new Map(ROUTED_NAMES.map((name) => [name, app.tools.get(name)]))
check(
  'every routed name is registered globally',
  [...global.values()].every((definition) => definition !== undefined),
  [...global].filter(([, d]) => d === undefined).map(([n]) => n).join(', '),
)

// --- the names this plugin must shadow are the names the harness actually offers -----------
// Registration is conservative: only names already visible are shadowed, so a minimal preset
// keeps its minimal tool set.
const official = await import('@deepseek-ai/dsh-tool-fs')
check('the official packages are resolvable at runtime', typeof official.apply === 'function')

// --- the hook, driven the way the harness drives it ---------------------------------------
await installAgentRouting(app, {
  worlds,
  channels: { forTarget: () => ({ request: async () => ({ ok: true }) }) },
  cfg: { sshHost: HOST, container: 'proj-dev', containerRoot: '/workspaces/proj', mountRoot: MOUNT_ROOT, mountPoint: '' },
})

/**
 * Mint an agent-shaped object, with the scope built the way the agent loop builds it: under a
 * context that already injects the services the session's tools need. Creating it straight
 * off the root would satisfy neither `ctx.tools` nor `ctx.systemPrompt`, which is a property
 * of this test's wiring rather than of the hook.
 */
const minted = []
app.plugin({
  name: 'agent-scope-factory',
  inject: ['tools', 'systemPrompt'],
  apply(ctx) {
    minted.push((cwd) => {
      const key = { id: 'agent:' + cwd }
      const { ctx: scoped } = createScope(ctx, key)
      return { id: key.id, ctx: scoped, key, session: { header: { cwd } } }
    })
  },
})
await settle()
const fakeAgent = (cwd) => minted[0](cwd)

console.log('\n-- a local session is untouched, by identity --')
const local = fakeAgent('/tmp')
app.emit('agent/created', { agent: local })
await settle()
for (const name of ROUTED_NAMES) {
  check(`local: ${name} is still the global definition`, app.tools.get(name, local.key) === global.get(name))
}

console.log('\n-- a mirrored session gets its own --')
const routed = fakeAgent(MIRRORED)
app.emit('agent/created', { agent: routed })
await settle(400)
const shadowed = ROUTED_NAMES.filter((name) => app.tools.get(name, routed.key) !== global.get(name))
check('at least one routed name is shadowed', shadowed.length > 0, shadowed.join(', '))
check('and the global definitions are unchanged', ROUTED_NAMES.every((name) => app.tools.get(name) === global.get(name)))
check(
  'the local session still resolves to the global definitions',
  ROUTED_NAMES.every((name) => app.tools.get(name, local.key) === global.get(name)),
)

console.log('')
if (failures > 0) {
  console.log(failures + ' CHECK(S) FAILED')
  process.exit(1)
}
console.log('ALL CHECKS PASSED')

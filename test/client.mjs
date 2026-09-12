// Static regression guard for the client half. No React runtime is available to this package
// (the app bundles its own copy and hands it to plugin bundles), so the invariants that broke
// the local/remote picker and the dark-mode styling are encoded as source-level assertions
// instead. Everything here is dependency-free and runs everywhere.
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

let failures = 0
const check = (label, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
  if (!ok) failures++
}

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/** Every `React.useEffect(...)` body in the module, in source order. */
function effectBodies(text) {
  const bodies = []
  const marker = 'React.useEffect('
  let at = text.indexOf(marker)
  while (at !== -1) {
    const open = text.indexOf('{', at)
    if (open === -1) break
    let depth = 0
    let i = open
    for (; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') {
        depth--
        if (depth === 0) break
      }
    }
    bodies.push(text.slice(open, i + 1))
    at = text.indexOf(marker, i)
  }
  return bodies
}

/** The body of a named `React.useCallback(() => { ... })`. */
function callbackBody(text, name) {
  const at = text.indexOf('const ' + name + ' = React.useCallback(')
  if (at === -1) return null
  const open = text.indexOf('{', at)
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return text.slice(open, i + 1)
    }
  }
  return null
}

/** The brace-balanced body of a named `function`/`async function` declaration. */
function functionBody(text, name) {
  const at = text.indexOf('function ' + name + '(')
  if (at === -1) return null
  const open = text.indexOf('{', at)
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return text.slice(open, i + 1)
    }
  }
  return null
}

console.log('-- the style block is theme-driven --')
const cssArray = source.match(/const CSS = \[([\s\S]*?)\]\.join/)
check('the stylesheet is declared once as a joined array', cssArray !== null)
const css = [...cssArray[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]).join('')

const tokens = [...new Set([...css.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((m) => m[1]))]
check('the stylesheet uses theme tokens at all', tokens.length >= 10, String(tokens.length))

// The deployment's theme module is the authority on which aliases exist, so it is worth
// resolving for real — but it is not a dependency of this package and lives outside a plain
// checkout, so the check degrades to SKIP rather than failing. Candidates are derived from
// the environment, never from a path belonging to whoever wrote this file: `$DSH_HOME`
// defaults to `~/.dsh`, and `$DSH_HOME/profiles/node_modules` is the shared install
// directory that mirrors the harness's own dependencies.
const THEME_MODULE = 'node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'
const themeCandidates = [
  process.env.DSH_THEME_FILE,
  join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', THEME_MODULE),
  join(here, '..', THEME_MODULE),
].filter((candidate) => typeof candidate === 'string' && candidate !== '')

const themePath = themeCandidates.find((p) => existsSync(p))
if (themePath === undefined) {
  console.log('  SKIP  every token resolves in the shipped theme  -> theme module not found')
  console.log('        (set DSH_THEME_FILE to check against a specific installation)')
} else {
  const theme = readFileSync(themePath, 'utf8')
  const unknown = tokens.filter((token) => !theme.includes(token + ':'))
  check('every token resolves in the shipped theme', unknown.length === 0, unknown.join(', '))
}

// Hardcoded colours are precisely what breaks one of the two themes. Only an alpha scrim and a
// shadow may stay literal, because no alias token expresses them.
const ALLOWED_LITERALS = ['rgba(0,0,0,.32)', 'rgba(0,0,0,.28)']
const literals = [...new Set([...css.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)].map((m) => m[0]))]
const strays = literals.filter((literal) => !ALLOWED_LITERALS.includes(literal))
check('no colour literal escapes the allowlist', strays.length === 0, strays.join(', '))
check('the legacy hardcoded white is gone', !css.includes('#fff') && !source.includes("'#fff'"))

console.log('\n-- every class the component renders exists in the stylesheet --')
const defined = new Set([...css.matchAll(/\.(dshDc_[A-Za-z0-9]+)/g)].map((m) => m[1]))
// Class names reach the DOM through `className` AND as glyph arguments, so collect every
// scoped literal rather than only the `className:` shape.
const used = new Set(
  [...source.matchAll(/'(dshDc_[A-Za-z0-9]+(?: dshDc_[A-Za-z0-9]+)*)'/g)].flatMap((m) => m[1].split(' ')),
)
const rendered = [...used].filter((name) => name.startsWith('dshDc_'))
const missing = rendered.filter((name) => !defined.has(name))
check('the component renders classes', rendered.length >= 12, String(rendered.length))
check('and none of them is undefined', missing.length === 0, missing.join(', '))
check('no class is styled but never rendered', [...defined].every((name) => rendered.includes(name)), [...defined].filter((n) => !rendered.includes(n)).join(', '))

console.log('\n-- re-entry resets the picker instead of resuming it --')
const effects = effectBodies(source)
check('the component declares its effects', effects.length >= 3, String(effects.length))
const resets = effects.filter((body) => body.includes('setWorld('))
check('exactly one effect selects a world', resets.length === 1, String(resets.length))
check(
  'and that effect is the rising edge of `open`',
  resets.length === 1 && resets[0].includes('if (!open) return') && resets[0].includes("setWorld('container')"),
)

console.log('\n-- no interaction starts without a click --')
const autoFired = effects.filter((body) => body.includes('askLocal('))
check('no effect launches the local chooser', autoFired.length === 0, String(autoFired.length))
const askLocal = callbackBody(source, 'askLocal')
check('askLocal exists', askLocal !== null)
check(
  'the local chooser is reachable only through a click',
  source.includes('onClick: askLocal') && /onClick: \(\) => selectWorld\(id\)/.test(source),
)

console.log('\n-- cancelling the local chooser keeps the dialog usable --')
check(
  'a null result returns to the dialog rather than closing the flow',
  askLocal !== null && askLocal.includes("setLocalPhase('cancelled')"),
)
check('the local path never resolves the flow as cancelled', askLocal !== null && !askLocal.includes('onCancel'))
check(
  'a failure is shown inline, not raised as onError',
  askLocal !== null && askLocal.includes('setLocalError(') && !askLocal.includes('onError('),
)

console.log('\n-- a profile with no stand-in keeps a working picker --')
// The bundle is delivered wherever the package is installed, but the API behind the dialog
// only exists where a stand-in is configured. Taking the slot anyway would displace the
// deployment's own chooser — and that chooser is the only thing that can render a `browse`
// backend, whose seam exposes listing primitives rather than `pickDirectory()`.
check(
  'apply probes for the container API before claiming the hole',
  /async function apply\(ctx\) \{\s*\n\s*if \(!\(await containerApiMounted\(\)\)\) return/.test(source),
)
// The rule is "ONLY a 404 means absent", and it is asserted against the function's own body
// rather than against one spelling of the expression. An unauthorized or failed probe must
// keep the occupant, because the deployment's own chooser is still the only thing that can
// render a `browse` backend.
const mountedBody = functionBody(source, 'containerApiMounted') ?? ''
check(
  'only a definitive 404 counts as absent',
  (mountedBody.match(/return false/g) ?? []).length === 1
    && /if \(response\.status === 404\) return false/.test(mountedBody),
  mountedBody,
)
check(
  'and a served profile answers true on every other status',
  (mountedBody.match(/return true/g) ?? []).length === 2,
  mountedBody,
)
check('an ambiguous failure keeps the occupant', /catch \(problem\) \{\s*\n\s*return true\s*\n\s*\}/.test(source))
const rising = resets[0] ?? ''
check(
  'an absent container API defers instead of erroring',
  rising.includes('delegateLocal(id)') && !rising.includes('setError(reason('),
)
check('the reset clears the delegation flag', rising.includes('setDelegating(false)'))
check('nothing is drawn while the shipped chooser owns the screen', source.includes('if (!open || delegating) return null'))
const delegated = callbackBody(source, 'delegateLocal')
check('delegateLocal exists', delegated !== null)
check(
  'delegation resolves exactly one outcome',
  delegated !== null && delegated.includes('onPicked(picked)') && delegated.includes('onCancel()'),
)
check('a missing local picker is reported, not swallowed', delegated !== null && delegated.includes('setError('))

console.log('\n-- the promised outcome still exists --')
check('the dialog can still be dismissed', source.includes('latest.current.onCancel()'))
check('and the commit path still adopts a path', /onPicked\(text\(prepared\.mountPath\)\)/.test(source))
check(
  'a root listing with a null parent disables the parent action',
  /typeof listing\.parent !== 'string'/.test(source) && source.includes('disabled: disabled || parent === null'),
)

console.log('\n-- the port panel takes both seats, under one id --')
// The sidebar resolves a `sidebar.panellist` entry's id to the `main` cell of that EXACT id.
// A mismatch registers two things that never meet: an icon that opens nothing.
const panelId = source.match(/const PORTS_PANEL_ID = '([^']+)'/)
check('the panel id is declared once', panelId !== null, String(panelId))
const panellistRegistration = source.match(/name: 'sidebar\.panellist',\s*\n\s*id: ([A-Za-z_$][\w$]*)/)
const mainRegistration = source.match(/name: 'main', key: ([A-Za-z_$][\w$]*)/)
check('the sidebar row registers', panellistRegistration !== null, String(panellistRegistration))
check('the main panel registers', mainRegistration !== null, String(mainRegistration))
check(
  'and both use the SAME binding, not two literals that could drift apart',
  panellistRegistration !== null && mainRegistration !== null
  && panellistRegistration[1] === mainRegistration[1] && panellistRegistration[1] === 'PORTS_PANEL_ID',
  String(panellistRegistration === null ? '?' : panellistRegistration[1]) + ' vs ' + String(mainRegistration === null ? '?' : mainRegistration[1]),
)

// The sidebar owns the row, the tooltip, the active state and the CLICK. A glyph that drew its
// own button would nest one button inside another.
const glyphAt = source.indexOf('function PortsGlyph(props)')
const glyphBody = source.slice(glyphAt, source.indexOf('function PortRow(props)'))
check('the glyph exists', glyphAt !== -1)
check('it draws no button of its own', !glyphBody.includes('button'), 'the sidebar owns the button and the click')
check('and follows the row colour in both themes', glyphBody.includes("stroke: 'currentColor'"), 'a fixed colour breaks one theme')
check('the glyph reads the size the sidebar passes', glyphBody.includes('props.size'))

console.log('\n-- the panel stops polling when it is not mounted --')
const panelBody = source.slice(source.indexOf('function PortsPanel()'), source.indexOf('async function containerApiMounted'))
check('the panel body was found', panelBody.length > 500, String(panelBody.length) + ' chars')
check('the panel registers an interval', panelBody.includes('setInterval('))
check('and clears it on unmount', /clearInterval\(timer\)/.test(panelBody), 'an uncleared interval keeps polling after the panel is gone')
check('from the effect\'s own cleanup', /return \(\) => \{[\s\S]{0,140}clearInterval\(timer\)/.test(panelBody), 'a clear outside the cleanup never runs')
check('one reader is shared, so a poll cannot overwrite a newer refresh', panelBody.includes('reading.current'))
check('a failed poll keeps the last good list', panelBody.includes('previous.data'))
check('a probe failure is shown rather than drawn as an empty list', panelBody.includes('listeningError'))

console.log('\n-- the panel rides the same probe as the picker --')
const applyBody = source.slice(source.indexOf('async function apply(ctx)'))
check(
  'the panel registers only after the container-API probe',
  applyBody.indexOf('containerApiMounted') !== -1 && applyBody.indexOf('sidebar.panellist') > applyBody.indexOf('containerApiMounted'),
)
check('and is injected rather than registered blind', applyBody.includes("inject('sidebar.panellist'") && applyBody.includes("'main'"))

console.log('\n-- the container file tab claims the right addresses, and only those --')
// This section LOADS the bundle rather than reading it. The module only ever calls
// `require('react')`, and `apply()` renders nothing, so a four-method stub is the whole
// runtime it needs — and in exchange the address parser and the `canOpen` veto are exercised
// for real. A source-level assertion here would pass on a prefix comparison that is off by a
// slash, which is exactly the mistake that would send a local file to a dead tab.
const REACT_STUB = {
  createElement: () => null,
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: () => ({ current: undefined }),
  useMemo: (fn) => fn(),
}
const CONTAINER_ROOT = '/workspaces/ShutterSeek'
let captured = null
globalThis.window = { __ModuleLoader__: { load: (definition) => { captured = definition } } }
await import('../lib/client.js')
check('the bundle registers itself with the loader', captured !== null && captured.id === 'dsh-devcontainer')

const client = captured.factory((name) => {
  if (name === 'react') return REACT_STUB
  throw new Error('unexpected require: ' + name)
})
check('and exports an apply plus its service list', typeof client.apply === 'function' && Array.isArray(client.inject))
// The tab is an ADDITION: a deployment without the right sidebar must still get the directory
// picker and the port panel, so the registry is read optionally rather than declared. Declaring
// it would make the whole bundle wait, trading three features for one.
check(
  'the tab registry is NOT a hard dependency',
  !client.inject.includes('sidebarRightTabs') && client.inject.includes('slots'),
  JSON.stringify(client.inject),
)

const originalFetch = globalThis.fetch
globalThis.fetch = async () => ({
  status: 200,
  ok: true,
  json: async () => ({ knownRoots: [{ host: 'my-nas', path: CONTAINER_ROOT }] }),
})

const injected = []
let registered = null
let paneBody = null
// `ctx.inject(services, cb)` is how the bundle waits for the tab registry WITHOUT making the
// whole client half wait for it, so the fake resolves it eagerly and records the ask.
const injectAsks = []
const makeCtx = (services) => ({
  inject: (names, callback) => {
    injectAsks.push(names)
    if (names.every((name) => services[name] !== undefined)) callback({ ...services, slots: services.slots })
  },
  slots: services.slots,
  uiWorkspace: { pickDirectory: () => {} },
})
const slots = {
  inject: (name, callback) => {
    injected.push(name)
    // The pane callback is the one that carries the body registration, so drive it; the
    // others take the real code path but need no slot tree behind them.
    if (name === 'sidebar.right.pane.tab') callback()
    return () => {}
  },
  register: (registration, component) => {
    paneBody = { registration, component }
    return () => {}
  },
}
await client.apply(makeCtx({
  slots,
  sidebarRightTabs: { register: (definition) => { registered = definition; return () => {} } },
}))
globalThis.fetch = originalFetch

check('a tab type is registered', registered !== null)
check(
  'the registry is waited for through ctx.inject, not a fiber dependency',
  injectAsks.some((names) => names.includes('sidebarRightTabs')),
  JSON.stringify(injectAsks),
)

// And a deployment that never serves that registry loses only the tab: the ask stays
// unanswered, and every other registration in apply() has already happened.
let withoutRegistry = 0
await client.apply(makeCtx({
  slots: { inject: () => { withoutRegistry++; return () => {} }, register: () => () => {} },
}))
check('a deployment with no tab registry still applies its other surfaces', withoutRegistry > 0, String(withoutRegistry))
check('and registers no tab type there', registered !== null)
check(
  'whose kind is NOT the shipped text previewer\'s',
  registered !== null && registered.kind !== 'text',
  'a fallback kind shares itself with nothing, so the registry would throw',
)
check('in the extension band, which outranks the fallback', registered.priority === 'extension', String(registered.priority))
check('with an id of its own', typeof registered.id === 'string' && registered.id !== '', String(registered.id))
check('matching the sidebars file-address scheme', registered.patterns?.includes('dsh-resource://file/session/**'), JSON.stringify(registered.patterns))

const addressOf = (path) =>
  'dsh-resource://file/session/session-1/' + path.split('/').map(encodeURIComponent).join('/')
check('a container address opens here', registered.canOpen(addressOf(CONTAINER_ROOT + '/internal/service/cache.go')) === true)
check('the root itself does not', registered.canOpen(addressOf(CONTAINER_ROOT)) === false)
check('a local path does NOT', registered.canOpen(addressOf('/Users/saikewei/code_proj/thing.go')) === false)
check('a sibling root that only shares a prefix does NOT', registered.canOpen(addressOf('/workspaces/ShutterSeek-other/x.go')) === false)
check('another scheme does NOT', registered.canOpen('https://example.com/x.go') === false)
check('a bare session address does NOT', registered.canOpen('dsh-resource://file/session/session-1') === false)
check('nonsense does NOT', registered.canOpen(undefined) === false)
check(
  'an address with encoded segments still resolves',
  registered.canOpen(addressOf(CONTAINER_ROOT + '/a b/c.go')) === true,
)
check(
  'and a segment containing a slash is not mistaken for a separator',
  registered.canOpen(addressOf(CONTAINER_ROOT + '/a%2Fb.go')) === true,
)
check('the title is the basename', registered.title(addressOf(CONTAINER_ROOT + '/a/b/cache.go')) === 'cache.go')

check('the pane body registers under the type id, not the kind', paneBody?.registration?.key === registered.id, JSON.stringify(paneBody?.registration))
check('through an injected slot, so a late declaration still lands', injected.includes('sidebar.right.pane.tab'))

console.log('')
if (failures > 0) {
  console.log(failures + ' CHECK(S) FAILED')
  process.exit(1)
}
console.log('ALL CHECKS PASSED')

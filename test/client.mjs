// Static regression guard for the client half. No React runtime is available to this package
// (the app bundles its own copy and hands it to plugin bundles), so the invariants that broke
// the local/remote picker and the dark-mode styling are encoded as source-level assertions
// instead. Everything here is dependency-free and runs everywhere.
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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

console.log('-- the style block is theme-driven --')
const cssArray = source.match(/const CSS = \[([\s\S]*?)\]\.join/)
check('the stylesheet is declared once as a joined array', cssArray !== null)
const css = [...cssArray[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]).join('')

const tokens = [...new Set([...css.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((m) => m[1]))]
check('the stylesheet uses theme tokens at all', tokens.length >= 10, String(tokens.length))

// The deployment's theme module is the authority on which aliases exist; it is absent outside
// a DSH checkout, where only the structural checks below can run.
const themePath = process.env.DSH_THEME_FILE ?? [
  '/Users/saikewei/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js',
].find((p) => existsSync(p))
if (themePath === undefined) {
  console.log('  SKIP  every token resolves in the shipped theme  -> theme module not found')
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

console.log('')
if (failures > 0) {
  console.log(failures + ' CHECK(S) FAILED')
  process.exit(1)
}
console.log('ALL CHECKS PASSED')

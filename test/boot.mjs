// Activation test: mount the shipped plugin the way the Cordis loader does at profile
// boot — real `subprocess` service, real `tools` registry, real `inject` resolution —
// and then prove a tool call reaches the container end to end.
//
// This is the closest thing to a profile restart that can be run without restarting a
// live DSH.
import { Context } from '@deepseek-ai/cordis'
import { CONFIG, requireTarget } from './config.mjs'

requireTarget('sshHost', 'container', 'containerRoot')

const settle = (ms = 500) => new Promise((resolve) => setTimeout(resolve, ms))

/** A module's plugin is its default export (class or object) or the namespace itself. */
function pluginOf(mod) {
  const fallback = mod.default
  if (typeof fallback === 'function') return fallback
  if (fallback && typeof fallback === 'object' && typeof fallback.apply === 'function') return fallback
  if (typeof mod.apply === 'function') return mod
  throw new Error('no Cordis plugin found in module')
}

const app = new Context()
app.plugin(pluginOf(await import('@deepseek-ai/dsh-system-prompt')))
app.plugin(pluginOf(await import('@deepseek-ai/dsh-subprocess-local')))
app.plugin(pluginOf(await import('@deepseek-ai/dsh-tools')))
await settle()

const before = new Set(app.tools.schemas().map((schema) => schema.name))
console.log('services up  -> tools:', app.tools !== undefined, '| subprocess:', app.subprocess !== undefined)
console.log('tools before ->', before.size)

let failures = 0
const check = (label, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
  if (!ok) failures++
}

// Mount exactly as the loader would: the module namespace plus the row's config.
const firstMount = app.plugin(await import('../lib/index.js'), CONFIG)
await settle()

const after = app.tools.schemas().map((schema) => schema.name)
const added = after.filter((toolName) => !before.has(toolName))
console.log('tools after  ->', after.length, '| added:', added.join(', '))

console.log('\n-- activation --')
// Three surfaces: the container the development happens in, the host that runs it, and the
// network between them.
const CONTAINER_TOOLS = [
  'devc_status', 'devc_exec', 'devc_read', 'devc_write', 'devc_edit', 'devc_ls', 'devc_grep', 'devc_glob',
]
const HOST_TOOLS = ['devc_host_exec', 'devc_host_read', 'devc_host_write', 'devc_host_ls', 'devc_containers']
const PORT_TOOLS = ['devc_ports', 'devc_forward', 'devc_unforward']
const expected = [...CONTAINER_TOOLS, ...HOST_TOOLS, ...PORT_TOOLS]
const missing = expected.filter((tool) => !added.includes(tool))
check('plugin activated through ctx.plugin with real inject resolution', missing.length === 0, 'missing: ' + missing.join(',') || added.join(','))
check('every surface is live: ' + expected.length + ' tools', added.length === expected.length, added.join(','))

// Drive one call through the REAL registry, not through a captured definition.
console.log('\n-- dispatch through the real registry --')
try {
  const result = await app.tools.execute({
    callId: 'boot-smoke-1',
    name: 'devc_exec',
    arguments: { command: 'hostname; test -f /.dockerenv && echo in_container=yes', workdir: CONFIG.containerRoot },
    signal: new AbortController().signal,
  })
  const text = JSON.stringify(result)
  console.log('registry result:', text.slice(0, 300))
  check('a real registry dispatch reaches the container', text.includes('in_container=yes'))
} catch (error) {
  check('a real registry dispatch reaches the container', false, String(error && error.message ? error.message : error))
}

// Disposing the fiber must withdraw every tool the plugin contributed.
console.log('\n-- teardown --')
firstMount.dispose()
await settle(300)
const remaining = app.tools.schemas().map((schema) => schema.name).filter((toolName) => added.includes(toolName))
check('disposal withdraws every contributed tool', remaining.length === 0, remaining.join(','))

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'))
process.exit(failures === 0 ? 0 : 1)

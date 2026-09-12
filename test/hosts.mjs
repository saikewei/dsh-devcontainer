// Unit test for the ssh_config host roster. No container, no network: the parser turns the
// operator's own ~/.ssh/config into the list the picker offers, so it is worth guarding on
// its own — and it runs everywhere, including CI.
import { parseSshConfig } from '../lib/hosts.js'
import { CONFIG } from './config.mjs'

let failures = 0
const check = (label, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
  if (!ok) failures++
}
const aliases = (text) => parseSshConfig(text).map((entry) => entry.alias)

console.log('-- a plain roster --')
// Documentation addresses (RFC 5737) and a throwaway username: a fixture that carried a real
// tailnet address and a real login would publish one operator's network to everybody.
const plain = parseSshConfig([
  'Host nas',
  '  HostName 192.0.2.10',
  '  User operator',
  '',
  'Host wsl',
  '  HostName 198.51.100.27',
  '  User operator',
  '  Port 52222',
].join('\n'))
check('every alias is listed in file order', JSON.stringify(aliases('Host a\nHost b')) === '["a","b"]', JSON.stringify(aliases('Host a\nHost b')))
check('a block keeps its hostname, user and port', JSON.stringify(plain[1]) === JSON.stringify({ alias: 'wsl', hostName: '198.51.100.27', user: 'operator', port: '52222' }), JSON.stringify(plain[1]))
check('a block without a port leaves it undefined', plain[0].port === undefined, String(plain[0].port))

console.log('\n-- what is deliberately not offered --')
check('a wildcard block registers no alias', aliases('Host *.example.com\n  User x').length === 0, JSON.stringify(aliases('Host *.example.com\n  User x')))
check('a negation pattern registers no alias', aliases('Host a !b\n  HostName h').length === 1)
check('a bare "*" registers nothing', aliases('Host *\n  User x').length === 0)

console.log('\n-- shapes that share one block --')
const shared = parseSshConfig(['Host a b', '  HostName real.example', '  User u', '  Port 2222'].join('\n'))
check('a multi-alias line yields one entry per alias', shared.length === 2, String(shared.length))
check(
  'and both carry the same block config',
  shared[0].hostName === 'real.example' && shared[1].hostName === 'real.example'
  && shared[0].port === '2222' && shared[1].port === '2222',
)
check('a later Host line starts a new block', (() => {
  const t = parseSshConfig(['Host one', '  User u1', 'Host two', '  User u2'].join('\n'))
  return t[0].user === 'u1' && t[1].user === 'u2'
})())

console.log('\n-- tolerated noise --')
check('comments and blank lines are skipped', aliases('# c\n\n  # indented\nHost a') .length === 1)
check('an unknown directive is ignored, not guessed', parseSshConfig('Host a\n  ProxyJump jump\n  ForwardAgent yes').length === 1)
check('a `Key=Value` line is accepted', (() => {
  const t = parseSshConfig('Host a\n  HostName=h.example')
  return t[0].hostName === 'h.example'
})(), JSON.stringify(parseSshConfig('Host a\n  HostName=h.example')))
check('directives before any Host block are ignored', parseSshConfig('User global\nHost a').length === 1)

console.log('\n-- a Match block ends the block that was open --')
// `Match` names a CONDITION, not a machine. Its directives are conditional and this parser
// does not evaluate the condition, so the only safe reading is to apply none of them — they
// used to land on whichever `Host` came before, and the picker then showed that machine under
// the wrong user and port.
const withMatch = parseSshConfig([
  'Host nas',
  '  HostName 192.0.2.10',
  '',
  'Match host other',
  '  User conditional',
  '  Port 2222',
  '',
  'Host wsl',
  '  HostName 198.51.100.27',
].join('\n'))
check('no conditional directive reaches the block before it', JSON.stringify(withMatch[0]) === JSON.stringify({ alias: 'nas', hostName: '192.0.2.10' }), JSON.stringify(withMatch[0]))
check('and the block after it still parses', withMatch[1]?.hostName === '198.51.100.27', JSON.stringify(withMatch[1]))
check('a Match block adds no alias of its own', aliases('Host a\nMatch host b\n  User u').join(',') === 'a', aliases('Host a\nMatch host b\n  User u').join(','))
const matchFirst = parseSshConfig('Match host x\n  User u\nHost a\n  HostName 192.0.2.1')
check('a Match before the first Host does not leak forward either', JSON.stringify(matchFirst) === JSON.stringify([{ alias: 'a', hostName: '192.0.2.1' }]), JSON.stringify(matchFirst))

console.log('\n-- the operator\'s own file, when there is one --')
const { readFile } = await import('node:fs/promises')
const { homedir } = await import('node:os')
const configPath = process.env.DSH_DEVCONTAINER_SSH_CONFIG || homedir() + '/.ssh/config'
const real = parseSshConfig(await readFile(configPath, 'utf8').catch(() => ''))
if (real.length === 0) {
  console.log('  (no ssh config to read here; skipped)')
} else {
  console.log('  aliases:', real.map((entry) => entry.alias).join(', '))
  console.log('  read from:', configPath)
  check('the configured host appears in the operator\'s own roster', real.some((entry) => entry.alias === CONFIG.sshHost), CONFIG.sshHost)
  check('no pattern leaked into the roster', real.every((entry) => !/[*?!]/.test(entry.alias)))
}

console.log('\n-- what may become an ssh DESTINATION --')
// Two gates stand between a caller-supplied string and the ssh binary, and they answer
// different questions. The roster says WHICH MACHINES this profile offers; the transport says
// that no string may look like an option at all. `browse.js` already documents the second
// threat for its own route ("a leading `-` is parsed as an OPTION — `-oProxyCommand=…` runs a
// local command"); these assertions are the same defence on the paths that had none.
const { existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { pickRosterHost } = await import('../lib/index.js')
const { RemoteTransport } = await import('../lib/transport.js')

const gateDir = mkdtempSync(join(tmpdir(), 'dsh-hostgate-'))
try {
  const sshConfig = join(gateDir, 'config')
  writeFileSync(sshConfig, 'Host nas\n  HostName 192.0.2.10\nHost eu\n  HostName 192.0.2.20\n')
  const gateCfg = { ...CONFIG, sshConfigPath: sshConfig, sshHost: 'nas', extraHosts: ['declared-only'] }

  check('an alias from the config is accepted', (await pickRosterHost(gateCfg, 'eu')) === 'eu')
  check('the configured host is accepted', (await pickRosterHost(gateCfg, 'nas')) === 'nas')
  check('no argument means the configured host', (await pickRosterHost(gateCfg, undefined)) === 'nas')
  check('blank means the configured host too', (await pickRosterHost(gateCfg, '  ')) === 'nas')
  check('an extraHosts entry is accepted', (await pickRosterHost(gateCfg, 'declared-only')) === 'declared-only')
  check('surrounding space is trimmed, not dialled', (await pickRosterHost(gateCfg, ' eu ')) === 'eu')

  await pickRosterHost(gateCfg, 'somewhere-else').then(
    () => check('a machine nobody offered is refused', false, 'it was accepted'),
    (error) => check('a machine nobody offered is refused', /unknown host/.test(String(error.message)), String(error.message)),
  )
  await pickRosterHost(gateCfg, '-oProxyCommand=touch /tmp/x').then(
    () => check('an ssh OPTION is refused as a host', false, 'it was accepted'),
    (error) => check('an ssh OPTION is refused as a host', /unknown host/.test(String(error.message)), String(error.message)),
  )

  // An unreadable config is not an empty roster: the configured host still answers, and the
  // refusal says why rather than pretending the name was never offered.
  const brokenCfg = { ...gateCfg, sshConfigPath: join(gateDir, 'no-such-config') }
  check('an unreadable config still offers the configured host', (await pickRosterHost(brokenCfg, 'nas')) === 'nas')
  await pickRosterHost(brokenCfg, 'eu').then(
    () => check('but not an alias only the config knew', false, 'it was accepted'),
    (error) => check('but not an alias only the config knew', /could not be read/.test(String(error.message)), String(error.message)),
  )

  // The transport is the last stop before argv, so it refuses independently of the roster. A
  // fake ssh on PATH records what it was handed, and the assertion is that a refused
  // destination hands it NOTHING: a spawn that never happens cannot be talked into running a
  // ProxyCommand, whichever caller produced the string.
  const bin = join(gateDir, 'bin')
  mkdirSync(bin)
  const marker = join(gateDir, 'spawned')
  writeFileSync(join(bin, 'ssh'), '#!/bin/sh\necho "$@" > ' + JSON.stringify(marker) + '\nexit 0\n', { mode: 0o755 })
  const savedPath = process.env.PATH
  process.env.PATH = bin + ':' + savedPath
  try {
    const refused = await new RemoteTransport({ get: () => undefined }, '-oProxyCommand=touch /tmp/pwned', undefined).collect('true')
    check('the transport refuses a destination that looks like an option', /starts with "-"/.test(refused.stderr), JSON.stringify(refused))
    check('and never spawns ssh at all', !existsSync(marker), 'ssh was reached')
    const plain = await new RemoteTransport({ get: () => undefined }, 'nas', undefined).collect('true')
    check('while an ordinary destination still reaches ssh', plain.exitCode === 0 && existsSync(marker), JSON.stringify(plain))
  } finally {
    process.env.PATH = savedPath
  }
} finally {
  rmSync(gateDir, { recursive: true, force: true })
}

console.log('\n-- a host tool that FAILS still answers with a message --')
// `registerHostTools` reports through a CURRIED helper — `report(channel)(error)` — and four of
// its five catches called it once, so a failing tool returned the inner arrow instead of text.
// The registry then said "returned invalid output: value is not lossless JS", which names
// neither the tool nor the reason. Driving every host tool through its own failure path is the
// only assertion that catches it, because the happy paths all work.
const { Context } = await import('@deepseek-ai/cordis')
const gateApp = new Context()
const pluginOf = (m) => (typeof m.default === 'function' ? m.default : (m.default?.apply ? m.default : m))
gateApp.plugin(pluginOf(await import('@deepseek-ai/dsh-system-prompt')))
gateApp.plugin(pluginOf(await import('@deepseek-ai/dsh-subprocess-local')))
gateApp.plugin(pluginOf(await import('@deepseek-ai/dsh-tools')))
await new Promise((resolve) => setTimeout(resolve, 400))
gateApp.plugin(await import('../lib/index.js'), {
  ...CONFIG,
  sshHost: 'nas',
  extraHosts: [],
  sshConfigPath: join(gateDir ?? '/nonexistent', 'config'),
})
await new Promise((resolve) => setTimeout(resolve, 600))
for (const [tool, args] of [
  ['devc_host_exec', { command: 'true', host: 'nowhere-else' }],
  ['devc_host_read', { path: '/etc/hostname', host: 'nowhere-else' }],
  ['devc_host_write', { path: '/tmp/x', content: 'x', host: 'nowhere-else' }],
  ['devc_host_ls', { path: '/tmp', host: 'nowhere-else' }],
  ['devc_containers', { host: 'nowhere-else' }],
]) {
  const definition = gateApp.tools.get(tool)
  if (definition === undefined) { check(`${tool} is registered`, false); continue }
  let value
  try {
    value = await definition.execute(args, { signal: new AbortController().signal })
  } catch (error) {
    value = error
  }
  check(
    `${tool} answers its failure with text`,
    typeof value === 'string' && value.includes('unknown host'),
    typeof value + ' ' + String(value).slice(0, 60),
  )
}
gateApp.stop?.()

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'))
process.exit(failures === 0 ? 0 : 1)

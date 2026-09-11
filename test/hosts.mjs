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

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'))
process.exit(failures === 0 ? 0 : 1)

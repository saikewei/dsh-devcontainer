// Unit test for the picker's listing pass. It runs locally through `sh`, so it needs no
// remote machine and no Node on one — which is the point: the picker must work on a host
// whose only requirement is sshd.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildListCommand, registerContainerApi } from '../lib/browse.js'

let failures = 0
const check = (label, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
  if (!ok) failures++
}
const run = (path) => {
  try {
    return { code: 0, out: execFileSync('/bin/sh', ['-c', buildListCommand(path)], { encoding: 'utf8' }) }
  } catch (error) {
    return { code: error.status, out: String(error.stdout ?? '') }
  }
}

const root = mkdtempSync(join(tmpdir(), 'dsh-browse-'))
try {
  mkdirSync(join(root, 'plain'))
  mkdirSync(join(root, 'project'))
  mkdirSync(join(root, 'project', '.devcontainer'))
  mkdirSync(join(root, '.hidden'))
  mkdirSync(join(root, '.hidden', '.devcontainer'))
  writeFileSync(join(root, 'a-file.txt'), 'not a directory\n')

  console.log('-- one level, one call --')
  const listed = run(root)
  const lines = listed.out.split('\n').map((l) => l.trim()).filter(Boolean)
  console.log('  raw:', JSON.stringify(lines))
  check('directories are reported, files are not', lines.includes('Fplain') && lines.includes('Dproject') && !lines.some((l) => l.includes('a-file')), JSON.stringify(lines))
  check('a folder carrying .devcontainer is marked D', lines.includes('Dproject'))
  check('a folder without one is marked F', lines.includes('Fplain'))
  check('hidden directories are skipped', !lines.some((l) => l.includes('hidden')))
  check('the level itself is reported when it has a .devcontainer', !lines.includes('S'))

  console.log('\n-- the level itself --')
  const self = run(join(root, 'project')).out.split('\n').map((l) => l.trim()).filter(Boolean)
  check('a project root reports S', self.includes('S'), JSON.stringify(self))
  check('and its empty child list', self.length === 1, JSON.stringify(self))

  console.log('\n-- a path that is not a directory --')
  const missing = run(join(root, 'nope'))
  check('a missing path exits 3 rather than listing nothing', missing.code === 3, String(missing.code))
  const file = run(join(root, 'a-file.txt'))
  check('a file exits 3 too', file.code === 3, String(file.code))

  console.log('\n-- quoting --')
  const odd = mkdtempSync(join(tmpdir(), "dsh-browse-'quoted-"))
  try {
    mkdirSync(join(odd, 'sub'))
    const out = run(odd).out
    check("a path containing a single quote is listed", out.includes('Fsub'), JSON.stringify(out))
  } finally {
    rmSync(odd, { recursive: true, force: true })
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('\n-- the host a request names is checked against the roster --')
// The HTTP routes are reachable from the page, and the `host` they accept becomes both an
// argv element for `ssh` (where a leading `-` is parsed as an OPTION, e.g. -oProxyCommand)
// and a path segment under the mirror (where `..` walks out, and the result is mkdir'd).
// Neither string is an ssh alias. This is container-free: the transport is a recorder.
let handler
const apiCtx = {
  get: (key) => (key === 'webServer' ? { register: (route) => { handler = route.handler; return () => {} } } : undefined),
  effect: () => {},
}
const seen = []
const deps = {
  forTarget: () => ({}),
  transportFor: (host) => ({ collect: async () => { seen.push(host); return { exitCode: 0, stdout: 'S\n', stderr: '' } } }),
  containersFor: () => ({ resolve: async () => ({ usable: false }) }),
  worlds: { locate: () => undefined, toMountRootPath: (host, p) => join(root, 'mirror', host, p) },
  cfg: {
    sshHost: 'my-nas', container: '', containerRoot: '/', hostRoot: '',
    mountRoot: join(root, 'mirror'), browseRoot: '/',
    sshConfigPath: join(root, 'no-such-ssh-config'), extraHosts: ['other-nas'],
  },
}
registerContainerApi(apiCtx, deps)

/** One GET /list, returning the status, the body, and whether ssh was reached at all. */
const listAs = async (host) => {
  seen.length = 0
  let status = null
  let body = ''
  const res = {
    writeHead: (code) => { status = code },
    end: (text) => { body = String(text ?? '') },
    setHeader: () => {},
  }
  const url = new URL('http://x/dsh-devcontainer/list?path=/&host=' + encodeURIComponent(host))
  await handler({ method: 'GET', url }, res)
  return { status, body, ssh: [...seen] }
}

const legitimate = await listAs('my-nas')
check('a host on the roster is accepted', legitimate.status === 200, String(legitimate.status))
check('and reaches ssh', legitimate.ssh.length === 1, JSON.stringify(legitimate.ssh))

const configured = await listAs('other-nas')
check('an extraHosts entry is accepted too', configured.status === 200, String(configured.status))

for (const [label, value] of [
  ['an ssh option masquerading as a host', '-oProxyCommand=touch /tmp/PWNED'],
  ['a path traversal in the host segment', '../../../../tmp/escape'],
  ['a host nobody offered', 'somewhere-else'],
]) {
  const attempt = await listAs(value)
  check(label + ' is refused', attempt.status === 400, String(attempt.status))
  check('  and never reaches ssh', attempt.ssh.length === 0, JSON.stringify(attempt.ssh))
}

console.log('\n-- a listing that could not run is not an empty directory --')
// ssh failed: unreachable machine, rejected key, no route. Rendering that as an empty listing
// told the operator "nothing here" about a machine the picker never reached, so a failure read
// as an answer. exit 3 stays a 404 — that one IS an answer ("no such directory").
const unreachable = { exitCode: 255, stdout: '', stderr: 'ssh: connect to host my-nas port 22: Operation timed out' }
registerContainerApi(apiCtx, {
  ...deps,
  transportFor: () => ({ collect: async () => unreachable }),
})
const failed = await listAs('my-nas')
check('a failed ssh is reported as a failure', failed.status === 502, String(failed.status))
check('with what ssh said', failed.body.includes('Operation timed out'), failed.body)
check('and NOT as an empty listing', failed.body.includes('error') && !failed.body.includes('"entries"'), failed.body)

const quietFailure = { exitCode: 255, stdout: '', stderr: '   ' }
registerContainerApi(apiCtx, { ...deps, transportFor: () => ({ collect: async () => quietFailure }) })
const quiet = await listAs('my-nas')
check('an ssh failure with no stderr still says something', quiet.status === 502 && quiet.body.includes('exit 255'), quiet.body)

const noExit = { exitCode: null, stdout: '', stderr: 'no sshHost configured' }
registerContainerApi(apiCtx, { ...deps, transportFor: () => ({ collect: async () => noExit }) })
const never = await listAs('my-nas')
check('a command that never ran is reported too', never.status === 502 && never.body.includes('no sshHost configured'), never.body)

registerContainerApi(apiCtx, { ...deps, transportFor: () => ({ collect: async () => ({ exitCode: 3, stdout: '', stderr: '' }) }) })
const absent = await listAs('my-nas')
check('exit 3 stays "no such directory"', absent.status === 404, String(absent.status))

registerContainerApi(apiCtx, deps)
const healthy = await listAs('my-nas')
check('and a working listing is still a listing', healthy.status === 200, String(healthy.status))

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'))
process.exit(failures === 0 ? 0 : 1)

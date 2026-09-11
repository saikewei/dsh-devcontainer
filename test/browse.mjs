// Unit test for the picker's listing pass. It runs locally through `sh`, so it needs no
// remote machine and no Node on one — which is the point: the picker must work on a host
// whose only requirement is sshd.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildListCommand } from '../lib/browse.js'

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

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'))
process.exit(failures === 0 ? 0 : 1)

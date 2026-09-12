// The dev-container discovery chain, against a real host.
//
// This is the whole point of the SSH foundation: a host directory becomes a container path
// without implementing `devcontainer up`, because Dev Containers already wrote the folder
// onto the container as a label and Docker records the bind mount.
//
//   folder  →  .devcontainer present?  →  container for that folder  →  path inside it
import { RemoteTransport } from '../lib/transport.js'
import { DevContainers, foldersContaining } from '../lib/discover.js'
import { CONFIG, requireTarget } from './config.mjs'

requireTarget('sshHost', 'container', 'containerRoot')

const HOST_FOLDER = process.env.DSH_DEVCONTAINER_HOST_FOLDER ?? CONFIG.hostRoot

let failures = 0
const check = (label, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
  if (!ok) failures++
}

// One transport reaches one machine.
const transport = new RemoteTransport(CONFIG.sshHost)
const containers = new DevContainers(transport)

console.log('-- transport --')
console.log('host:', transport.host)
check('the transport names the machine it reaches', transport.host === CONFIG.sshHost, String(transport.host))

console.log('\n-- discovery --')
const listed = await containers.list()
console.log('dev containers on ' + CONFIG.sshHost + ':')
for (const entry of listed) {
  console.log('   ', (entry.running ? 'running ' : 'stopped '), entry.name)
  console.log('      folder    :', entry.hostFolder || '(unlabelled)')
  console.log('      container :', entry.containerPath ?? '(folder not bind-mounted)')
}
check('the host reports at least one dev container', listed.length > 0)
check('every listed container names its host folder', listed.every((entry) => entry.hostFolder !== ''))
check(
  'every listed container bind-mounts that folder somewhere',
  listed.every((entry) => entry.containerPath !== undefined),
  listed.map((entry) => entry.name + ' -> ' + String(entry.containerPath)).join(', '),
)

console.log('\n-- the chain for one folder --')
if (HOST_FOLDER === '') {
  console.log('(skipped: set DSH_DEVCONTAINER_HOST_FOLDER to exercise one folder)')
} else {
  const resolved = await containers.resolve(HOST_FOLDER)
  console.log(JSON.stringify({
    folder: resolved.hostFolder,
    hasDevcontainerConfig: resolved.hasDevcontainerConfig,
    container: resolved.container === undefined ? null : resolved.container.name,
    containerPath: resolved.container === undefined ? null : resolved.container.containerPath,
    usable: resolved.usable,
  }, null, 1))
  check('the folder carries a .devcontainer', resolved.hasDevcontainerConfig)
  check('a container was found for it by label', resolved.container !== undefined)
  check('the folder is bind-mounted into that container', resolved.container?.containerPath !== undefined)
  check('the container is usable as the execution world for the folder', resolved.usable === true)
  check(
    'the container path is absolute and inside the container',
    (resolved.container?.containerPath ?? '').startsWith('/'),
    String(resolved.container?.containerPath),
  )

  const consistent = listed.find((entry) => entry.hostFolder === HOST_FOLDER)
  check(
    'the labels on the container list agree with the folder chain: same object from both directions',
    consistent !== undefined && consistent.containerPath === resolved.container?.containerPath,
  )
}

console.log('\n-- a folder with no dev container --')
const bare = await containers.resolve('/tmp')
check('no .devcontainer is reported as absent', bare.hasDevcontainerConfig === false)
check('no container is reported for it', bare.container === undefined)
check('it is not usable as a container world', bare.usable === false)

console.log('\n-- the folder index, in one command --')
// The index is what makes routing affordable per path: one read of the host's labels answers
// "which container serves this path" for every path, where `--filter label=...=<path>` is one
// round trip per question and cannot answer for a file at all.
const folderIndex = await containers.folders()
console.log('labelled folders on ' + CONFIG.sshHost + ':')
for (const row of folderIndex) console.log('   ', row.name, '->', row.hostFolder, '(' + row.status + ')')
check('the index lists the same folders as the per-container walk', folderIndex.length === listed.length, String(folderIndex.length) + ' vs ' + String(listed.length))
check(
  'and names the same container for each folder',
  folderIndex.every((row) => listed.some((entry) => entry.name === row.name && entry.hostFolder === row.hostFolder)),
)
check('every row keeps a status', folderIndex.every((row) => row.status !== ''), folderIndex.map((row) => row.status).join(','))

console.log('\n-- matching a path to its folder --')
// The matching rule, pure: the LONGEST labelled folder containing the path, so a container
// built for a subfolder is the more specific answer inside it.
const fakeIndex = [
  { name: 'outer', hostFolder: '/srv/app', status: 'running' },
  { name: 'inner', hostFolder: '/srv/app/cmd', status: 'running' },
  { name: 'other', hostFolder: '/srv/other', status: 'exited' },
]
check('the folder itself matches', foldersContaining(fakeIndex, '/srv/app')[0]?.name === 'outer')
check('a file inside it matches, which a --filter query could not answer', foldersContaining(fakeIndex, '/srv/app/main.go')[0]?.name === 'outer')
check('the more specific folder wins for its own subtree', foldersContaining(fakeIndex, '/srv/app/cmd/x.go')[0]?.name === 'inner')
check('and the whole chain is available, longest first', foldersContaining(fakeIndex, '/srv/app/cmd/x.go').map((f) => f.name).join(',') === 'inner,outer', foldersContaining(fakeIndex, '/srv/app/cmd/x.go').map((f) => f.name).join(','))
check('a sibling is not swallowed by a shared prefix', foldersContaining(fakeIndex, '/srv/application/main.go').length === 0)
check('nor by a shared prefix one level up', foldersContaining(fakeIndex, '/srv/app2/main.go').length === 0)
check('a path outside every folder has no container', foldersContaining(fakeIndex, '/tmp').length === 0)
check('an empty index matches nothing', foldersContaining([], '/srv/app').length === 0)

if (folderIndex.length > 0) {
  const row = folderIndex[0]
  const deep = row.hostFolder + '/definitely-not-a-real-file.go'
  check(
    'a path under a real labelled folder matches it, so the container path is knowable',
    foldersContaining(folderIndex, deep)[0]?.name === row.name,
    String(foldersContaining(folderIndex, deep)[0]?.name),
  )
  const described = await containers.describe(row.name)
  check('describing by name reports the folder and its container path', described?.hostFolder === row.hostFolder && described?.containerPath !== undefined)
}

transport.dispose()
console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'))
process.exit(failures === 0 ? 0 : 1)

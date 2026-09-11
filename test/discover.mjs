// The dev-container discovery chain, against a real host.
//
// This is the whole point of the SSH foundation: a host directory becomes a container path
// without implementing `devcontainer up`, because Dev Containers already wrote the folder
// onto the container as a label and Docker records the bind mount.
//
//   folder  →  .devcontainer present?  →  container for that folder  →  path inside it
import { RemoteTransport } from '../lib/transport.js'
import { DevContainers } from '../lib/discover.js'
import { CONFIG, requireTarget } from './config.mjs'

requireTarget('sshHost', 'container', 'containerRoot')

const HOST_FOLDER = process.env.DSH_DEVCONTAINER_HOST_FOLDER ?? CONFIG.hostRoot

let failures = 0
const check = (label, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
  if (!ok) failures++
}

// One transport reaches one machine: (ctx, host, the host ctx.ssh owns).
const transport = new RemoteTransport({ get: () => undefined }, CONFIG.sshHost, CONFIG.sshHost)
const containers = new DevContainers(transport)

console.log('-- transport --')
console.log('backend:', transport.backend, '| host:', transport.host)
check('a transport backend answered', transport.backend === 'ssh' || transport.backend === 'ctx.ssh')

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

transport.dispose()
console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'))
process.exit(failures === 0 ? 0 : 1)

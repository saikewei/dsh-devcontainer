// Unit test for the world resolver. No container, no harness: `Worlds` is pure, and these
// rules decide WHICH MACHINE and WHICH WORLD a path is executed in — so they are worth
// guarding on their own.
import { Worlds } from '../lib/routing.js'

let failures = 0
const check = (label, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
  if (!ok) failures++
}
const where = (worlds, path) => {
  const located = worlds.locate(path)
  return located === undefined ? 'local' : located.host + '/' + located.world + ':' + located.path
}

const MOUNT_ROOT = '/Users/you/.dsh/devcontainer/root'
const MOUNT_POINT = '/Users/you/.dsh/devcontainer/ShutterSeek'
const CONTAINER_ROOT = '/workspaces/ShutterSeek'
const HOST_FOLDER = '/volume1/docker/ShutterSeek'
const DEFAULT_HOST = 'nas'
// The mirror's first segment is the machine, because two machines can hold the same path.
const MIRROR = MOUNT_ROOT + '/' + DEFAULT_HOST

console.log('-- the structural mirror names the HOST as well as the path --')
const mirrored = new Worlds({ sshHost: DEFAULT_HOST, containerRoot: CONTAINER_ROOT, mountRoot: MOUNT_ROOT })
check(
  'a mirrored path resolves to that machine and path',
  where(mirrored, MIRROR + HOST_FOLDER + '/go.mod') === DEFAULT_HOST + '/host:' + HOST_FOLDER + '/go.mod',
)
check('a different machine is addressable through the same mirror', where(mirrored, MOUNT_ROOT + '/eu/srv/app') === 'eu/host:/srv/app')
check('the mirror root of a machine is its filesystem root', where(mirrored, MIRROR) === DEFAULT_HOST + '/host:/')
check(
  'mirrorPath derives machine and path without consulting any resolution',
  JSON.stringify(mirrored.mirrorPath(MIRROR + HOST_FOLDER)) === JSON.stringify({ host: DEFAULT_HOST, path: HOST_FOLDER }),
)
check('mirrorPath reads a different machine', JSON.stringify(mirrored.mirrorPath(MOUNT_ROOT + '/a100/data')) === JSON.stringify({ host: 'a100', path: '/data' }))
check('a bare machine segment is its root', JSON.stringify(mirrored.mirrorPath(MOUNT_ROOT + '/eu')) === JSON.stringify({ host: 'eu', path: '/' }))
check('mirrorPath declines the mirror root itself', mirrored.mirrorPath(MOUNT_ROOT) === undefined)
check('mirrorPath declines a path outside the mirror', mirrored.mirrorPath('/Users/you/code') === undefined)
check('a plain local path stays local', where(mirrored, '/Users/you/code/other') === 'local')
check('a platform temp path stays local', where(mirrored, '/tmp/scratch') === 'local')

console.log('\n-- resolved mappings decide machine, world AND container --')
const resolved = new Worlds({ sshHost: DEFAULT_HOST, containerRoot: CONTAINER_ROOT, mountRoot: MOUNT_ROOT })
resolved.setResolved([
  { localPrefix: MIRROR + HOST_FOLDER, host: 'nas', world: 'container', container: 'epic_mirzakhani', remotePath: CONTAINER_ROOT },
])
check(
  'a mirrored workspace with a dev container resolves into it, on its own machine',
  where(resolved, MIRROR + HOST_FOLDER + '/cmd/main.go') === 'nas/container:' + CONTAINER_ROOT + '/cmd/main.go',
)
check(
  'the resolver reports which container',
  resolved.locate(MIRROR + HOST_FOLDER)?.container === 'epic_mirzakhani',
  String(resolved.locate(MIRROR + HOST_FOLDER)?.container),
)
check(
  'the container path it hands out resolves back to the same target',
  where(resolved, CONTAINER_ROOT + '/cmd/main.go') === 'nas/container:' + CONTAINER_ROOT + '/cmd/main.go',
)
check('the mirror is still a host path outside that workspace', where(resolved, MIRROR + '/etc') === 'nas/host:/etc')

const twoMachines = new Worlds({ sshHost: DEFAULT_HOST, containerRoot: CONTAINER_ROOT, mountRoot: MOUNT_ROOT })
twoMachines.setResolved([
  { localPrefix: MIRROR + HOST_FOLDER, host: 'nas', world: 'container', container: 'c1', remotePath: '/workspaces/one' },
  { localPrefix: MOUNT_ROOT + '/eu/srv/app', host: 'eu', world: 'host', remotePath: '/srv/app' },
])
// The plugin derives this from the resolved container worlds; the resolver needs it to
// recognise the raw container spelling it is about to hand out.
twoMachines.setKnownRoots(['/workspaces/one'])
check(
  'two workspaces on two machines resolve independently',
  where(twoMachines, MIRROR + HOST_FOLDER + '/x') === 'nas/container:/workspaces/one/x'
  && where(twoMachines, MOUNT_ROOT + '/eu/srv/app/y') === 'eu/host:/srv/app/y',
)
check(
  'the raw host spelling of the second machine resolves back to it',
  where(twoMachines, '/srv/app/y') === 'eu/host:/srv/app/y',
)
check('toContainer declines a host-world path', twoMachines.toContainer('/srv/app/y') === undefined)
check('toContainer answers for the container world', twoMachines.toContainer('/workspaces/one/x') === '/workspaces/one/x')

console.log('\n-- longest prefix wins --')
const nested = new Worlds({ sshHost: DEFAULT_HOST, containerRoot: CONTAINER_ROOT, mountRoot: MOUNT_ROOT })
nested.setResolved([
  { localPrefix: MIRROR + '/volume1', host: 'nas', world: 'host', remotePath: '/volume1' },
  { localPrefix: MIRROR + HOST_FOLDER, host: 'nas', world: 'container', container: 'c1', remotePath: CONTAINER_ROOT },
])
check(
  'the more specific mapping answers for its own subtree',
  where(nested, MIRROR + HOST_FOLDER + '/x') === 'nas/container:' + CONTAINER_ROOT + '/x',
)
check('the broader mapping answers elsewhere', where(nested, MIRROR + '/volume1/other/x') === 'nas/host:/volume1/other/x')

console.log('\n-- the explicit pair, unchanged, belongs to the default host --')
const paired = new Worlds({ sshHost: DEFAULT_HOST, containerRoot: CONTAINER_ROOT, mountPoint: MOUNT_POINT })
check(
  'the stand-in maps onto the configured container root',
  where(paired, MOUNT_POINT + '/cmd/main.go') === DEFAULT_HOST + '/container:' + CONTAINER_ROOT + '/cmd/main.go',
)
check('the stand-in root maps to the container root', where(paired, MOUNT_POINT) === DEFAULT_HOST + '/container:' + CONTAINER_ROOT)
check('toContainer agrees', paired.toContainer(MOUNT_POINT + '/go.mod') === CONTAINER_ROOT + '/go.mod')
check('raw container spelling still resolves', where(paired, CONTAINER_ROOT + '/go.mod') === DEFAULT_HOST + '/container:' + CONTAINER_ROOT + '/go.mod')
check('a sibling directory stays local', where(paired, '/Users/you/.dsh/devcontainer/other') === 'local')
check('toMount reverses the pair', paired.toMount(CONTAINER_ROOT + '/go.mod') === MOUNT_POINT + '/go.mod')

console.log('\n-- both configured at once --')
const both = new Worlds({ sshHost: DEFAULT_HOST, containerRoot: CONTAINER_ROOT, mountPoint: MOUNT_POINT, mountRoot: MOUNT_ROOT })
check(
  'the pair reaches the container and the mirror reaches the host',
  where(both, MOUNT_POINT + '/go.mod') === DEFAULT_HOST + '/container:' + CONTAINER_ROOT + '/go.mod'
  && where(both, MIRROR + '/etc/hosts') === DEFAULT_HOST + '/host:/etc/hosts',
)

console.log('\n-- the "/" guard --')
// `containerRoot` defaults to `/`. Accepting it as a known root would classify every
// absolute path -- ordinary local ones included -- as a container path.
const bare = new Worlds({ sshHost: DEFAULT_HOST, containerRoot: '/', mountRoot: MOUNT_ROOT })
check('a default containerRoot of "/" does not swallow local paths', where(bare, '/Users/you/code') === 'local')
check('the mirror still works alongside it', where(bare, MIRROR + '/etc') === DEFAULT_HOST + '/host:/etc')
const slashy = new Worlds({ sshHost: DEFAULT_HOST, containerRoot: '/' })
slashy.setKnownRoots(['/'])
check('a derived root of "/" is ignored too', where(slashy, '/Users/you/code') === 'local')

console.log('\n-- derived container roots --')
const derived = new Worlds({ sshHost: DEFAULT_HOST, containerRoot: CONTAINER_ROOT, mountRoot: MOUNT_ROOT })
derived.setKnownRoots(['/workspaces/Other'])
check(
  'a root learned from a registered workspace resolves in its raw spelling',
  where(derived, '/workspaces/Other/src/app.go') === DEFAULT_HOST + '/container:/workspaces/Other/src/app.go',
)
check('an unrelated container path is still not a container path', where(derived, '/workspaces/Third') === 'local')

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'))
process.exit(failures === 0 ? 0 : 1)

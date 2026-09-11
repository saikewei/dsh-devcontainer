// Unit test for the world resolver. No container, no harness: `Worlds` is pure, and these
// rules decide whether a path is executed locally, on the remote host, or inside the dev
// container — so they are worth guarding on their own.
import { Worlds } from '../lib/routing.js'

let failures = 0
const check = (label, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
  if (!ok) failures++
}
const where = (worlds, path) => {
  const located = worlds.locate(path)
  return located === undefined ? 'local' : located.world + ':' + located.path
}

const MOUNT_ROOT = '/Users/you/.dsh/devcontainer/root'
const MOUNT_POINT = '/Users/you/.dsh/devcontainer/ShutterSeek'
const CONTAINER_ROOT = '/workspaces/ShutterSeek'
const HOST_FOLDER = '/volume1/docker/ShutterSeek'

console.log('-- the structural mirror is the HOST, by definition --')
const mirrored = new Worlds({ containerRoot: CONTAINER_ROOT, mountRoot: MOUNT_ROOT })
check(
  'a mirrored path names the host path it stands for',
  where(mirrored, MOUNT_ROOT + HOST_FOLDER + '/go.mod') === 'host:' + HOST_FOLDER + '/go.mod',
)
check('the mirror is total: any host directory is addressable', where(mirrored, MOUNT_ROOT + '/etc') === 'host:/etc')
check('the mirror root is the host root', where(mirrored, MOUNT_ROOT) === 'host:/')
check('mirrorPath derives the same thing without consulting any resolution', mirrored.mirrorPath(MOUNT_ROOT + HOST_FOLDER) === HOST_FOLDER)
check('mirrorPath declines a path outside the mirror', mirrored.mirrorPath('/Users/you/code') === undefined)
check('a plain local path stays local', where(mirrored, '/Users/you/code/other') === 'local')
check('a platform temp path stays local', where(mirrored, '/tmp/scratch') === 'local')

console.log('\n-- resolved mappings decide the world --')
const resolved = new Worlds({ containerRoot: CONTAINER_ROOT, mountRoot: MOUNT_ROOT })
resolved.setResolved([
  { localPrefix: MOUNT_ROOT + HOST_FOLDER, world: 'container', remotePath: CONTAINER_ROOT },
])
check(
  'a mirrored workspace that has a dev container resolves into it',
  where(resolved, MOUNT_ROOT + HOST_FOLDER + '/cmd/main.go') === 'container:' + CONTAINER_ROOT + '/cmd/main.go',
)
check(
  'the container path it hands out resolves back to the same world',
  where(resolved, CONTAINER_ROOT + '/cmd/main.go') === 'container:' + CONTAINER_ROOT + '/cmd/main.go',
)
check('the mirror is still a host path outside that workspace', where(resolved, MOUNT_ROOT + '/etc') === 'host:/etc')

const hostOnly = new Worlds({ containerRoot: CONTAINER_ROOT, mountRoot: MOUNT_ROOT })
hostOnly.setResolved([{ localPrefix: MOUNT_ROOT + HOST_FOLDER, world: 'host', remotePath: HOST_FOLDER }])
check(
  'a mirrored workspace with no dev container stays on the host',
  where(hostOnly, MOUNT_ROOT + HOST_FOLDER + '/go.mod') === 'host:' + HOST_FOLDER + '/go.mod',
)
check(
  'the raw host spelling it hands out resolves back to the host',
  where(hostOnly, HOST_FOLDER + '/go.mod') === 'host:' + HOST_FOLDER + '/go.mod',
)
check('toContainer declines a host-world path', hostOnly.toContainer(HOST_FOLDER + '/go.mod') === undefined)

console.log('\n-- longest prefix wins --')
const nested = new Worlds({ containerRoot: CONTAINER_ROOT, mountRoot: MOUNT_ROOT })
nested.setResolved([
  { localPrefix: MOUNT_ROOT + '/volume1', world: 'host', remotePath: '/volume1' },
  { localPrefix: MOUNT_ROOT + HOST_FOLDER, world: 'container', remotePath: CONTAINER_ROOT },
])
check(
  'the more specific mapping answers for its own subtree',
  where(nested, MOUNT_ROOT + HOST_FOLDER + '/x') === 'container:' + CONTAINER_ROOT + '/x',
)
check('the broader mapping answers elsewhere', where(nested, MOUNT_ROOT + '/volume1/other/x') === 'host:/volume1/other/x')

console.log('\n-- the explicit pair, unchanged --')
const paired = new Worlds({ containerRoot: CONTAINER_ROOT, mountPoint: MOUNT_POINT })
check(
  'the stand-in maps onto the configured container root',
  where(paired, MOUNT_POINT + '/cmd/main.go') === 'container:' + CONTAINER_ROOT + '/cmd/main.go',
)
check('the stand-in root maps to the container root', where(paired, MOUNT_POINT) === 'container:' + CONTAINER_ROOT)
check('toContainer agrees', paired.toContainer(MOUNT_POINT + '/go.mod') === CONTAINER_ROOT + '/go.mod')
check('raw container spelling still resolves', where(paired, CONTAINER_ROOT + '/go.mod') === 'container:' + CONTAINER_ROOT + '/go.mod')
check('a sibling directory stays local', where(paired, '/Users/you/.dsh/devcontainer/other') === 'local')
check('toMount reverses the pair', paired.toMount(CONTAINER_ROOT + '/go.mod') === MOUNT_POINT + '/go.mod')

console.log('\n-- both configured at once --')
const both = new Worlds({ containerRoot: CONTAINER_ROOT, mountPoint: MOUNT_POINT, mountRoot: MOUNT_ROOT })
check(
  'the pair still reaches the container and the mirror still reaches the host',
  where(both, MOUNT_POINT + '/go.mod') === 'container:' + CONTAINER_ROOT + '/go.mod'
  && where(both, MOUNT_ROOT + '/etc/hosts') === 'host:/etc/hosts',
)

console.log('\n-- the "/" guard --')
// `containerRoot` defaults to `/`. Accepting it as a known root would classify every
// absolute path -- ordinary local ones included -- as a container path.
const bare = new Worlds({ containerRoot: '/', mountRoot: MOUNT_ROOT })
check('a default containerRoot of "/" does not swallow local paths', where(bare, '/Users/you/code') === 'local')
check('the mirror still works alongside it', where(bare, MOUNT_ROOT + '/etc') === 'host:/etc')
const slashy = new Worlds({ containerRoot: '/' })
slashy.setKnownRoots(['/'])
check('a derived root of "/" is ignored too', where(slashy, '/Users/you/code') === 'local')

console.log('\n-- derived container roots --')
const derived = new Worlds({ containerRoot: CONTAINER_ROOT, mountRoot: MOUNT_ROOT })
derived.setKnownRoots(['/workspaces/Other'])
check(
  'a root learned from a registered workspace resolves in its raw spelling',
  where(derived, '/workspaces/Other/src/app.go') === 'container:/workspaces/Other/src/app.go',
)
check('an unrelated container path is still not a container path', where(derived, '/workspaces/Third') === 'local')

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'))
process.exit(failures === 0 ? 0 : 1)

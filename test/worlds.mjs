// Unit test for the two-world path mapping. No container, no harness: `Worlds` is pure, and
// these rules decide whether a path is executed locally or inside the container, so they are
// worth guarding on their own.
import { Worlds } from '../lib/routing.js'

let failures = 0
const check = (label, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
  if (!ok) failures++
}

const MOUNT_ROOT = '/Users/you/.dsh/devcontainer/root'
const MOUNT_POINT = '/Users/you/.dsh/devcontainer/ShutterSeek'
const CONTAINER_ROOT = '/workspaces/ShutterSeek'

console.log('-- structural mirror (mountRoot) --')
const mirrored = new Worlds({ containerRoot: CONTAINER_ROOT, mountRoot: MOUNT_ROOT })
check(
  'a mirrored project path maps to its container path',
  mirrored.toContainer(MOUNT_ROOT + '/workspaces/ShutterSeek/go.mod') === '/workspaces/ShutterSeek/go.mod',
)
check(
  'the mirror is total: any container directory is addressable',
  mirrored.toContainer(MOUNT_ROOT + '/etc/hosts') === '/etc/hosts',
)
check('the mirror root itself is the container root', mirrored.toContainer(MOUNT_ROOT) === '/')
check(
  'a container path round-trips through the mirror',
  mirrored.toMountRootPath('/var/log') === MOUNT_ROOT + '/var/log',
)
check('raw container spelling still resolves', mirrored.toContainer('/workspaces/ShutterSeek') === CONTAINER_ROOT)
check('a local path stays local', mirrored.toContainer('/Users/you/code/other') === undefined)
check('a platform temp path stays local', mirrored.toContainer('/tmp/scratch') === undefined)

console.log('\n-- explicit pair (mountPoint), no mirror --')
const paired = new Worlds({ containerRoot: CONTAINER_ROOT, mountPoint: MOUNT_POINT })
check(
  'the stand-in maps onto the configured container root',
  paired.toContainer(MOUNT_POINT + '/cmd/main.go') === CONTAINER_ROOT + '/cmd/main.go',
)
check('the stand-in root maps to the container root', paired.toContainer(MOUNT_POINT) === CONTAINER_ROOT)
check('raw container spelling still resolves', paired.toContainer(CONTAINER_ROOT + '/go.mod') === CONTAINER_ROOT + '/go.mod')
check('a sibling directory stays local', paired.toContainer('/Users/you/.dsh/devcontainer/other') === undefined)
check('toMount reverses the pair', paired.toMount(CONTAINER_ROOT + '/go.mod') === MOUNT_POINT + '/go.mod')

console.log('\n-- both configured (the deployment that adds a mirror later) --')
const both = new Worlds({ containerRoot: CONTAINER_ROOT, mountPoint: MOUNT_POINT, mountRoot: MOUNT_ROOT })
check(
  'the mirror wins for paths under it, and the pair still works',
  both.toContainer(MOUNT_POINT + '/go.mod') === CONTAINER_ROOT + '/go.mod'
  && both.toContainer(MOUNT_ROOT + '/workspaces/Other/go.mod') === '/workspaces/Other/go.mod',
)
check('toMount prefers the mirror when one is configured', both.toMount('/etc/hosts') === MOUNT_ROOT + '/etc/hosts')

console.log('\n-- the `/` guard --')
// `containerRoot` defaults to `/`. Accepting it as a known root would classify every
// absolute path -- ordinary local ones included -- as a container path.
const bare = new Worlds({ containerRoot: '/', mountRoot: MOUNT_ROOT })
check('a default containerRoot of "/" does not swallow local paths', bare.toContainer('/Users/you/code') === undefined)
check('the mirror still works alongside it', bare.toContainer(MOUNT_ROOT + '/etc') === '/etc')

console.log('\n-- derived roots --')
const derived = new Worlds({ containerRoot: CONTAINER_ROOT, mountRoot: MOUNT_ROOT })
derived.setKnownRoots(['/workspaces/Other'])
check(
  'a root learned from a registered workspace resolves in its raw spelling',
  derived.toContainer('/workspaces/Other/src/app.go') === '/workspaces/Other/src/app.go',
)
check('an unrelated container path is still not a container path', derived.toContainer('/workspaces/Third') === undefined)
const slashy = new Worlds({ containerRoot: '/' })
slashy.setKnownRoots(['/'])
check('a derived root of "/" is ignored too', slashy.toContainer('/Users/you/code') === undefined)

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'))
process.exit(failures === 0 ? 0 : 1)

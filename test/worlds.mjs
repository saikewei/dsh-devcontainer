// Unit test for the world resolver. No container, no harness: `Worlds` is pure, and these
// rules decide WHICH MACHINE and WHICH WORLD a path is executed in — so they are worth
// guarding on their own.
import { Worlds } from '../lib/routing.js'
import { probeCache } from '../lib/index.js'

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
const MOUNT_POINT = '/Users/you/.dsh/devcontainer/my-project'
const CONTAINER_ROOT = '/workspaces/my-project'
const HOST_FOLDER = '/volume1/docker/my-project'
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
  { localPrefix: MIRROR + HOST_FOLDER, host: 'nas', world: 'container', container: 'my-project-devcontainer', remotePath: CONTAINER_ROOT },
])
check(
  'a mirrored workspace with a dev container resolves into it, on its own machine',
  where(resolved, MIRROR + HOST_FOLDER + '/cmd/main.go') === 'nas/container:' + CONTAINER_ROOT + '/cmd/main.go',
)
check(
  'the resolver reports which container',
  resolved.locate(MIRROR + HOST_FOLDER)?.container === 'my-project-devcontainer',
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

// `knownRoots` is published to the browser, which prefix-tests it to decide whether an address
// is a container file. The configured `containerRoot` and the resolved mapping for the SAME
// folder are seeded independently — deliberately, so configuration answers before discovery —
// so a caller listing them would otherwise see the same root twice.
const deduped = new Worlds({ sshHost: DEFAULT_HOST, containerRoot: CONTAINER_ROOT, mountRoot: MOUNT_ROOT })
deduped.setResolved([
  { localPrefix: MOUNT_ROOT + '/' + DEFAULT_HOST + '/volume1/docker/proj', host: DEFAULT_HOST, world: 'container', container: 'proj-dev', remotePath: CONTAINER_ROOT },
])
check(
  'the configured root and the resolved one are reported ONCE',
  deduped.knownRoots.filter((entry) => entry.path === CONTAINER_ROOT).length === 1,
  JSON.stringify(deduped.knownRoots),
)
check(
  'and the surviving entry still names its machine',
  deduped.knownRoots.every((entry) => entry.host === DEFAULT_HOST && entry.path !== '/'),
  JSON.stringify(deduped.knownRoots),
)

console.log('\n-- an undecided mirror folder is a PLACEHOLDER, not an answer --')
// The failure this guards: `locate` answers a mirrored path no decision covers yet with
// `host`, and acting on that answer runs a container command on the NAS — right machine,
// wrong toolchain, wrong paths, and nothing to notice. So the placeholder is flagged, and
// `ensure` is what turns it into a decision.
const undecided = new Worlds({ sshHost: DEFAULT_HOST, containerRoot: CONTAINER_ROOT, mountRoot: MOUNT_ROOT })
const placeholder = undecided.locate(MIRROR + HOST_FOLDER + '/go.mod')
check('locate still names the machine and the host spelling', placeholder?.host === DEFAULT_HOST && placeholder?.path === HOST_FOLDER + '/go.mod')
check('but flags the answer provisional', placeholder?.provisional === true, JSON.stringify(placeholder))
check('a decided mapping is not provisional', resolved.locate(MIRROR + HOST_FOLDER)?.provisional === undefined)
check('nor is an ordinary local path', undecided.locate('/Users/you/code') === undefined)

console.log('\n-- ensure settles it --')
// The resolver's real contract, in the shape the plugin implements it: find the LONGEST
// labelled folder containing the path, and answer for THAT folder. A decision is only ever as
// broad as the question that produced it, which is why a container decision is recorded for
// the folder and a "no container" decision for the path alone.
const LABELLED = [
  { hostFolder: HOST_FOLDER, name: 'c1', containerPath: CONTAINER_ROOT },
  { hostFolder: '/volume1/docker/deep', name: 'c2', containerPath: '/workspaces/deep' },
]
const probes = []
const resolverFor = (folders) => ({ host, path }) => {
  probes.push(host + ':' + path)
  if (host === 'down') throw new Error('docker is not usable on down')
  let owner
  for (const folder of folders) {
    if (path !== folder.hostFolder && !path.startsWith(folder.hostFolder + '/')) continue
    if (owner === undefined || folder.hostFolder.length > owner.hostFolder.length) owner = folder
  }
  if (owner === undefined) return { world: 'host', folder: path, remotePath: path }
  return { world: 'container', container: owner.name, folder: owner.hostFolder, remotePath: owner.containerPath }
}
const decided = new Worlds(
  { sshHost: DEFAULT_HOST, containerRoot: CONTAINER_ROOT, mountRoot: MOUNT_ROOT },
  resolverFor(LABELLED),
)
const settledByProbe = await decided.ensure(MIRROR + HOST_FOLDER + '/go.mod')
check('the folder is asked about, once, with machine and host path', probes.join(',') === DEFAULT_HOST + ':' + HOST_FOLDER + '/go.mod', probes.join(','))
check('and the answer is the container', settledByProbe?.world === 'container' && settledByProbe?.container === 'c1')
check('at the container path', settledByProbe?.path === CONTAINER_ROOT + '/go.mod', String(settledByProbe?.path))
check('the mapping is recorded, so locate agrees from now on', where(decided, MIRROR + HOST_FOLDER + '/x') === DEFAULT_HOST + '/container:' + CONTAINER_ROOT + '/x')
check('and locate is no longer provisional', decided.locate(MIRROR + HOST_FOLDER)?.provisional === undefined)
check(
  'the decision covers the whole folder, not just the path asked about',
  where(decided, MIRROR + HOST_FOLDER + '/deep/nested/x.go') === DEFAULT_HOST + '/container:' + CONTAINER_ROOT + '/deep/nested/x.go',
)

// A decision that routes INTO a container while leaving that container's own spelling
// unrecognized is a one-way door: the tools report container paths and the model hands them
// straight back. So the root is DERIVED from the decision. This instance configures no
// `containerRoot` at all, so the derived root is the only thing that can answer for it.
const elsewhere = new Worlds(
  { sshHost: DEFAULT_HOST, containerRoot: '/', mountRoot: MOUNT_ROOT },
  async ({ path }) => ({ world: 'container', container: 'c9', folder: '/srv/proj', remotePath: '/workspaces/elsewhere' }),
)
check('before any decision the container spelling is not a container path', where(elsewhere, '/workspaces/elsewhere/x.go') === 'local')
await elsewhere.ensure(MIRROR + '/srv/proj/x.go')
check(
  'after a decision the container path it handed out resolves back to the same target',
  where(elsewhere, '/workspaces/elsewhere/x.go') === DEFAULT_HOST + '/container:/workspaces/elsewhere/x.go',
)
check('and so does the whole subtree', where(elsewhere, '/workspaces/elsewhere/deep/y.go') === DEFAULT_HOST + '/container:/workspaces/elsewhere/deep/y.go')
check('while an unrelated container path is still not one', where(elsewhere, '/workspaces/other/y.go') === 'local')

console.log('\n-- a nested dev container is the more specific answer --')
// Descendant FIRST, then the ancestor: every mapping comes from the same label index and the
// resolver always answers for the most specific folder above the path, so the deeper mapping is
// strictly the better answer for its own subtree. Installing the ancestor must not throw it
// away — that would route a nested project through its parent's container.
const ordered = new Worlds(
  { sshHost: DEFAULT_HOST, containerRoot: '/', mountRoot: MOUNT_ROOT },
  resolverFor(LABELLED),
)
await ordered.ensure(MIRROR + '/volume1/docker/deep/cmd/x.go')
check(
  'the nested folder is decided first',
  ordered.covering(MIRROR + '/volume1/docker/deep/cmd/x.go')?.remotePath === '/workspaces/deep',
  JSON.stringify(ordered.covering(MIRROR + '/volume1/docker/deep/cmd/x.go')),
)
// An ancestor of BOTH labelled folders, so its own decision is genuinely broader.
const broader = new Worlds(
  { sshHost: DEFAULT_HOST, containerRoot: '/', mountRoot: MOUNT_ROOT },
  resolverFor([{ hostFolder: '/volume1/docker', name: 'outer', containerPath: '/workspaces/docker' }, ...LABELLED]),
)
await broader.ensure(MIRROR + '/volume1/docker/deep/cmd/x.go')
await broader.ensure(MIRROR + '/volume1/docker/anything/y.go')
check(
  'a later, broader decision does not displace the nested one',
  broader.covering(MIRROR + '/volume1/docker/deep/cmd/x.go')?.remotePath === '/workspaces/deep',
  JSON.stringify(broader.covering(MIRROR + '/volume1/docker/deep/cmd/x.go')),
)
check(
  'and the broader decision answers for everything outside it',
  where(broader, MIRROR + '/volume1/docker/anything/y.go') === DEFAULT_HOST + '/container:/workspaces/docker/anything/y.go',
  where(broader, MIRROR + '/volume1/docker/anything/y.go'),
)

const nestedAnswer = await decided.ensure(MIRROR + '/volume1/docker/deep/cmd/x.go')
check(
  'the nested container wins for its own subtree',
  nestedAnswer?.world === 'container' && nestedAnswer.container === 'c2' && nestedAnswer.path === '/workspaces/deep/cmd/x.go',
  JSON.stringify(nestedAnswer),
)
check('and the outer decision still answers for its own subtree', decided.locate(MIRROR + HOST_FOLDER)?.container === 'c1')
check('the nested decision did not displace it', decided.covering(MIRROR + HOST_FOLDER)?.container === 'c1')

console.log('\n-- ensure costs one probe per folder, and caches --')
probes.length = 0
await decided.ensure(MIRROR + HOST_FOLDER + '/a.go')
await decided.ensure(MIRROR + HOST_FOLDER + '/deep/nested/b.go')
check('a decided folder is not asked about again', probes.length === 0, probes.join(','))

probes.length = 0
const fresh = new Worlds(
  { sshHost: DEFAULT_HOST, containerRoot: CONTAINER_ROOT, mountRoot: MOUNT_ROOT },
  async ({ path }) => {
    probes.push(path)
    await new Promise((resolve) => setTimeout(resolve, 20))
    return { world: 'host', folder: path, remotePath: path }
  },
)
await Promise.all([
  fresh.ensure(MIRROR + '/srv/app/a.go'),
  fresh.ensure(MIRROR + '/srv/app/b.go'),
  fresh.ensure(MIRROR + '/srv/app/c.go'),
])
check('three concurrent first touches cost one probe per path, none repeated', probes.length === 3, String(probes.length))
check('and all three landed on the host path', where(fresh, MIRROR + '/srv/app/b.go') === DEFAULT_HOST + '/host:/srv/app/b.go')
probes.length = 0
await fresh.ensure(MIRROR + '/srv/app/a.go')
check('a decided path is not asked about again', probes.length === 0)
await fresh.ensure(MIRROR + '/srv/app/a.go', { maxAgeMs: 0 })
check('unless the caller says it is stale', probes.length === 1, probes.join(','))
probes.length = 0
await fresh.ensure(MIRROR + '/srv/app/deeper/a.go', { maxAgeMs: 0 })
check('a path with no decision of its own is asked about', probes.length === 1, probes.join(','))

console.log('\n-- a lookup that FAILS is not an answer --')
// The mirror is `<root>/<machine>/<path>`, so a different machine is a different first segment
// — not another path segment under this one.
let refused = null
try {
  await decided.ensure(MOUNT_ROOT + '/down/srv/x.go')
} catch (error) {
  refused = String(error && error.message ? error.message : error)
}
check('an unreachable machine is REPORTED', refused !== null && refused.includes('not usable'), String(refused))
check('and it did not quietly become a host path', decided.covering(MOUNT_ROOT + '/down/srv/x.go') === undefined)
let stillRefused = null
try {
  await decided.ensure(MOUNT_ROOT + '/down/srv/x.go')
} catch (error) {
  stillRefused = String(error && error.message ? error.message : error)
}
check('a failure is not cached as an answer either', stillRefused !== null, String(stillRefused))

// A machine that was briefly unreachable must be re-asked, not remembered as broken — and not
// remembered as "the host", which is the same wrong answer with a longer lifetime.
let attempts = 0
const flaky = new Worlds(
  { sshHost: DEFAULT_HOST, containerRoot: CONTAINER_ROOT, mountRoot: MOUNT_ROOT },
  async ({ path }) => {
    attempts++
    if (attempts === 1) throw new Error('Connection timed out')
    return { world: 'host', folder: path, remotePath: path }
  },
)
const firstTry = await flaky.ensure(MIRROR + '/srv/app/x.go').then(() => 'answered', () => 'refused')
check('the first attempt is refused, not answered', firstTry === 'refused', firstTry)
const secondTry = await flaky.ensure(MIRROR + '/srv/app/x.go').then((located) => located?.world ?? 'local', (error) => 'refused: ' + String(error.message))
check('the next attempt is answered for real', secondTry === 'host', secondTry)

const resolverless = new Worlds({ sshHost: DEFAULT_HOST, containerRoot: CONTAINER_ROOT, mountRoot: MOUNT_ROOT })
let blind = null
try {
  await resolverless.ensure(MIRROR + HOST_FOLDER)
} catch (error) {
  blind = String(error && error.message ? error.message : error)
}
check('a resolver with no discovery function refuses rather than answering host', blind !== null && blind.includes('discovery function'), String(blind))

console.log('\n-- ensure leaves everything else alone --')
probes.length = 0
check('a local path is answered without a probe', (await decided.ensure('/Users/you/code/x')) === undefined)
const pairedProbe = []
const pairedEnsured = new Worlds(
  { sshHost: DEFAULT_HOST, containerRoot: CONTAINER_ROOT, mountPoint: MOUNT_POINT, mountRoot: MOUNT_ROOT },
  async ({ path }) => {
    pairedProbe.push(path)
    return { world: 'host', remotePath: path }
  },
)
const pairAnswer = await pairedEnsured.ensure(MOUNT_POINT + '/go.mod')
check('the explicit pair is answered structurally, without a probe', pairedProbe.length === 0, pairedProbe.join(','))
check('and it is the container', pairAnswer?.world === 'container' && pairAnswer?.path === CONTAINER_ROOT + '/go.mod', JSON.stringify(pairAnswer))
check('a local path is still local with a resolver present', (await pairedEnsured.ensure('/Users/you/code/x')) === undefined)

// A resolver that answers about some OTHER folder has not answered the question that was
// asked. Believing it would leave the path undecided while claiming a decision — the original
// failure wearing a different hat.
const misdirected = new Worlds(
  { sshHost: DEFAULT_HOST, containerRoot: '/', mountRoot: MOUNT_ROOT },
  async () => ({ world: 'container', container: 'c1', folder: '/srv/somewhere-else', remotePath: '/workspaces/elsewhere' }),
)
let wrongFolder = null
try {
  await misdirected.ensure(MIRROR + '/srv/app/x.go')
} catch (error) {
  wrongFolder = String(error && error.message ? error.message : error)
}
check('an answer about an unrelated folder is refused, not believed', wrongFolder !== null && wrongFolder.includes('still undecided'), String(wrongFolder))
check('nothing was decided for the path that was asked about', misdirected.covering(MIRROR + '/srv/app/x.go') === undefined)
check('and locate still calls it a placeholder', misdirected.locate(MIRROR + '/srv/app/x.go')?.provisional === true)

console.log('\n-- the remote-answer cache --')
// `Worlds` refuses to guess, but the SSH answers underneath it are cached, and a cache that
// remembers a failure is a slower way of guessing: the folder would stay undecided for the
// whole lifetime even after the machine came back.
const answers = probeCache(60_000)
let lookups = 0
const lookup = (answer) => () => {
  lookups++
  return answer === 'fail' ? Promise.reject(new Error('Connection timed out')) : Promise.resolve(answer)
}
const failed = await answers('nas|index', lookup('fail')).then(() => 'answered', (error) => String(error.message))
check('a failure reaches the caller', failed === 'Connection timed out', failed)
const retried = await answers('nas|index', lookup('recovered')).then((value) => value, () => 'still failing')
check('and the next caller asks again', retried === 'recovered' && lookups === 2, retried + ' after ' + String(lookups) + ' lookups')

lookups = 0
const cached = await Promise.all([answers('nas|fresh', lookup('first')), answers('nas|fresh', lookup('second'))])
check('a success is shared, not re-fetched', lookups === 1 && cached[0] === 'first' && cached[1] === 'first', String(lookups))
lookups = 0
await answers('nas|fresh', lookup('never runs'))
check('and it is served from the cache afterwards', lookups === 0)
lookups = 0
const otherHost = await answers('eu|index', lookup('eu-answer'))
check('a different key is fetched on its own', lookups === 1 && otherHost === 'eu-answer', String(lookups))

const shortLived = probeCache(0)
lookups = 0
await shortLived('nas|index', lookup('one'))
await shortLived('nas|index', lookup('two'))
check('a zero-lifetime cache re-asks every time', lookups === 2, String(lookups))

const undefinedAnswer = probeCache(60_000)
lookups = 0
const nothing = await undefinedAnswer('nas|gone', lookup(undefined))
const nothingAgain = await undefinedAnswer('nas|gone', lookup(undefined))
check('"we asked and the answer was nothing" is cached as an answer', lookups === 1 && nothing === undefined && nothingAgain === undefined, String(lookups))

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'))
process.exit(failures === 0 ? 0 : 1)

// The world decision for one mirrored host path. No container, no harness, no SSH: the label
// index and the container descriptions are fakes, so the RULES are what is under test.
//
// They are worth their own suite because getting them wrong is silent. A container command that
// runs on the host has the right machine and the wrong everything else, and prints no error —
// which is exactly how this plugin shipped that bug once.
import { createFolderResolver, routeOf, isRoutedSession, sessionCwdOf } from '../lib/route.js'

let failures = 0
const check = (label, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
  if (!ok) failures++
}

const HOST = 'nas'
const MOUNT_ROOT = '/Users/you/.dsh/devcontainer/root'

/** The index a host reports, and the mounts its containers have. */
function fakeHost({ folders = [], mounts = {}, foldersFail = null }) {
  const asked = { folders: [], describes: [] }
  return {
    asked,
    containersFor: () => ({
      async folders() {
        asked.folders.push(HOST)
        if (foldersFail !== null) throw new Error(foldersFail)
        return folders.map((folder) => ({ ...folder, status: 'running' }))
      },
      async describe(name) {
        asked.describes.push(name)
        return mounts[name]
      },
    }),
    // No caching in the unit under test: the plugin supplies `probeCache`, which has its own
    // suite elsewhere, and a cache here would hide how many times the rule asked.
    foldersOn: (_host, run) => Promise.resolve().then(run),
    describedOn: (_key, run) => Promise.resolve().then(run),
  }
}

const folder = (name, hostFolder, containerPath) => ({ name, hostFolder, containerPath })
const mountsOf = (folders) =>
  Object.fromEntries(folders.map((entry) => [entry.name, {
    name: entry.name,
    hostFolder: entry.hostFolder,
    containerPath: entry.containerPath,
    status: 'running',
  }]))

console.log('-- a path inside a labelled folder --')
{
  const index = [folder('epic', '/volume1/docker/proj', '/workspaces/proj')]
  const host = fakeHost({ folders: index, mounts: mountsOf(index) })
  const resolve = createFolderResolver(host)
  const answer = await resolve({ host: HOST, path: '/volume1/docker/proj/cmd/main.go' })
  console.log(JSON.stringify(answer))
  check('the folder answers for a path beneath it', answer.world === 'container' && answer.container === 'epic')
  check('and the mapping is recorded for the FOLDER', answer.folder === '/volume1/docker/proj', String(answer.folder))
  check('mapped to the container path the folder is mounted at', answer.remotePath === '/workspaces/proj', String(answer.remotePath))
  check('a file path is answered, which a --filter query could not do', host.asked.folders.length === 1)
}

console.log('\n-- a path no labelled folder contains --')
{
  const host = fakeHost({ folders: [], mounts: {} })
  const resolve = createFolderResolver(host)
  const answer = await resolve({ host: HOST, path: '/volume1/docker/other/x.go' })
  check('the host answers', answer.world === 'host')
  check('recording the mapping for the PATH alone, not its directory', answer.folder === '/volume1/docker/other/x.go', String(answer.folder))
  check('at its own spelling', answer.remotePath === '/volume1/docker/other/x.go')
  check('and nothing was inspected', host.asked.describes.length === 0, host.asked.describes.join(','))
}

console.log('\n-- nesting: the most specific folder wins --')
{
  const index = [
    folder('outer', '/srv/app', '/workspaces/app'),
    folder('inner', '/srv/app/cmd', '/workspaces/cmd'),
  ]
  const host = fakeHost({ folders: index, mounts: mountsOf(index) })
  const resolve = createFolderResolver(host)
  const inside = await resolve({ host: HOST, path: '/srv/app/cmd/main.go' })
  check('the nested container answers for its own subtree', inside.container === 'inner', String(inside.container))
  check('mapped at its own container path', inside.remotePath === '/workspaces/cmd', String(inside.remotePath))
  const outside = await resolve({ host: HOST, path: '/srv/app/README.md' })
  check('and the outer one for everything else', outside.container === 'outer', String(outside.container))
  check('the outer container was not inspected for the nested path', host.asked.describes.join(',') === 'inner,outer', host.asked.describes.join(','))
}

console.log('\n-- a container that cannot serve its folder --')
{
  // The most specific folder HAS a container, but that container does not bind-mount it. The
  // path is still inside the parent folder's mount, so the parent is the answer — the host
  // would be a wrong answer about a path that is genuinely reachable inside a container.
  const index = [
    folder('outer', '/srv/app', '/workspaces/app'),
    folder('broken', '/srv/app/cmd', undefined),
  ]
  const host = fakeHost({ folders: index, mounts: mountsOf(index) })
  const resolve = createFolderResolver(host)
  const answer = await resolve({ host: HOST, path: '/srv/app/cmd/main.go' })
  console.log(JSON.stringify(answer))
  check('the unusable container is skipped', answer.container === 'outer', String(answer.container))
  check('and the next folder up answers instead', answer.folder === '/srv/app', String(answer.folder))
  check('NOT the host', answer.world === 'container', answer.world)
  check('both candidates were inspected, longest first', host.asked.describes.join(',') === 'broken,outer', host.asked.describes.join(','))

}

console.log('\n-- a folder whose only container cannot serve it --')
{
  const index = [folder('broken', '/srv/app/cmd', undefined)]
  const host = fakeHost({ folders: index, mounts: mountsOf(index) })
  const answer = await createFolderResolver(host)({ host: HOST, path: '/srv/app/cmd/main.go' })
  check('with nothing usable above it, the host is the answer', answer.world === 'host', JSON.stringify(answer))
  check('and the mapping is for the path alone', answer.folder === '/srv/app/cmd/main.go', String(answer.folder))
}

console.log('\n-- a machine that cannot be asked --')
{
  const host = fakeHost({ foldersFail: 'docker is not usable on nas: command not found' })
  const resolve = createFolderResolver(host)
  let refused = null
  try {
    await resolve({ host: HOST, path: '/srv/app/x.go' })
  } catch (error) {
    refused = String(error && error.message ? error.message : error)
  }
  check('the failure is REPORTED, not turned into an answer', refused !== null && refused.includes('not usable'), String(refused))
  let refusedAgain = null
  try {
    await resolve({ host: HOST, path: '/srv/app/x.go' })
  } catch (error) {
    refusedAgain = String(error && error.message ? error.message : error)
  }
  check('and asking again asks again', refusedAgain !== null && host.asked.folders.length === 2, String(host.asked.folders.length))
}

console.log('\n-- one label index per decision, not one per folder --')
{
  const index = [
    folder('a', '/srv/a', '/workspaces/a'),
    folder('b', '/srv/b', '/workspaces/b'),
  ]
  const host = fakeHost({ folders: index, mounts: mountsOf(index) })
  const resolve = createFolderResolver(host)
  await resolve({ host: HOST, path: '/srv/a/x.go' })
  await resolve({ host: HOST, path: '/srv/b/y.go' })
  check('each decision reads the index once', host.asked.folders.length === 2, String(host.asked.folders.length))
  check('and inspects only the container that matched', host.asked.describes.join(',') === 'a,b', host.asked.describes.join(','))
}

console.log('\n-- the session-level classification, unchanged --')
{
  const worlds = {
    locate: (path) => (path.startsWith(MOUNT_ROOT + '/' + HOST)
      ? { host: HOST, world: 'host', path: path.slice((MOUNT_ROOT + '/' + HOST).length), provisional: true }
      : undefined),
  }
  check('a mirrored cwd is a routed session even before the world is decided', isRoutedSession(worlds, MOUNT_ROOT + '/' + HOST + '/srv/app') === true)
  check('and is routed to the HOST for now, which is only a placeholder', routeOf(worlds, MOUNT_ROOT + '/' + HOST + '/srv/app').kind === 'host')
  check('a local cwd is not routed at all', isRoutedSession(worlds, '/Users/you/code') === false)
  check('no cwd is not routed either', isRoutedSession(worlds, undefined) === false)
  check('the session cwd is read from the header', sessionCwdOf({ agent: { session: { header: { cwd: '/x' } } } }) === '/x')
  check('and an absent one reads as undefined', sessionCwdOf({ agent: {} }) === undefined)
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'))
process.exit(failures === 0 ? 0 : 1)

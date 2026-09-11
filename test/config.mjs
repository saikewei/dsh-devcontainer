/**
 * Test configuration.
 *
 * Every suite in this directory is an INTEGRATION test: it drives a real Docker dev
 * container over a real SSH connection, so all of them need a live target. Nothing here
 * is specific to one machine — values come from, in order of precedence:
 *
 *   1. environment variables (see the table below), then
 *   2. `test/config.local.mjs`, a gitignored file you create from
 *      `test/config.example.mjs` to keep your own target out of the repository.
 *
 * | Variable                        | Meaning                                                   |
 * | ------------------------------- | --------------------------------------------------------- |
 * | `DSH_DEVCONTAINER_SSH_HOST`     | SSH destination, resolved through your own ssh config      |
 * | `DSH_DEVCONTAINER_CONTAINER`    | container name or id on that host                          |
 * | `DSH_DEVCONTAINER_CONTAINER_ROOT` | absolute path inside the container the tests operate on  |
 * | `DSH_DEVCONTAINER_HOST_ROOT`    | the same directory as the host sees it (informational)     |
 * | `DSH_DEVCONTAINER_MOUNT_POINT`  | local directory standing for the container root            |
 *
 * @module dsh-devcontainer/test/config
 */
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const localUrl = new URL('./config.local.mjs', import.meta.url)
const local = existsSync(fileURLToPath(localUrl)) ? (await import(localUrl.href)).default ?? {} : {}

const pick = (envName, localValue, fallback) =>
  process.env[envName] ?? (localValue === undefined || localValue === '' ? undefined : localValue) ?? fallback

export const CONFIG = {
  sshHost: pick('DSH_DEVCONTAINER_SSH_HOST', local.sshHost, ''),
  container: pick('DSH_DEVCONTAINER_CONTAINER', local.container, ''),
  containerRoot: pick('DSH_DEVCONTAINER_CONTAINER_ROOT', local.containerRoot, ''),
  hostRoot: pick('DSH_DEVCONTAINER_HOST_ROOT', local.hostRoot, ''),
  mountPoint: pick('DSH_DEVCONTAINER_MOUNT_POINT', local.mountPoint, join(tmpdir(), 'dsh-devcontainer-mnt')),
  /**
   * A local path outside both the workspace root and the platform temp areas, used to
   * prove the shipped local sandbox still denies a write. Derived from the home
   * directory so no absolute path is committed.
   */
  escapePath: join(homedir(), 'dsh-devcontainer-escape-check.txt'),
}

/** Fail loudly and usefully rather than letting every assertion fail on an empty target. */
export function requireTarget(...keys) {
  const missing = keys.filter((key) => CONFIG[key] === '')
  if (missing.length === 0) return
  const names = missing.map((key) => 'DSH_DEVCONTAINER_' + key.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase())
  throw new Error(
    'These integration tests need a live dev container. Set ' + names.join(', ')
    + ' (or copy test/config.example.mjs to test/config.local.mjs and fill it in).',
  )
}

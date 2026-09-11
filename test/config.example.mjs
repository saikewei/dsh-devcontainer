/**
 * Template for `test/config.local.mjs` — copy it, fill in YOUR target, and keep it out of
 * version control (`.gitignore` already excludes it). Environment variables override
 * these values, so this file is only a convenience.
 *
 *   cp test/config.example.mjs test/config.local.mjs
 */
export default {
  /** SSH destination, resolved through your own ~/.ssh/config. */
  sshHost: 'my-nas',
  /** Container name or id on that host. */
  container: 'my-project-devcontainer',
  /** Absolute path inside the container the tests operate on. */
  containerRoot: '/workspaces/my-project',
  /** The same directory as the host sees it, when it is a bind mount. Informational. */
  hostRoot: '/volume1/docker/my-project',
  /** Optional. Local directory standing for the container root. Defaults to a temp dir. */
  mountPoint: undefined,
}

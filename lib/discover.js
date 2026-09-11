/**
 * Dev container discovery.
 *
 * A container started from a `.devcontainer` is already self-describing: Dev Containers
 * writes `devcontainer.local_folder=<host folder>` and `devcontainer.config_file=<path>`
 * onto it, and Docker records the bind mount that maps that folder into the container.
 *
 * That matters because it means **`devcontainer up` does not have to be implemented** for
 * a container that already exists. The whole folder → container → container-path chain is
 * readable from Docker itself:
 *
 *   docker ps     --filter label=devcontainer.local_folder=<folder>   → the container
 *   docker inspect <container> --format '{{range .Mounts}}…'          → the container path
 *
 * @module dsh-devcontainer/discover
 */

/** POSIX single-quote a value that crosses into a remote shell. */
const shq = (value) => "'" + String(value).split("'").join("'\\''") + "'"

const UNIT = String.fromCharCode(31)
const FIELD = String.fromCharCode(30)

/**
 * Parse the `docker inspect` template output below.
 *
 * Records are separated by UNIT and fields within a mount by FIELD, deliberately not by
 * `|`: the top-level fields and the mount fields would collide on one separator, and the
 * mount table would be silently truncated to its first field.
 */
function parseInspect(text, hostFolder) {
  const records = text.split(UNIT)
  const mounts = []
  for (const record of records.slice(3)) {
    if (!record.trim()) continue
    const [type, source, destination, rw] = record.split(FIELD)
    if (type === undefined || source === undefined || destination === undefined) continue
    mounts.push({ type: type.trim(), source: source.trim(), destination: destination.trim(), rw: rw === undefined ? undefined : rw.trim() === 'true' })
  }
  const workspace = mounts.find((mount) => mount.type === 'bind' && mount.source === hostFolder)
  return { mounts, containerPath: workspace === undefined ? undefined : workspace.destination }
}

/** The `docker inspect` template: three scalars, then one record per mount. */
const INSPECT_FORMAT =
  '{{index .Config.Labels "devcontainer.local_folder"}}' + UNIT
  + '{{index .Config.Labels "devcontainer.config_file"}}' + UNIT
  + '{{.State.Status}}' + UNIT
  + '{{range .Mounts}}{{.Type}}' + FIELD + '{{.Source}}' + FIELD + '{{.Destination}}' + FIELD + '{{.RW}}' + UNIT + '{{end}}'

export class DevContainers {
  #transport

  constructor(transport) {
    this.#transport = transport
  }

  /**
   * Every container on this host that was created from a `.devcontainer`, with the host
   * folder each one belongs to and the container path that folder is mounted at.
   */
  async list() {
    const names = await this.#transport.collect(
      'docker ps -a --filter label=devcontainer.local_folder --format ' + shq('{{.Names}}'),
    )
    if (names.exitCode !== 0) {
      throw new Error('docker is not usable on ' + this.#transport.host + ': ' + (names.stderr.trim() || 'exit ' + String(names.exitCode)))
    }
    const found = []
    for (const name of names.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
      const described = await this.#describe(name)
      if (described !== undefined) found.push(described)
    }
    return found
  }

  /**
   * The container created from one host folder, running or not, or undefined when the
   * folder was never opened as a dev container.
   */
  async forFolder(hostFolder) {
    const listing = await this.#transport.collect(
      'docker ps -a --filter label=devcontainer.local_folder=' + shq(hostFolder) + ' --format ' + shq('{{.Names}}'),
    )
    if (listing.exitCode !== 0) {
      throw new Error('docker is not usable on ' + this.#transport.host + ': ' + (listing.stderr.trim() || 'exit ' + String(listing.exitCode)))
    }
    const name = listing.stdout.split('\n').map((line) => line.trim()).filter(Boolean)[0]
    return name === undefined ? undefined : await this.#describe(name, hostFolder)
  }

  /** One container's folder, config file, status, and mount table. */
  async #describe(name, hostFolder) {
    const inspected = await this.#transport.collect('docker inspect ' + shq(name) + ' --format ' + shq(INSPECT_FORMAT))
    if (inspected.exitCode !== 0) return undefined
    const [rawFolder = '', rawConfig = '', rawStatus = ''] = inspected.stdout.split(UNIT)
    const owner = (hostFolder ?? rawFolder).trim()
    const configFile = rawConfig.trim()
    const status = rawStatus.trim()
    const { mounts, containerPath } = parseInspect(inspected.stdout, owner)
    const parts = configFile.split('/')
    return {
      name,
      hostFolder: owner,
      configFile,
      // The workspace folder inside the container, when it is a plain bind mount of the
      // host folder. Undefined means the folder is not mounted and the container cannot
      // serve as the execution world for it.
      containerPath,
      mounts,
      status,
      running: status === 'running',
      hasDevcontainerDirectory: configFile.includes('/.devcontainer/'),
      projectName: parts.length > 2 ? parts[parts.length - 2] : undefined,
    }
  }

  /** Whether a host folder carries a `.devcontainer` directory, regardless of containers. */
  async hasDevcontainerConfig(hostFolder) {
    const probe = await this.#transport.collect(
      'test -f ' + shq(hostFolder + '/.devcontainer/devcontainer.json') + ' && echo yes || echo no',
    )
    return probe.stdout.trim() === 'yes'
  }

  /**
   * The full answer for one host folder: does it look like a dev-container project, and is
   * a container for it available?
   */
  async resolve(hostFolder) {
    const [hasConfig, container] = await Promise.all([
      this.hasDevcontainerConfig(hostFolder),
      this.forFolder(hostFolder),
    ])
    return {
      hostFolder,
      hasDevcontainerConfig: hasConfig,
      container,
      // Only true when the container can actually stand in for the folder: it must exist
      // and the folder must be mounted into it at a known path.
      usable: container !== undefined && container.containerPath !== undefined,
    }
  }

  /** Start a stopped container. Building one from scratch is `devcontainer` CLI territory. */
  async start(name) {
    const started = await this.#transport.collect('docker start ' + shq(name), { timeoutMs: 120000 })
    return { ok: started.exitCode === 0, message: (started.stderr || started.stdout).trim() }
  }
}

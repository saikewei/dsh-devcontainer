/**
 * Which remote machines this plugin may reach.
 *
 * The list is the operator's own `~/.ssh/config`, because that is where their machines
 * already are — aliases, identity files, ports and jump hosts all resolve through OpenSSH
 * itself when a command runs, so nothing here needs to understand key material.
 *
 * This module only needs the ALIASES and enough metadata to show a readable list. Anything
 * it cannot parse is not an error: OpenSSH is the authority on what a host means, and an
 * alias that looks fine here still fails loudly at connect time if its config is broken.
 *
 * @module dsh-devcontainer/hosts
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_CONFIG_PATH = join(homedir(), '.ssh', 'config')

/** A pattern, not a concrete machine: `Host *`, `Host *.example.com`, `Host a !b`. */
const isPattern = (alias) => /[*?!]/.test(alias)

/**
 * Parse one `ssh_config` file's `Host` blocks.
 *
 * Deliberately shallow. A `Match` block ends the block that was open but its conditions are
 * not evaluated, so a machine reachable only through one is not offered and no conditional
 * directive is applied. `Include` is not followed. A directive this parser does not know is
 * ignored rather than guessed at.
 *
 * @param text - the file's contents.
 * @returns one entry per concrete alias, in file order.
 */
export function parseSshConfig(text) {
  const hosts = []
  let current = null
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^([A-Za-z][A-Za-z0-9]*)[\s=]+(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1].toLowerCase()
    const value = match[2].trim()

    if (key === 'host') {
      // One line may name several aliases; a later line starts a new block.
      const aliases = value.split(/\s+/).filter((alias) => alias !== '' && !isPattern(alias))
      current = aliases.length === 0 ? null : { aliases, hostName: undefined, user: undefined, port: undefined }
      for (const alias of aliases) hosts.push({ alias, block: current })
      continue
    }
    // `Match` names a CONDITION, not a machine, so it ends the block that was open. Without
    // this, the directives inside it land on whichever `Host` came before and the picker
    // shows that machine under the wrong user and port.
    if (key === 'match') {
      current = null
      continue
    }
    if (current === null) continue
    if (key === 'hostname') current.hostName = value
    else if (key === 'user') current.user = value
    else if (key === 'port') current.port = value
  }

  // A block shared by several aliases is one machine reached by several names; report it once.
  const seen = new Set()
  const result = []
  for (const entry of hosts) {
    if (seen.has(entry.alias)) continue
    seen.add(entry.alias)
    result.push({
      alias: entry.alias,
      hostName: entry.block?.hostName,
      user: entry.block?.user,
      port: entry.block?.port,
    })
  }
  return result
}

/**
 * Every machine this deployment may reach: the operator's ssh config plus any explicit
 * `extraHosts`.
 *
 * @param config - resolved plugin config (`sshHost`, `extraHosts`, `sshConfigPath`).
 * @returns `{ hosts, defaultHost, configPath, error }` — an unreadable config is reported,
 *   never thrown, because the configured default host still works without it.
 */
export async function listHosts(config) {
  const configPath = config.sshConfigPath !== '' ? config.sshConfigPath : DEFAULT_CONFIG_PATH
  let parsed = []
  let error
  try {
    parsed = parseSshConfig(await readFile(configPath, 'utf8'))
  } catch (reason) {
    error = String(reason && reason.message ? reason.message : reason)
  }

  const byAlias = new Map()
  for (const entry of parsed) byAlias.set(entry.alias, { ...entry, source: 'ssh-config' })
  for (const alias of config.extraHosts) {
    if (!byAlias.has(alias)) byAlias.set(alias, { alias, source: 'config' })
  }

  const defaultHost = config.sshHost
  // The configured host is always selectable, even when it is absent from the ssh config —
  // an alias can also be a bare hostname or an address.
  if (defaultHost !== '' && !byAlias.has(defaultHost)) {
    byAlias.set(defaultHost, { alias: defaultHost, source: 'configured' })
  }

  return {
    hosts: [...byAlias.values()].sort((a, b) => a.alias.localeCompare(b.alias)),
    defaultHost,
    configPath,
    error,
  }
}

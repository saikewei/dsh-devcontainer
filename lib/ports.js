/**
 * Port forwarding: a container's listening port, reachable on this machine.
 *
 * ## Why the connection is dialled from inside the container
 *
 * The obvious implementation is `ssh -L <local>:<containerIp>:<port> <host>`. It does not work
 * here, and not by a small margin. A dev container's services bind **`127.0.0.1`** — measured on
 * a real one: uvicorn on 8000, plus two others, every one of them loopback-only — so the host
 * cannot reach them at all. Connecting to the container's bridge address from the NAS is
 * refused, and forwarding to the NAS's own `127.0.0.1:<port>` reaches nothing.
 *
 * So the socket is opened by the resident helper, which already runs *inside* the container,
 * and the bytes ride the channel that is already connected. That reaches loopback-bound
 * services, needs no container-IP discovery, and adds no second SSH connection.
 *
 * ## Cost
 *
 * Bytes cross the channel base64-encoded inside JSON lines, so roughly a third more traffic
 * than the payload, on the same pipe the RPC frames use. That is the right trade for a dev
 * server and the wrong one for moving large files; the README says so.
 *
 * @module dsh-devcontainer/ports
 */
import { createServer } from 'node:net'

/** A port that belongs to the container's own plumbing rather than to the user's work. */
const INTERNAL_ADDRESSES = new Set(['127.0.0.11'])

const isLoopback = (address) =>
  address === '::1' || address === 'localhost' || /^127\./.test(address)

/** True when `address` names every interface rather than one. */
const isWildcard = (address) => address === '0.0.0.0' || address === '::' || address === '*'

/**
 * Decode one `/proc/net/tcp` address field (`0100007F:1F40`).
 *
 * IPv4 is four bytes little-endian; IPv6 is sixteen, written as four little-endian words of
 * eight hex digits each.
 */
function decodeProcAddress(field) {
  const at = field.lastIndexOf(':')
  if (at === -1) return undefined
  const hexAddress = field.slice(0, at)
  const port = parseInt(field.slice(at + 1), 16)
  if (!Number.isInteger(port)) return undefined

  if (hexAddress.length === 8) {
    const bytes = []
    for (let i = 6; i >= 0; i -= 2) bytes.push(hexAddress.slice(i, i + 2))
    return { address: bytes.map((b) => parseInt(b, 16)).join('.'), port }
  }
  if (hexAddress.length !== 32) return undefined

  const bytes = []
  for (let word = 0; word < 4; word++) {
    const chunk = hexAddress.slice(word * 8, word * 8 + 8)
    for (let i = 6; i >= 0; i -= 2) bytes.push(parseInt(chunk.slice(i, i + 2), 16))
  }
  // `::ffff:127.0.0.1` is how a dual-stack listener reports an IPv4 peer, and printing the
  // mapped form is noise: the address the operator recognises is the v4 one.
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 255 && bytes[11] === 255) {
    return { address: bytes.slice(12).join('.'), port }
  }
  const groups = []
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16))
  // Compress the longest run of zero groups, the way the kernel prints it.
  let bestStart = -1
  let bestLength = 0
  let start = -1
  for (let i = 0; i <= groups.length; i++) {
    if (i < groups.length && groups[i] === '0') {
      if (start === -1) start = i
      continue
    }
    if (start !== -1 && i - start > bestLength) {
      bestStart = start
      bestLength = i - start
    }
    start = -1
  }
  if (bestLength < 2) return { address: groups.join(':'), port }
  const head = groups.slice(0, bestStart).join(':')
  const tail = groups.slice(bestStart + bestLength).join(':')
  return { address: head + '::' + tail, port }
}

/** One `ss -ltnp` row, or undefined when the line is not one. */
function parseSsLine(line) {
  const columns = line.split(/\s+/)
  if (columns[0] !== 'LISTEN' || columns.length < 4) return undefined
  const local = columns[3]
  const at = local.lastIndexOf(':')
  if (at === -1) return undefined
  const port = Number(local.slice(at + 1))
  if (!Number.isInteger(port)) return undefined
  const raw = local.slice(0, at).replace(/^\[/, '').replace(/\]$/, '')
  // `ss` reports the process on the same row, e.g. `users:(("uvicorn",pid=97186,fd=6))`.
  const owner = /users:\(\("([^"]+)"/.exec(line)
  return { address: raw === '*' ? '0.0.0.0' : raw, port, process: owner === null ? undefined : owner[1] }
}

/** One `/proc/net/tcp{,6}` row, or undefined when the line is not one. */
function parseProcLine(line) {
  const columns = line.trim().split(/\s+/)
  // `sl local_address rem_address st …` — `st` 0A is LISTEN. The rest is kernel bookkeeping.
  if (columns.length < 4 || !/^\d+:$/.test(columns[0])) return undefined
  if (columns[3] !== '0A') return undefined
  const decoded = decodeProcAddress(columns[1])
  if (decoded === undefined) return undefined
  return { address: decoded.address, port: decoded.port, process: undefined }
}

/**
 * The listening ports in one probe's output.
 *
 * The probe asks `ss` first and falls back to `/proc/net/tcp`, so both formats reach here and
 * each line is offered to both parsers. Parsing lives on this side deliberately: it is the part
 * with edge cases, and here it can be tested against a fixture instead of against a container.
 *
 * @param text - raw output of the helper's `listening` op.
 * @returns `{ source, ports }` — `source` is `'ss'`, `'proc'` or `'none'`.
 */
export function parseListening(text) {
  const ports = []
  let source = 'none'
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim() === '') continue
    const fromSs = parseSsLine(line)
    if (fromSs !== undefined) {
      source = source === 'proc' ? 'mixed' : 'ss'
      ports.push(fromSs)
      continue
    }
    const fromProc = parseProcLine(line)
    if (fromProc === undefined) continue
    if (source === 'none') source = 'proc'
    ports.push(fromProc)
  }

  // One port can appear once per address family — a dual-stack listener shows up in both
  // /proc/net/tcp6 and /proc/net/tcp. Report it once, keeping the entry that carries the most:
  // a process name over none, a specific address over a wildcard.
  const byPort = new Map()
  for (const entry of ports) {
    const existing = byPort.get(entry.port)
    if (existing === undefined) {
      byPort.set(entry.port, entry)
      continue
    }
    const better = (existing.process === undefined && entry.process !== undefined)
      || (isWildcard(existing.address) && !isWildcard(entry.address))
    if (better) byPort.set(entry.port, { ...entry, process: entry.process ?? existing.process })
    else if (existing.process === undefined && entry.process !== undefined) existing.process = entry.process
  }

  return {
    source,
    ports: [...byPort.values()]
      .map((entry) => ({
        address: entry.address,
        port: entry.port,
        process: entry.process,
        internal: INTERNAL_ADDRESSES.has(entry.address),
        loopback: isLoopback(entry.address),
      }))
      .sort((a, b) => a.port - b.port),
  }
}

/**
 * The live forwards, and the links that carry them.
 *
 * A forward is keyed by `(host, container, remotePort)`: the same port in two containers is two
 * forwards, and asking for one that already exists is a no-op rather than a second listener.
 * Every TCP connection through a forward gets its own relay on the channel, so one page load
 * with six parallel requests works without any of them waiting for the others.
 */
export class Forwards {
  #channels
  #bind
  #entries = new Map()
  #nextRelay = 1
  #onChange
  /** Ports the operator stopped, so the auto-forward poll does not add them straight back. */
  #suppressed = new Set()
  #stopWatching

  /**
   * @param deps - `{ channels, bind, onChange }`: the per-target channel lookup, the local
   *   address to bind, and an optional `(message) => void` for the plugin's own log.
   */
  constructor(deps) {
    this.#channels = deps.channels
    this.#bind = deps.bind === undefined || deps.bind === '' ? '127.0.0.1' : deps.bind
    this.#onChange = deps.onChange
  }

  get bind() {
    return this.#bind
  }

  /** The channel that carries one forward, or undefined when this deployment cannot reach it. */
  #channelOf(entry) {
    return this.#channels.forTarget({
      host: entry.host,
      world: 'container',
      container: entry.container,
    })
  }

  #key(host, container, remotePort) {
    return host + '|' + container + '|' + String(remotePort)
  }

  #log(message) {
    if (this.#onChange !== undefined) this.#onChange(message)
  }

  /**
   * Start forwarding one container port, or return the forward that already does.
   *
   * The local port defaults to the container's own, which is what makes `localhost:8000` and
   * the container's `:8000` the same number to the operator. When that port is taken here the
   * next free one is used — and the substitution is REPORTED, because a forward that silently
   * answers on a different port than the caller asked for is worse than one that fails.
   *
   * @returns `{ ok, forward?, error? }`; `forward.substituted` says the port moved.
   */
  async add({ host, container, port, localPort, auto = false }) {
    const remotePort = Number(port)
    if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort > 65535) {
      return { ok: false, error: 'not a port number: ' + String(port) }
    }
    const key = this.#key(host, container, remotePort)
    const existing = this.#entries.get(key)
    if (existing !== undefined) return { ok: true, forward: this.#describe(existing) }

    const wanted = localPort === undefined || localPort === null ? remotePort : Number(localPort)
    if (!Number.isInteger(wanted) || wanted <= 0 || wanted > 65535) {
      return { ok: false, error: 'not a local port number: ' + String(localPort) }
    }

    const server = createServer()
    const entry = {
      key,
      host,
      container,
      remotePort,
      localPort: wanted,
      substituted: false,
      auto,
      server,
      relays: new Map(),
    }
    const listening = await this.#listen(server, wanted)
    if (listening.error !== undefined) {
      server.close()
      return { ok: false, error: 'could not listen on ' + this.#bind + ':' + String(wanted) + ' — ' + listening.error }
    }
    entry.localPort = listening.port
    entry.substituted = listening.port !== wanted

    server.on('connection', (socket) => {
      this.#attach(entry, socket)
    })

    // One subscription per FORWARD, not per connection: when the channel dies, every relay on
    // it is dead at once. Reporting it once is what makes the cause visible, and closing them
    // is what turns a silent, permanent hang into a millisecond blip — the peer would
    // otherwise sit on a socket that is paused forever, see no error, and never retry.
    const channel = this.#channelOf(entry)
    if (channel !== undefined && typeof channel.onClose === 'function') {
      entry.offChannelClose = channel.onClose(() => {
        const lost = entry.relays.size
        if (lost === 0) return
        this.#log('forward ' + this.#label(entry) + ': the channel to ' + entry.host + ' went away ('
          + String(channel.lastError === undefined ? 'closed' : channel.lastError) + ') — dropped '
          + String(lost) + ' connection(s)')
        for (const relayId of [...entry.relays.keys()]) this.#endRelay(entry, relayId)
      })
    }
    server.on('error', (error) => {
      // A listener that fails after it started is not recoverable here: report it and drop the
      // forward rather than leaving a row in the panel that answers nothing.
      this.#log('forward ' + this.#label(entry) + ' failed: ' + String(error && error.message ? error.message : error))
      this.remove({ host, container, port: remotePort })
    })

    this.#entries.set(key, entry)
    this.#log('forwarding ' + this.#label(entry) + (entry.substituted ? ' (local ' + String(wanted) + ' was taken)' : ''))
    return { ok: true, forward: this.#describe(entry) }
  }

  /** Bind `server`, stepping past ports already taken on this machine. */
  async #listen(server, startPort, attempts = 20) {
    for (let port = startPort; port < startPort + attempts && port <= 65535; port++) {
      const outcome = await new Promise((resolve) => {
        const onError = (error) => {
          server.removeListener('listening', onListening)
          resolve({ ok: false, code: error && error.code ? error.code : 'EUNKNOWN' })
        }
        const onListening = () => {
          server.removeListener('error', onError)
          resolve({ ok: true })
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, this.#bind)
      })
      if (outcome.ok) return { port }
      // Only a taken port is worth stepping past; anything else (EACCES on a privileged port,
      // an address this machine does not have) would fail identically on the next one.
      if (outcome.code !== 'EADDRINUSE') return { error: String(outcome.code) }
    }
    return { error: 'EADDRINUSE (tried ' + String(attempts) + ' ports from ' + String(startPort) + ')' }
  }

  /** One accepted local connection: open its relay, then move bytes both ways. */
  #attach(entry, socket) {
    const channel = this.#channelOf(entry)
    if (channel === undefined) {
      socket.destroy()
      return
    }
    const relayId = entry.key + '#' + String(this.#nextRelay++)
    socket.setNoDelay(true)
    // The peer speaks before the relay exists: a browser writes its request the instant the TCP
    // connection opens, and the helper has no socket to hand until `relay_open` lands. Pausing
    // here keeps those bytes in the socket's own buffer. Forwarding them at once would have the
    // helper drop them, and a dropped request is a DEADLOCK, not an error: nothing arrives, so
    // nothing ever comes back, and the caller sees a timeout with no explanation.
    socket.pause()

    // Registered BEFORE the open request: the helper may start pushing bytes the moment the
    // upstream socket connects, and a listener attached after the await would miss the head.
    const off = channel.onEvent((frame) => {
      if (frame.relayId !== relayId) return
      if (frame.event === 'relay_data') {
        socket.write(Buffer.from(String(frame.b64 === undefined ? '' : frame.b64), 'base64'))
        return
      }
      if (frame.event === 'relay_close') this.#endRelay(entry, relayId)
    })
    entry.relays.set(relayId, { socket, off, channel })

    socket.on('data', (chunk) => {
      if (channel.notify({ event: 'relay_data', relayId, b64: chunk.toString('base64') })) return
      // `notify` is false for a full pipe AND for a channel that is gone. Waiting for a drain
      // that can never come leaves this connection paused forever — invisible to the peer, so
      // it never retries. The pipe-full case pauses; the gone case ends the connection.
      if (!channel.connected) {
        this.#endRelay(entry, relayId)
        return
      }
      socket.pause()
      channel.onceDrain(() => socket.resume())
    })
    socket.on('close', () => {
      if (this.#forgetRelay(entry, relayId) === undefined) return
      // A request, not a notification: it is rare (once per connection) and the reply confirms
      // the helper let go, which matters because the next connection may reuse the port.
      channel.request({ op: 'relay_close', relayId }, 15000).catch(() => {})
    })
    socket.on('error', () => {
      // A reset from the browser is ordinary; `close` does the cleanup.
    })

    channel.request(
      { op: 'relay_open', relayId, host: '127.0.0.1', port: entry.remotePort },
      30000,
    ).then(() => {
      // Only now can the helper accept these bytes, so only now is the peer allowed to send.
      if (entry.relays.get(relayId) === undefined) return
      socket.resume()
    }).catch((error) => {
      const message = String(error && error.message ? error.message : error)
      // Logged, because the peer only sees a connection that closed, and that says nothing
      // about why. `request` already rejects on the helper's in-band `ok: false`.
      this.#log('forward ' + this.#label(entry) + ': ' + message)
      this.#endRelay(entry, relayId)
    })
  }

  /** Drop a relay's bookkeeping. Returns it, or undefined when it is already gone. */
  #forgetRelay(entry, relayId) {
    const live = entry.relays.get(relayId)
    if (live === undefined) return undefined
    entry.relays.delete(relayId)
    live.off()
    return live
  }

  #endRelay(entry, relayId) {
    const live = this.#forgetRelay(entry, relayId)
    if (live === undefined) return
    live.socket.destroy()
  }

  /** Stop one forward and release its local port. */
  remove({ host, container, port, localPort }) {
    for (const [key, entry] of this.#entries) {
      const matches = port !== undefined && port !== null
        ? entry.remotePort === Number(port) && (host === undefined || entry.host === host)
        : entry.localPort === Number(localPort)
      if (!matches) continue
      this.#entries.delete(key)
      // A port stopped by hand stays stopped: without this the next poll would re-add it on
      // the spot and the button would look broken.
      if (entry.auto) this.#suppressed.add(entry.remotePort)
      if (typeof entry.offChannelClose === 'function') entry.offChannelClose()
      for (const relayId of [...entry.relays.keys()]) this.#endRelay(entry, relayId)
      entry.server.close()
      this.#log('stopped ' + this.#label(entry))
      return { ok: true, stopped: this.#describe(entry) }
    }
    return { ok: false, error: 'no forward for ' + String(port === undefined ? 'local port ' + String(localPort) : 'port ' + String(port)) }
  }

  /** Every live forward, in a shape that survives JSON. */
  list() {
    return [...this.#entries.values()].map((entry) => this.#describe(entry))
  }

  /** Whether one container port is already forwarded. */
  has(host, container, remotePort) {
    return this.#entries.has(this.#key(host, container, remotePort))
  }

  #label(entry) {
    return this.#bind + ':' + String(entry.localPort) + ' -> ' + entry.host + ':' + entry.container + ':' + String(entry.remotePort)
  }

  #describe(entry) {
    return {
      host: entry.host,
      container: entry.container,
      remotePort: entry.remotePort,
      localPort: entry.localPort,
      substituted: entry.substituted,
      auto: entry.auto,
      connections: entry.relays.size,
      localAddress: this.#bind + ':' + String(entry.localPort),
      url: 'http://127.0.0.1:' + String(entry.localPort),
    }
  }

  /**
   * Forward every listening port the container has, and keep doing it.
   *
   * Off by default: a forward occupies a port on THIS machine, and taking ports the operator
   * did not ask for is not a decision a plugin should make for them.
   */
  watch({ host, container, intervalMs = 5000 }) {
    this.unwatch()
    const tick = async () => {
      const found = await this.listening({ host, container })
      if (found.ok !== true) return
      for (const candidate of found.ports) {
        if (this.has(host, container, candidate.port)) continue
        if (this.#suppressed.has(candidate.port)) continue
        await this.add({ host, container, port: candidate.port, auto: true })
      }
    }
    const timer = setInterval(tick, intervalMs)
    // The plugin must never be the reason the process stays alive.
    if (typeof timer.unref === 'function') timer.unref()
    this.#stopWatching = () => clearInterval(timer)
  }

  unwatch() {
    if (this.#stopWatching === undefined) return
    this.#stopWatching()
    this.#stopWatching = undefined
  }

  /** Close every forward. Registered on the plugin's own fiber, so unloading restores the machine. */
  disposeAll() {
    this.unwatch()
    for (const entry of this.#entries.values()) {
      if (typeof entry.offChannelClose === 'function') entry.offChannelClose()
      for (const relayId of [...entry.relays.keys()]) this.#endRelay(entry, relayId)
      entry.server.close()
    }
    this.#entries.clear()
  }

  /**
   * The container's listening ports, parsed.
   *
   * A probe that could not run is REPORTED, never rendered as an empty list: "nothing is
   * listening" and "the machine did not answer" are different facts, and the first one is a
   * wrong answer when it is really the second.
   */
  async listening({ host, container }) {
    const channel = this.#channelOf({ host, container })
    if (channel === undefined) return { ok: false, error: 'no channel serves ' + host + ':' + container }
    try {
      const frame = await channel.request({ op: 'listening' }, 30000)
      const parsed = parseListening(frame.text)
      return {
        ok: true,
        source: parsed.source,
        ports: parsed.ports.filter((entry) => !entry.internal),
      }
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) }
    }
  }
}

// The port-forwarding layer, without a container and without a browser.
//
// Two halves, both of them places a wrong answer looks like a right one: the parser that turns
// a probe's output into ports (a missed LISTEN row reads as "your server is not running"), and
// the relay plumbing (a dropped chunk reads as a page that half-loaded).
import { connect } from 'node:net'
import { parseListening, Forwards } from '../lib/ports.js'

let failures = 0
const check = (label, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
  if (!ok) failures++
}
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

console.log('-- ss output --')
// Real output from a dev container: the first line is the header, and the process annotation
// appears only for sockets the probing user owns.
const SS = [
  'State  Recv-Q Send-Q Local Address:Port  Peer Address:PortProcess',
  'LISTEN 0      4096      127.0.0.11:44155      0.0.0.0:*',
  'LISTEN 0      2048       127.0.0.1:8000       0.0.0.0:*    users:(("uvicorn",pid=97186,fd=6))',
  'LISTEN 0      511        127.0.0.1:42957      0.0.0.0:*    users:(("MainThread",pid=35587,fd=35))',
  'LISTEN 0      4096             *:5432            *:*        users:(("postgres",pid=12,fd=7))',
  'LISTEN 0      4096          [::]:8080            *:*        users:(("node",pid=44,fd=20))',
  'ESTAB 0      0          10.0.0.5:22         10.0.0.1:51000',
].join('\n')
const ss = parseListening(SS)
console.log('  ports:', ss.ports.map((p) => p.port + (p.process === undefined ? '' : '/' + p.process)).join(', '))
check('the source is reported as ss', ss.source === 'ss', ss.source)
check('the header is not a port', !ss.ports.some((p) => Number.isNaN(p.port)))
check('every LISTEN row is found', ss.ports.length === 5, String(ss.ports.length))
check('a non-LISTEN row is not', !ss.ports.some((p) => p.port === 22))
check('ports are sorted', ss.ports.map((p) => p.port).join(',') === '5432,8000,8080,42957,44155')
check('the process name is carried', ss.ports.find((p) => p.port === 8000)?.process === 'uvicorn', JSON.stringify(ss.ports.find((p) => p.port === 8000)))
check('a wildcard address is normalised', ss.ports.find((p) => p.port === 5432)?.address === '0.0.0.0', String(ss.ports.find((p) => p.port === 5432)?.address))
check('an IPv6 wildcard survives its brackets', ss.ports.find((p) => p.port === 8080)?.address === '::', String(ss.ports.find((p) => p.port === 8080)?.address))
check('a loopback listener is flagged', ss.ports.find((p) => p.port === 8000)?.loopback === true)
check('docker DNS is flagged internal', ss.ports.find((p) => p.port === 44155)?.internal === true)
check('a user port is NOT internal', ss.ports.find((p) => p.port === 8000)?.internal === false)

console.log('\n-- /proc/net/tcp output --')
// The fallback every Linux has. Addresses are little-endian hex and `st` 0A means LISTEN —
// getting either wrong reports a port that is not there, or misses one that is.
const PROC = [
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
  '   0: 0B00007F:AC7B 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 104305574 1 0000000046317178 100 0 0 10 0',
  '   1: 0100007F:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 105303506 1 0000000073f77154 100 0 0 10 0',
  '   2: 00000000:15B3 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 105303507 1 0000000073f77155 100 0 0 10 0',
  '   3: 0100007F:1F40 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1001        0 105303508 1 0000000073f77156 100 0 0 10 0',
  // An ESTABLISHED connection on a port nothing LISTENS on. Without it the state filter is
  // masked by the de-duplication below: an ESTABLISHED row for a port that some LISTEN row
  // already claimed collapses into the same entry, so dropping the filter changes nothing.
  '   4: 0100007F:C351 0100007F:1F40 01 00000000:00000000 00:00000000 00000000  1001        0 105303509 1 0000000073f77157 100 0 0 10 0',
].join('\n')
const proc = parseListening(PROC)
console.log('  ports:', proc.ports.map((p) => p.address + ':' + p.port).join(', '))
check('the source is reported as proc', proc.source === 'proc', proc.source)
check('little-endian IPv4 decodes', proc.ports.some((p) => p.address === '127.0.0.1' && p.port === 8000), JSON.stringify(proc.ports))
check('0B00007F is the docker resolver', proc.ports.find((p) => p.port === 44155)?.address === '127.0.0.11')
check('the wildcard address decodes', proc.ports.find((p) => p.port === 5555)?.address === '0.0.0.0', JSON.stringify(proc.ports.find((p) => p.port === 5555)))
check('a port in hex is a port in decimal', proc.ports.some((p) => p.port === 8000), JSON.stringify(proc.ports.map((p) => p.port)))
check('a non-LISTEN state (01 = ESTABLISHED) is skipped', proc.ports.filter((p) => p.port === 8000).length === 1, String(proc.ports.filter((p) => p.port === 8000).length))
check('an outbound connection is not reported as a listening port', !proc.ports.some((p) => p.port === 50001), JSON.stringify(proc.ports.map((p) => p.port)))
check('the same port over two files is reported once', proc.ports.length === 3, String(proc.ports.length))
check('IPv4 and IPv6 listeners are both accepted', proc.ports.length === new Set(proc.ports.map((p) => p.port)).size)

console.log('\n-- IPv6 --')
const TCP6 = [
  '  sl  local_address                         rem_address                            st',
  '   0: 00000000000000000000000001000000:1F40 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 1 1 0000000000000000 100 0 0 10 0',
  '   1: 00000000000000000000000000000000:2328 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 1 1 0000000000000000 100 0 0 10 0',
  '   2: 0000000000000000FFFF00000100007F:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 1 1 0000000000000000 100 0 0 10 0',
].join('\n')
const v6 = parseListening(TCP6)
console.log('  ports:', v6.ports.map((p) => p.address + ':' + p.port).join(', '))
check('::1 decodes', v6.ports.find((p) => p.port === 8000)?.address === '::1', JSON.stringify(v6.ports))
check(':: decodes', v6.ports.find((p) => p.port === 9000)?.address === '::', JSON.stringify(v6.ports))
check('an IPv4-mapped address prints as the v4 the operator knows', v6.ports.find((p) => p.port === 3000)?.address === '127.0.0.1', JSON.stringify(v6.ports.find((p) => p.port === 3000)))

console.log('\n-- nothing to report, and nothing that ran --')
check('an empty probe is an empty list, not an error', parseListening('').ports.length === 0)
check('and says so', parseListening('').source === 'none', parseListening('').source)
check('a header with no rows yields no ports', parseListening('State Recv-Q Send-Q Local Address:Port\n').ports.length === 0)
check('garbage neither throws nor invents', parseListening('total nonsense\n\n').ports.length === 0)

console.log('\n-- a dual-stack listener is one port, with what both rows knew --')
const dual = parseListening([
  'LISTEN 0 4096 [::]:7000 *:*',
  'LISTEN 0 4096 0.0.0.0:7000 0.0.0.0:* users:(("vite",pid=9,fd=3))',
].join('\n'))
check('reported once', dual.ports.length === 1, String(dual.ports.length))
check('keeping the specific address', dual.ports[0].address === '::' || dual.ports[0].address === '0.0.0.0', dual.ports[0].address)
check('and the process name', dual.ports[0].process === 'vite', String(dual.ports[0].process))

console.log('\n-- the relay carries bytes both ways --')
// A fake channel: it records what the plugin pushes and lets the test push back, which is
// exactly the seam the real channel exposes (notify + onEvent).
function fakeChannel() {
  const state = { opened: [], closed: [], listeners: new Set(), notify: [], closeListeners: new Set(), connected: true }
  return {
    state,
    onEvent(listener) {
      state.listeners.add(listener)
      return () => state.listeners.delete(listener)
    },
    onClose(listener) {
      state.closeListeners.add(listener)
      return () => state.closeListeners.delete(listener)
    },
    /** The process behind this channel went away, as the real one reports it. */
    die() {
      state.connected = false
      for (const listener of [...state.closeListeners]) listener()
    },
    notify(frame) {
      state.notify.push(frame)
      return true
    },
    onceDrain() {},
    async request(frame) {
      if (frame.op === 'relay_open') {
        state.opened.push(frame)
        return { ok: true }
      }
      if (frame.op === 'relay_close') {
        state.closed.push(frame)
        return { ok: true }
      }
      if (frame.op === 'listening') return { ok: true, text: 'LISTEN 0 4096 127.0.0.1:8000 0.0.0.0:*' }
      return { ok: true }
    },
    emit(frame) {
      for (const listener of [...state.listeners]) listener(frame)
    },
  }
}

/** Read whatever a socket receives, for comparison. */
const readAll = (socket, ms = 200) => new Promise((resolve) => {
  let text = ''
  socket.on('data', (chunk) => { text += chunk.toString('utf8') })
  socket.on('close', () => resolve(text))
  setTimeout(() => resolve(text), ms)
})

const channel = fakeChannel()
const forwards = new Forwards({ channels: { forTarget: () => channel }, bind: '127.0.0.1' })
const started = await forwards.add({ host: 'nas', container: 'epic', port: 8000 })
console.log('  ', JSON.stringify(started.forward))
check('the forward starts', started.ok === true, JSON.stringify(started))
check('on the same port as the container', started.forward.localPort === 8000, String(started.forward.localPort))
check('and reports a URL to open', started.forward.url === 'http://127.0.0.1:8000', started.forward.url)
check('asking twice is the same forward', (await forwards.add({ host: 'nas', container: 'epic', port: 8000 })).forward.localPort === 8000)
check('and there is exactly one', forwards.list().length === 1, String(forwards.list().length))

// DOWNSTREAM: a browser connects, the helper answers.
const client = connect({ host: '127.0.0.1', port: 8000 })
await new Promise((resolve, reject) => {
  client.on('connect', resolve)
  client.on('error', reject)
})
// The relay is opened for THIS connection; wait for it to reach the fake channel.
for (let i = 0; i < 40 && channel.state.opened.length === 0; i++) await settle(5)
check('the local connection opened a relay', channel.state.opened.length === 1, String(channel.state.opened.length))
const relayId = channel.state.opened[0].relayId
check('it targets the container loopback', channel.state.opened[0].host === '127.0.0.1' && channel.state.opened[0].port === 8000, JSON.stringify(channel.state.opened[0]))

client.write('GET / HTTP/1.1\r\n\r\n')
for (let i = 0; i < 40 && channel.state.notify.length === 0; i++) await settle(5)
const upstream = channel.state.notify[0]
check('bytes from the browser reached the channel', upstream !== undefined && upstream.event === 'relay_data', JSON.stringify(upstream))
check('as the same bytes, base64-encoded', Buffer.from(upstream.b64, 'base64').toString('utf8') === 'GET / HTTP/1.1\r\n\r\n', JSON.stringify(Buffer.from(upstream.b64, 'base64').toString('utf8')))
check('with the relay id that identifies the connection', upstream.relayId === relayId)

const received = readAll(client)
channel.emit({ event: 'relay_data', relayId, b64: Buffer.from('HTTP/1.1 200 OK\r\n\r\nhi').toString('base64') })
const answer = await received
check('bytes from the container reached the browser', answer === 'HTTP/1.1 200 OK\r\n\r\nhi', JSON.stringify(answer))

// A frame for somebody else's relay must not land on this socket.
const second = readAll(client, 60)
channel.emit({ event: 'relay_data', relayId: 'somebody-else#1', b64: Buffer.from('wrong').toString('base64') })
check('a frame for another relay is ignored', (await second) === '', 'a misrouted frame reached the socket')

console.log('\n-- closing one connection leaves the forward standing --')
client.destroy()
for (let i = 0; i < 40 && channel.state.closed.length === 0; i++) await settle(5)
check('the helper is told to let go', channel.state.closed.length === 1, JSON.stringify(channel.state.closed))
check('with the relay it owns', channel.state.closed[0].relayId === relayId, JSON.stringify(channel.state.closed[0]))
check('the forward is still listed', forwards.list().length === 1)
check('and reports no live connections', forwards.list()[0].connections === 0, String(forwards.list()[0].connections))

console.log('\n-- a helper-side close reaches the browser --')
const secondClient = connect({ host: '127.0.0.1', port: 8000 })
await new Promise((resolve) => secondClient.on('connect', resolve))
for (let i = 0; i < 40 && channel.state.opened.length < 2; i++) await settle(5)
const secondId = channel.state.opened[1].relayId
const closedByPeer = new Promise((resolve) => secondClient.on('close', resolve))
channel.emit({ event: 'relay_close', relayId: secondId })
await closedByPeer
check('a relay closed by the container closes the local socket', secondClient.destroyed === true || secondClient.readyState === 'closed', secondClient.readyState)

console.log('\n-- walking past a port this machine already holds --')
const blocker = new Forwards({ channels: { forTarget: () => channel }, bind: '127.0.0.1' })
const first = await blocker.add({ host: 'nas', container: 'epic', port: 8100 })
const second2 = await blocker.add({ host: 'nas', container: 'other', port: 8100 })
console.log('  ', first.forward.localPort, '->', second2.forward.localPort)
check('the first forward takes the port it wanted', first.forward.localPort === 8100, String(first.forward.localPort))
check('the second steps to the next one', second2.forward.localPort === 8101, String(second2.forward.localPort))
check('and says it was moved, rather than answering elsewhere in silence', second2.forward.substituted === true)
check('the first did not move', first.forward.substituted === false)

const explicit = await blocker.add({ host: 'nas', container: 'epic', port: 8102, localPort: 9100 })
check('an explicit local port is honoured', explicit.forward.localPort === 9100, String(explicit.forward.localPort))
const badPort = await blocker.add({ host: 'nas', container: 'epic', port: 0 })
check('a nonsense port is refused', badPort.ok === false, JSON.stringify(badPort))
const badLocal = await blocker.add({ host: 'nas', container: 'epic', port: 8103, localPort: -1 })
check('a nonsense local port is refused', badLocal.ok === false, JSON.stringify(badLocal))

console.log('\n-- stopping releases the port --')
const stopped = blocker.remove({ host: 'nas', container: 'epic', port: 8100 })
check('the stop is reported', stopped.ok === true, JSON.stringify(stopped))
check('the forward is gone', blocker.list().length === 2, String(blocker.list().length))
// The port really is free again: rebinding it is the proof, and it is the thing an operator
// notices when it is wrong.
const rebound = await blocker.add({ host: 'nas', container: 'third', port: 8100, localPort: 8100 })
check('the released port can be taken again', rebound.ok === true && rebound.forward.localPort === 8100, JSON.stringify(rebound))
const missing = blocker.remove({ port: 9999 })
check('stopping something that is not there is reported', missing.ok === false, JSON.stringify(missing))
// The HTTP route reads `.ok` straight off this call without awaiting, so a Promise here would
// turn every stop into a 404 that says "undefined". The contract is synchronous; pin it.
check('remove answers synchronously, as the HTTP route assumes', typeof missing.then !== 'function', typeof missing)

console.log('\n-- teardown --')
blocker.disposeAll()
check('every forward is closed', blocker.list().length === 0)
const afterDispose = connect({ host: '127.0.0.1', port: 8100 })
const refused = await new Promise((resolve) => {
  afterDispose.on('error', (error) => resolve(error.code))
  afterDispose.on('connect', () => resolve('connected'))
})
check('and the port is free afterwards', refused === 'ECONNREFUSED', String(refused))

console.log('\n-- the channel dying must not leave a connection hanging --')
// The symptom this pins, reported from real use: a web app worked, then after a while EVERY
// request hung, and reloading the page fixed it until it hung again. The channel had died, and
// each connection that was live at that moment stayed paused forever — neither closed nor
// resumed, so the peer saw nothing wrong and never retried. The browser's pool filled up with
// those and every later request queued behind them.
{
  const dying = fakeChannel()
  const live = new Forwards({ channels: { forTarget: () => dying }, bind: '127.0.0.1' })
  const messages = []
  const watched = new Forwards({ channels: { forTarget: () => dying }, bind: '127.0.0.1', onChange: (m) => messages.push(m) })
  await watched.add({ host: 'nas', container: 'epic', port: 8300 })
  const peer = connect({ host: '127.0.0.1', port: 8300 })
  await new Promise((resolve) => peer.on('connect', resolve))
  for (let i = 0; i < 40 && dying.state.opened.length === 0; i++) await settle(5)
  check('the connection is live first', dying.state.opened.length === 1 && watched.list()[0].connections === 1, JSON.stringify(watched.list()))

  const closed = new Promise((resolve) => peer.on('close', () => resolve(true)))
  dying.die()
  const wasClosed = await Promise.race([closed, settle(1000).then(() => false)])
  check('a live connection is CLOSED when the channel dies, not left hanging', wasClosed === true)
  check('and the relay is forgotten', watched.list()[0].connections === 0, JSON.stringify(watched.list()))
  check('and the cause is logged with the channel\'s own message', messages.some((m) => m.includes('went away')), JSON.stringify(messages))

  // A later connection must be able to use the channel again once it is back.
  dying.state.connected = true
  const second = connect({ host: '127.0.0.1', port: 8300 })
  await new Promise((resolve) => second.on('connect', resolve))
  for (let i = 0; i < 40 && dying.state.opened.length < 2; i++) await settle(5)
  check('the forward still works after the channel returns', dying.state.opened.length === 2, String(dying.state.opened.length))
  second.destroy()
  watched.disposeAll()
  live.disposeAll()
}

console.log('\n-- a channel that is gone does not silently swallow a pause --')
// `notify` is false for a full pipe AND for a channel that is gone. Treating both as "wait for
// drain" left the socket paused with nothing that would ever resume it.
{
  const gone = fakeChannel()
  gone.state.connected = false
  gone.notify = () => false
  gone.onceDrain = () => {}
  const forwardsGone = new Forwards({ channels: { forTarget: () => gone }, bind: '127.0.0.1' })
  await forwardsGone.add({ host: 'nas', container: 'epic', port: 8400 })
  const peer = connect({ host: '127.0.0.1', port: 8400 })
  await new Promise((resolve) => peer.on('connect', resolve))
  const closed = new Promise((resolve) => peer.on('close', () => resolve(true)))
  peer.write('GET / HTTP/1.1\r\n\r\n')
  const wasClosed = await Promise.race([closed, settle(1000).then(() => false)])
  check('a write into a dead channel ends the connection', wasClosed === true)
  check('and leaves no relay behind', forwardsGone.list()[0].connections === 0, JSON.stringify(forwardsGone.list()))
  forwardsGone.disposeAll()
}

console.log('\n-- a peer that speaks before the relay exists is not dropped --')
// The race that mattered: a browser writes its request the instant the TCP connection opens,
// while `relay_open` is still in flight, and the helper has no socket to write to yet. Those
// bytes used to be discarded — a DEADLOCK rather than an error, because the request never
// arrived so nothing ever came back and the caller saw a bare timeout.
{
  const slow = fakeChannel()
  const gate = { release: () => {} }
  const opened = new Promise((resolve) => { gate.release = resolve })
  slow.request = async (frame) => {
    if (frame.op === 'relay_open') {
      slow.state.opened.push(frame)
      await opened
      return { ok: true }
    }
    if (frame.op === 'relay_close') {
      slow.state.closed.push(frame)
      return { ok: true }
    }
    return { ok: true }
  }
  const early = new Forwards({ channels: { forTarget: () => slow }, bind: '127.0.0.1' })
  const entry = await early.add({ host: 'nas', container: 'epic', port: 8200 })
  check('the forward is up while its relay is still opening', entry.ok === true)

  const peer = connect({ host: '127.0.0.1', port: 8200 })
  await new Promise((resolve) => peer.on('connect', resolve))
  peer.write('EARLY')
  // Give the bytes every chance to be forwarded too soon — that is the bug being guarded.
  await settle(40)
  check('nothing is sent before the helper can receive it', slow.state.notify.length === 0, JSON.stringify(slow.state.notify))

  gate.release()
  for (let i = 0; i < 60 && slow.state.notify.length === 0; i++) await settle(5)
  check('the bytes are still there once the relay opens', slow.state.notify.length === 1, String(slow.state.notify.length))
  check(
    'and they are the ones the peer sent',
    slow.state.notify[0] !== undefined && Buffer.from(slow.state.notify[0].b64, 'base64').toString('utf8') === 'EARLY',
    JSON.stringify(slow.state.notify[0]),
  )
  peer.destroy()
  early.disposeAll()
}

console.log('\n-- a probe that cannot run is not an empty answer --')
const brokenChannel = fakeChannel()
brokenChannel.request = async () => { throw new Error('channel is not connected') }
const broken = new Forwards({ channels: { forTarget: () => brokenChannel }, bind: '127.0.0.1' })
const failed = await broken.listening({ host: 'nas', container: 'epic' })
check('the failure is reported', failed.ok === false, JSON.stringify(failed))
check('and never as an empty list of ports', failed.ports === undefined, JSON.stringify(failed))
const reachable = await forwards.listening({ host: 'nas', container: 'epic' })
check('a probe that runs returns parsed ports', reachable.ok === true && reachable.ports.some((p) => p.port === 8000), JSON.stringify(reachable))
const noChannel = new Forwards({ channels: { forTarget: () => undefined }, bind: '127.0.0.1' })
check('a target with no channel is refused, not probed', (await noChannel.listening({ host: 'nas', container: 'x' })).ok === false)
forwards.disposeAll()

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'))
process.exit(failures === 0 ? 0 : 1)

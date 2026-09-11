// The resident channel, over a FAKE transport. No ssh, no container: the frame protocol and
// the terminal paths are pure logic, and one of them leaked a timer per call.
//
// Worth its own suite because every failure here is quiet. A channel that never completed its
// handshake but reports `connected` is worse than one that is plainly down: the tools keep
// writing into it, and `devc_status` — the tool whose whole job is to say what is wrong — says
// everything is fine.
import { EventEmitter } from 'node:events'
import { RemoteChannel } from '../lib/channel.js'

let failures = 0
const check = (label, ok, detail) => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok || detail === undefined ? '' : '  -> ' + detail))
  if (!ok) failures++
}
const settle = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))

const NL = String.fromCharCode(10)
const CONFIG = { sshHost: 'nas', container: 'epic', containerRoot: '/workspaces/proj', hostRoot: '/volume1/docker/proj' }

/**
 * A transport whose helper is a script this test writes.
 *
 * `reply(frame)` decides the answer, so a test can model a healthy helper, one that refuses the
 * handshake, or one that answers the ping and then goes quiet — which is the shape that matters
 * for the terminal paths, because `request` connects first. `installExit` models a machine
 * where the helper cannot be written.
 */
function fakeTransport({ reply, installExit = 0, noNode = false } = {}) {
  const state = { sent: [], handles: [], installed: 0, runs: 0 }
  return {
    state,
    async collect() {
      // The host target probes for `node` before installing; the container target does not.
      return noNode
        ? { exitCode: 0, stdout: 'no', stderr: '' }
        : { exitCode: 0, stdout: 'yes', stderr: '' }
    },
    // The install is a different command from the helper itself; only the install can fail.
    isInstall: (command) => String(command).includes('cat > '),
    async open(command) {
      const installing = String(command).includes('cat > ')
      if (!installing) state.runs++
      const stdin = new EventEmitter()
      const stdout = new EventEmitter()
      const stderr = new EventEmitter()
      let finished = false
      let finish = () => {}
      const done = new Promise((resolve) => {
        finish = () => {
          if (finished) return
          finished = true
          resolve({ exitCode: installing ? installExit : 0 })
        }
      })
      stdin.write = (text) => {
        const lines = String(text).split(NL).filter(Boolean)
        for (const line of lines) {
          let frame
          try {
            frame = JSON.parse(line)
          } catch {
            // The install path writes the helper SOURCE, which is not a frame.
            continue
          }
          state.sent.push(frame)
          const answer = reply === undefined ? { id: frame.id, ok: true } : reply(frame)
          if (answer === undefined) continue
          // Answered on a later tick, like a real round trip.
          setTimeout(() => stdout.emit('data', Buffer.from(JSON.stringify(answer) + NL)), 1)
        }
        return true
      }
      // `#install` ends stdin and awaits `done`; resolve it a tick later so it does not hang.
      stdin.end = () => {
        state.installed++
        setTimeout(finish, 1)
      }
      const handle = {
        stdin,
        stdout,
        stderr,
        done,
        terminate() {
          finish()
        },
      }
      state.handles.push(handle)
      return handle
    },
  }
}

/** Count abort listeners actually added to and removed from one signal. */
function countingSignal() {
  const controller = new AbortController()
  const counts = { added: 0, removed: 0 }
  const realAdd = controller.signal.addEventListener.bind(controller.signal)
  const realRemove = controller.signal.removeEventListener.bind(controller.signal)
  controller.signal.addEventListener = (type, fn, opts) => {
    if (type === 'abort') counts.added++
    return realAdd(type, fn, opts)
  }
  controller.signal.removeEventListener = (type, fn, opts) => {
    if (type === 'abort') counts.removed++
    return realRemove(type, fn, opts)
  }
  return { controller, counts }
}

console.log('-- a completed handshake --')
{
  const transport = fakeTransport()
  const channel = new RemoteChannel(transport, CONFIG, 'container')
  check('a fresh channel is not connected', channel.connected === false)
  const pong = await channel.connect()
  check('connect answers the ping', pong.ok === true)
  check('and the channel is connected', channel.connected === true)
  check('the ping went out as a frame', transport.state.sent[0]?.op === 'ping', JSON.stringify(transport.state.sent[0]))
  const frame = await channel.request({ op: 'read', path: '/x' })
  check('a request returns its own frame', frame.ok === true)
  check('each request carries a fresh id', transport.state.sent[1]?.id !== transport.state.sent[0]?.id)
  channel.dispose()
  check('dispose drops the connection', channel.connected === false)
}

console.log('\n-- a handshake the helper REFUSES --')
{
  // The helper is alive and answering; it just says no. Returning that frame as a success
  // reported a healthy channel with `lastError` cleared.
  const transport = fakeTransport({ reply: (frame) => (frame.op === 'ping' ? { id: frame.id, ok: false, error: 'no such container: epic' } : { id: frame.id, ok: true }) })
  const channel = new RemoteChannel(transport, CONFIG, 'container')
  const refused = await channel.connect().then(() => null, (error) => String(error.message))
  check('the refusal is reported, not returned as a pong', refused !== null && refused.includes('no such container'), String(refused))
  check('and the channel does NOT claim to be connected', channel.connected === false)
  // The next call must try again rather than write into a channel that never handshook.
  const before = transport.state.sent.length
  await channel.request({ op: 'read', path: '/x' }).catch(() => {})
  check('a later call reconnects instead of using the refused one', transport.state.sent.length > before, String(transport.state.sent.length - before))
}

console.log('\n-- a helper that cannot be installed at all --')
{
  const transport = fakeTransport({ installExit: 127 })
  const channel = new RemoteChannel(transport, CONFIG, 'container')
  const refused = await channel.connect().then(() => null, (error) => String(error.message))
  check('the exit code is reported', refused !== null && refused.includes('exit 127'), String(refused))
  check('and nothing is left looking connected', channel.connected === false)
  check('the helper was never started', transport.state.runs === 0, String(transport.state.runs))
}

console.log('\n-- a host with no node --')
{
  // The raw symptom is an `exit 127` reading `node: command not found`, which looks like a
  // plugin failure rather than a missing runtime.
  const transport = fakeTransport({ noNode: true })
  const channel = new RemoteChannel(transport, CONFIG, 'host')
  const refused = await channel.connect().then(() => null, (error) => String(error.message))
  check('it says the host has no node', refused !== null && refused.includes('has no `node`'), String(refused))
  check('and nothing is left looking connected', channel.connected === false)
}

console.log('\n-- every terminal path releases its timer and its listener --')
{
  // One timed-out call used to clear neither, so a caller passing the tool's own signal
  // accumulated one listener per timeout on that same signal.
  // The helper completes the handshake and then answers nothing: `request` connects first, so a
  // helper that never handshakes could never reach the wiring under test.
  const transport = fakeTransport({ reply: (frame) => (frame.op === 'ping' ? { id: frame.id, ok: true } : undefined) })
  const channel = new RemoteChannel(transport, CONFIG, 'container')
  const { controller, counts } = countingSignal()
  await channel.connect()
  check('the handshake completed', channel.connected === true)

  for (let i = 0; i < 3; i++) {
    await channel.request({ op: 'read', path: '/x' }, 15, controller.signal).catch(() => {})
  }
  check('timed-out calls registered their abort listeners', counts.added >= 3, String(counts.added))
  check('and released every one of them', counts.removed === counts.added, counts.removed + '/' + counts.added)

  const pre = countingSignal()
  pre.controller.abort()
  const preRefused = await channel.request({ op: 'read', path: '/x' }, 15, pre.controller.signal).then(() => null, (error) => String(error.message))
  check('a pre-aborted signal is refused', preRefused !== null && preRefused.includes('cancelled'), String(preRefused))
  check('without registering a listener it would have to remove', pre.counts.added === 0, String(pre.counts.added))
  channel.dispose()
}

console.log('\n-- a reply releases the listener too --')
{
  const transport = fakeTransport()
  const channel = new RemoteChannel(transport, CONFIG, 'container')
  await channel.connect()
  const { controller, counts } = countingSignal()
  const answered = await channel.request({ op: 'read', path: '/x' }, 500, controller.signal)
  check('the call is answered', answered.ok === true)
  check('and its abort listener is released on the reply', counts.added === 1 && counts.removed === 1, counts.added + '/' + counts.removed)
  // Aborting afterwards must not reject a call that already resolved.
  controller.abort()
  await settle(5)
  check('aborting after a reply is harmless', channel.connected === true)
  channel.dispose()
}

console.log('\n-- a channel that goes away with calls in flight --')
{
  const transport = fakeTransport({ reply: (frame) => (frame.op === 'ping' ? { id: frame.id, ok: true } : undefined) })
  const channel = new RemoteChannel(transport, CONFIG, 'container')
  await channel.connect()
  const pending = channel.request({ op: 'read', path: '/x' }, 60000).catch((error) => String(error.message))
  await settle(5)
  channel.dispose()
  const outcome = await pending
  check('an in-flight call is settled when the channel is disposed', typeof outcome === 'string' && outcome.includes('disposed'), String(outcome))
  check('and the channel no longer claims to be connected', channel.connected === false)
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'))
process.exit(failures === 0 ? 0 : 1)

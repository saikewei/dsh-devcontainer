// The resident channel, over a FAKE transport. No ssh, no container: the frame protocol and
// the terminal paths are pure logic, and one of them leaked a timer per call.
//
// Worth its own suite because every failure here is quiet. A channel that never completed its
// handshake but reports `connected` is worse than one that is plainly down: the tools keep
// writing into it, and `devc_status` — the tool whose whole job is to say what is wrong — says
// everything is fine.
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteChannel } from '../lib/channel.js'
import { RemoteTransport } from '../lib/transport.js'

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
  const state = { sent: [], handles: [], installed: 0, runs: 0, disarmed: 0 }
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
      let resolveOutcome = () => {}
      const done = new Promise((resolve) => {
        resolveOutcome = (outcome) => {
          if (finished) return
          finished = true
          resolve(outcome)
        }
      })
      const finish = () => resolveOutcome({ exitCode: installing ? installExit : 0 })
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
        // The real transport arms a budget for STARTING the process and exposes this to stop
        // it counting against the session. Recording the call is what pins the contract.
        disarm() {
          state.disarmed++
        },
        terminate() {
          // What a real SIGTERM looks like: a null code and a signal name. The outcome is the
          // only record of WHY a channel went away, so the fake must not flatten it.
          if (typeof state.onTerminate === 'function') state.onTerminate()
          resolveOutcome({ exitCode: null, signal: 'SIGTERM' })
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

console.log('\n-- the startup budget is disarmed once the handshake answers --')
{
  // The bug this pins: `connect()` opened the helper with `{ timeoutMs: 30000 }`, and the
  // transport treats that budget as a LIFETIME limit — it SIGKILLs the child when it elapses.
  // The resident helper is meant to outlive the session, so every channel died 30 seconds in,
  // taking every in-flight call and every forwarded connection with it. Nothing reported it:
  // the next call simply reconnected, so the only symptom was a silent hang.
  const ok = fakeTransport()
  const channel = new RemoteChannel(ok, CONFIG, 'container')
  await channel.connect()
  check('a completed handshake disarms the budget', ok.state.disarmed === 1, String(ok.state.disarmed))
  channel.dispose()

  const refused = fakeTransport({ reply: (frame) => (frame.op === 'ping' ? { id: frame.id, ok: false, error: 'no such container' } : { id: frame.id, ok: true }) })
  const refusedChannel = new RemoteChannel(refused, CONFIG, 'container')
  await refusedChannel.connect().catch(() => {})
  check('a handshake that FAILED leaves the budget armed', refused.state.disarmed === 0, String(refused.state.disarmed))
  refusedChannel.dispose()
}

console.log('\n-- a refused handshake is not a connection --')
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

console.log('\n-- notifications carry connection bytes without expecting a reply --')
{
  // `request()` allocates an id and waits for a matching frame, so using it for relay data
  // would double the traffic on the one pipe both directions share.
  const transport = fakeTransport()
  const channel = new RemoteChannel(transport, CONFIG, 'container')
  check('an unconnected channel reports the write did NOT happen', channel.notify({ event: 'relay_data', relayId: 'r1', b64: 'AA==' }) === false)
  await channel.connect()
  const sentBefore = transport.state.sent.length
  const accepted = channel.notify({ event: 'relay_data', relayId: 'r1', b64: 'aGk=' })
  check('a connected channel accepts the frame', accepted === true)
  check('exactly one frame went out', transport.state.sent.length === sentBefore + 1, String(transport.state.sent.length - sentBefore))
  const frame = transport.state.sent[transport.state.sent.length - 1]
  check('it carries the event, not an op', frame.event === 'relay_data' && frame.op === undefined, JSON.stringify(frame))
  check('and no id, so the helper answers nothing', frame.id === undefined, JSON.stringify(frame))
  check('the payload survives the round trip', Buffer.from(frame.b64, 'base64').toString('utf8') === 'hi')

  // A notification must not register a pending entry: one would sit there until its timeout
  // and then reject, and nothing would ever resolve it.
  await settle(30)
  check('and nothing was left pending to time out', channel.connected === true)
  const frameCount = transport.state.sent.length
  check('a second notification is not answered either', channel.notify({ event: 'relay_data', relayId: 'r1', b64: 'eA==' }) === true && transport.state.sent.length === frameCount + 1)

  let drained = false
  channel.onceDrain(() => { drained = true })
  check('onceDrain registers without firing immediately', drained === false, String(drained))
  channel.dispose()
  // A disposed channel must not pretend a write landed.
  check('a disposed channel reports the write did NOT happen', channel.notify({ event: 'relay_data', relayId: 'r1', b64: 'AA==' }) === false)
}

console.log('\n-- onClose reports the process going away --')
{
  // A consumer holding something OPEN across the channel's life has nothing else to go on:
  // in-flight calls are rejected and the next one reconnects, so a caller that makes no further
  // call waits forever on a channel that is already gone.
  const transport = fakeTransport()
  const channel = new RemoteChannel(transport, CONFIG, 'container')
  await channel.connect()
  let announced = 0
  const off = channel.onClose(() => { announced++ })
  const handle = transport.state.handles[transport.state.handles.length - 1]
  handle.terminate()
  await settle(30)
  check('a listener is told when the process ends', announced === 1, String(announced))
  check('and the channel reports itself down', channel.connected === false, String(channel.connected))
  // A killed process sets a signal and no exit code. Printing the code alone said "exit null",
  // which names nothing — and the question it answers is the first one anybody asks.
  check('naming HOW it ended, not just that it did', /killed by SIGTERM/.test(String(channel.lastError)), String(channel.lastError))

  off()
  transport.state.handles[transport.state.handles.length - 1].terminate()
  await settle(20)
  check('an unsubscribed listener is not called again', announced === 1, String(announced))

  // Disposal must announce IMMEDIATELY, not whenever the process happens to die: the real
  // terminate() sends SIGTERM and only escalates to SIGKILL a second later, and a consumer
  // holding connections open cannot wait a second to learn they are already dead.
  const stubborn = fakeTransport()
  const second = new RemoteChannel(stubborn, CONFIG, 'container')
  await second.connect()
  // A process that ignores the termination request: its `done` never settles.
  stubborn.state.handles[stubborn.state.handles.length - 1].terminate = () => {}
  let onDispose = 0
  second.onClose(() => { onDispose++ })
  second.dispose()
  check('disposing announces at once, without waiting for the process', onDispose === 1, String(onDispose))
  await settle(20)
  check('and only once', onDispose === 1, String(onDispose))
}

console.log('\n-- the transport\'s budget really is a STARTUP budget --')
{
  // The contract assertion above pins the call site; this pins the mechanism. A stub `ssh` on
  // PATH stands in for the real one so the test needs no network and no host: it ignores its
  // arguments and sleeps, exactly like a resident helper that has nothing to say.
  const bin = mkdtempSync(join(tmpdir(), 'dsh-fake-ssh-'))
  writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 })
  const realPath = process.env.PATH
  process.env.PATH = bin + ':' + realPath
  const transport = new RemoteTransport('stub')
  const aliveAfter = async (handle, ms) => {
    const outcome = await Promise.race([
      handle.done.then(() => 'dead'),
      new Promise((resolve) => setTimeout(() => resolve('alive'), ms)),
    ])
    return outcome
  }
  try {
    const armed = await transport.open('helper', { timeoutMs: 300 })
    check('an armed budget kills the process when it elapses', (await aliveAfter(armed, 1200)) === 'dead')

    const disarmed = await transport.open('helper', { timeoutMs: 300 })
    disarmed.disarm()
    check('a disarmed budget does NOT', (await aliveAfter(disarmed, 1200)) === 'alive')
    disarmed.terminate()
    await aliveAfter(disarmed, 2000)

    const noBudget = await transport.open('helper', {})
    check('no budget at all leaves it running', (await aliveAfter(noBudget, 800)) === 'alive')
    noBudget.terminate()
  } finally {
    process.env.PATH = realPath
    transport.dispose()
    rmSync(bin, { recursive: true, force: true })
  }
}

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'))
process.exit(failures === 0 ? 0 : 1)

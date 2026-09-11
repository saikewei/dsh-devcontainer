/**
 * Environment probe: answers the questions the routing-provider design depends on.
 * Emits one JSON line to stdout, which the hosting profile's log captures.
 */
export const name = 'dsh-env-probe'

export const inject = ['timer']

const describe = (value) => {
  if (value === undefined) return null
  const proto = Object.getPrototypeOf(value)
  const chain = []
  let cursor = value
  while (cursor && cursor !== Object.prototype) {
    chain.push(cursor.constructor ? cursor.constructor.name : '(anon)')
    cursor = Object.getPrototypeOf(cursor)
    if (chain.length > 6) break
  }
  return { constructorChain: chain, ownMethods: Object.getOwnPropertyNames(proto) }
}

export function apply(ctx) {
  ctx.timeout(async () => {
    const report = {
      argv: process.argv.slice(0, 3),
      cwd: process.cwd(),
      node: process.version,
    }

    report.fsInstance = describe(ctx.get('fs'))
    report.shellInstance = describe(ctx.get('shell'))

    for (const specifier of [
      '@deepseek-ai/dsh-fs-sandbox',
      '@deepseek-ai/dsh-bash-sandbox',
      '@deepseek-ai/dsh-fs-local',
      '@deepseek-ai/dsh-bash-local',
      '@deepseek-ai/dsh-fs',
      '@deepseek-ai/dsh-shell',
      '@deepseek-ai/dsh-sandbox',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/cordis',
    ]) {
      try {
        const module = await import(specifier)
        report[specifier] = 'OK: ' + Object.keys(module).slice(0, 8).join(',')
      } catch (error) {
        report[specifier] = 'FAILED: ' + String(error && error.message ? error.message : error).slice(0, 160)
      }
    }

    // Can the live instance's class be subclassed? This is the zero-import fallback.
    try {
      const fs = ctx.get('fs')
      const Base = fs.constructor
      const Probe = class extends Base {}
      report.subclassLiveFs = 'OK: ' + Probe.name
    } catch (error) {
      report.subclassLiveFs = 'FAILED: ' + String(error && error.message ? error.message : error).slice(0, 160)
    }

    console.log('DSH_PROBE_BEGIN')
    console.log(JSON.stringify(report, null, 2))
    console.log('DSH_PROBE_END')
  }, 3000)
}

/**
 * dsh-devcontainer client half — a container-directory occupant for the shipped
 * "Add workspace" flow.
 *
 * The shipped flow does not pick directories itself: it declares a `directoryFlow` hole and
 * asks whichever occupant is registered for ONE absolute host path (`onPicked`). Two holes
 * exist — the sidebar browser and the blank-session hero picker — and both are filled here
 * at a priority below the shipped local chooser's.
 *
 * The dialog therefore offers both worlds: `本地` delegates straight to the deployment's own
 * picker, and `容器` browses the dev container over the host's JSON API and hands back the
 * local stand-in path that the routers accept.
 *
 * This file is hand-authored in the loader's bundle format — no build step, no JSX, and
 * `React.createElement` throughout.
 */
window.__ModuleLoader__.load({
  id: 'dsh-devcontainer',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const API = '/dsh-devcontainer'

    const styles = {
      backdrop: {
        position: 'fixed',
        inset: '0',
        zIndex: 60,
        background: 'rgba(0, 0, 0, 0.32)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      },
      dialog: {
        width: 'min(560px, 100%)',
        maxHeight: 'min(620px, 100%)',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--dsw-alias-bg-overlay)',
        color: 'var(--dsw-alias-label-primary)',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: '12px',
        boxShadow: '0 12px 40px rgba(0, 0, 0, 0.28)',
        overflow: 'hidden',
        fontSize: '14px',
        lineHeight: '20px',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '12px 16px',
        borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
      },
      title: { flex: '1', fontWeight: 600 },
      tab: (active) => ({
        cursor: 'pointer',
        border: 'none',
        borderRadius: '7px',
        padding: '4px 12px',
        fontSize: '13px',
        color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
        background: active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
      }),
      pathRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '10px 16px',
        borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
      },
      path: {
        flex: '1',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        direction: 'rtl',
        textAlign: 'left',
      },
      list: { flex: '1', overflowY: 'auto', padding: '6px 8px', minHeight: '160px' },
      row: {
        display: 'block',
        width: '100%',
        textAlign: 'left',
        cursor: 'pointer',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: '7px',
        padding: '7px 10px',
        fontSize: '13px',
      },
      muted: { padding: '14px 16px', color: 'var(--dsw-alias-label-secondary)', fontSize: '13px' },
      error: { padding: '10px 16px', color: 'var(--dsw-alias-state-error-primary)', fontSize: '13px' },
      footer: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: '8px',
        padding: '12px 16px',
        borderTop: '0.5px solid var(--dsw-alias-border-l1)',
      },
      button: (primary, disabled) => ({
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        border: primary ? 'none' : '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: '7px',
        padding: '6px 14px',
        fontSize: '13px',
        fontWeight: primary ? 600 : 400,
        color: primary ? '#fff' : 'var(--dsw-alias-label-primary)',
        background: primary ? 'var(--dsw-alias-brand-primary)' : 'transparent',
      }),
      note: {
        padding: '8px 16px',
        color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        fontSize: '12px',
      },
    }

    const text = (value) => (value === undefined || value === null ? '' : String(value))

    async function getJson(url) {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(text(payload.error) || 'HTTP ' + response.status)
      return payload
    }

    async function postJson(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(text(payload.error) || 'HTTP ' + response.status)
      return payload
    }

    /**
     * The directory-flow occupant.
     *
     * Every rising `open` edge runs exactly one interaction and reports exactly one
     * outcome, so a re-render cannot launch a second chooser while the owner adopts a path.
     */
    function ContainerDirectoryFlow(props) {
      const { open, busy, onPicked, onCancel, onError, pickLocalDirectory } = props
      const [world, setWorld] = React.useState('container')
      const [config, setConfig] = React.useState(null)
      const [path, setPath] = React.useState('')
      const [listing, setListing] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [committing, setCommitting] = React.useState(false)

      const outcome = React.useRef(props)
      outcome.current = props
      const alive = React.useRef(true)
      React.useEffect(() => () => { alive.current = false }, [])

      const browse = React.useCallback(async (target) => {
        setLoading(true)
        setError(null)
        try {
          const next = await getJson(API + '/list?path=' + encodeURIComponent(target))
          if (!alive.current) return
          setListing(next)
          setPath(next.path)
        } catch (reason) {
          if (alive.current) setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          if (alive.current) setLoading(false)
        }
      }, [])

      // Each rising open edge starts fresh at the configured browse root.
      const opened = React.useRef(false)
      React.useEffect(() => {
        if (!open) {
          opened.current = false
          return
        }
        if (opened.current) return
        opened.current = true
        setWorld('container')
        setError(null)
        setListing(null)
        setCommitting(false)
        getJson(API + '/config').then((loaded) => {
          if (!alive.current) return
          setConfig(loaded)
          return browse(loaded.browseRoot || '/')
        }, (reason) => {
          if (alive.current) setError(reason instanceof Error ? reason.message : String(reason))
        })
      }, [open, browse])

      // The local world is the deployment's own picker, not a reimplementation of it.
      const askedLocal = React.useRef(false)
      React.useEffect(() => {
        if (!open || world !== 'local') {
          askedLocal.current = false
          return
        }
        if (askedLocal.current) return
        askedLocal.current = true
        pickLocalDirectory().then((picked) => {
          if (!alive.current) return
          if (picked === null) outcome.current.onCancel()
          else outcome.current.onPicked(picked)
        }, (reason) => {
          if (!alive.current) return
          outcome.current.onError(reason instanceof Error ? reason.message : String(reason))
        })
      }, [open, world, pickLocalDirectory])

      const commit = React.useCallback(async () => {
        setCommitting(true)
        setError(null)
        try {
          const prepared = await postJson(API + '/prepare', { path })
          if (!alive.current) return
          outcome.current.onPicked(prepared.mountPath)
        } catch (reason) {
          if (!alive.current) return
          setCommitting(false)
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      }, [path])

      if (!open) return null

      const disabled = busy === true || committing
      const entries = listing === null ? [] : listing.entries

      const header = h('div', { style: styles.header },
        h('span', { style: styles.title }, '新增工作区'),
        h('button', {
          type: 'button',
          style: styles.tab(world === 'local'),
          onClick: () => setWorld('local'),
        }, '本地'),
        h('button', {
          type: 'button',
          style: styles.tab(world === 'container'),
          onClick: () => setWorld('container'),
        }, '远程'),
      )

      if (world === 'local') {
        return h('div', { style: styles.backdrop, role: 'dialog', 'aria-modal': 'true' },
          h('div', { style: styles.dialog },
            header,
            h('div', { style: styles.muted }, '已交给本机文件夹选择器…（选的是这台 Mac 上的目录）'),
            error === null ? null : h('div', { style: styles.error }, error),
            h('div', { style: styles.footer },
              h('button', { type: 'button', style: styles.button(false, false), onClick: onCancel }, '取消'),
            ),
          ),
        )
      }

      const body = []
      body.push(h('div', { key: 'path', style: styles.pathRow },
        h('button', {
          type: 'button',
          style: styles.button(false, disabled || listing === null || listing.parent === undefined),
          onClick: () => { if (listing && listing.parent !== undefined) browse(listing.parent) },
        }, '上一级'),
        h('span', { style: styles.path, title: path }, path || '…'),
      ))

      if (config !== null && config.routing !== true) {
        body.push(h('div', { key: 'warn', style: styles.note },
          '当前 profile 未启用容器路由：工作区会被登记，但文件与命令仍在本地执行。',
        ))
      }
      if (config !== null) {
        body.push(h('div', { key: 'where', style: styles.note },
          config.sshHost + ' 上的宿主目录；带标记的目录含有 .devcontainer',
        ))
      }
      if (error !== null) body.push(h('div', { key: 'error', style: styles.error }, error))

      const rows = []
      if (loading) rows.push(h('div', { key: 'loading', style: styles.muted }, '读取中…'))
      else if (entries.length === 0) rows.push(h('div', { key: 'empty', style: styles.muted }, '没有子目录'))
      else {
        for (const entry of entries) {
          rows.push(h('button', {
            key: entry.path,
            type: 'button',
            style: styles.row,
            disabled,
            onClick: () => browse(entry.path),
            onMouseEnter: (event) => { event.currentTarget.style.background = 'var(--dsw-alias-bg-layer-2)' },
            onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
          }, entry.hasDevcontainer === true ? '📁  ' + entry.name + '   ⬢ dev container' : '📁  ' + entry.name))
        }
      }
      body.push(h('div', { key: 'list', style: styles.list }, rows))

      return h('div', { style: styles.backdrop, role: 'dialog', 'aria-modal': 'true' },
        h('div', { style: styles.dialog },
          header,
          body,
          h('div', { style: styles.footer },
            h('button', { type: 'button', style: styles.button(false, false), onClick: onCancel }, '取消'),
            h('button', {
              type: 'button',
              style: styles.button(true, disabled || path === ''),
              disabled: disabled || path === '',
              onClick: commit,
            }, committing || busy === true ? '登记中…' : '用此目录建工作区'),
          ),
        ),
      )
    }

    /** Required services (cordis fiber inject): the slot registry and its workspace actions. */
    const inject = ['slots', 'uiWorkspace']

    /**
     * Register the occupant into BOTH directory-flow holes through `slots.inject()`, because
     * the ui-workspace entries may activate later or replace their declarations.
     */
    function apply(ctx) {
      const injected = () => ({ pickLocalDirectory: () => ctx.uiWorkspace.pickDirectory() })
      ctx.slots.inject('conversation.hero.workspace.directoryFlow', () => ctx.slots.inject(
        'sidebar.workspaces.directoryFlow',
        function* () {
          // Below the shipped local chooser, so this occupant owns the interaction.
          yield ctx.slots.register({
            name: 'conversation.hero.workspace.directoryFlow',
            priority: -100,
            inject: injected,
          }, ContainerDirectoryFlow)
          yield ctx.slots.register({
            name: 'sidebar.workspaces.directoryFlow',
            priority: -100,
            inject: injected,
          }, ContainerDirectoryFlow)
        },
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})

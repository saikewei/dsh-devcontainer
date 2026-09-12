/**
 * dsh-devcontainer client half — a container-directory occupant for the shipped
 * "Add workspace" flow.
 *
 * The shipped flow does not pick directories itself: it declares a `directoryFlow` hole and
 * asks whichever occupant is registered for ONE absolute host path (`onPicked`). Two holes
 * exist — the sidebar browser and the blank-session hero picker — and both are filled here
 * at a priority below the shipped local chooser's.
 *
 * The dialog therefore offers two worlds: `本机` delegates to the deployment's own picker,
 * and `远程容器` browses the dev container over the host's JSON API and hands back the local
 * stand-in path that the routers accept.
 *
 * ## Re-entry contract
 *
 * The owner keeps this component mounted while `open` is false and merely stops rendering it,
 * so every hook and every piece of state survives a close. All per-interaction state is
 * therefore reset on the RISING edge of `open` (never on the falling edge), and no effect
 * fires an interaction on its own: the local chooser starts only from a click. Cancelling it
 * returns to the dialog instead of closing the flow, so a cancelled attempt can never wedge
 * the next one.
 *
 * ## Styling
 *
 * This bundle is served as-is to the browser and cannot require the app's internal UI
 * primitives, so the dialog hand-rolls the shipped directory picker's visual language: one
 * tag-guarded <style> element, a scoped `dshDc_` class prefix, and only `--dsw-alias-*`
 * theme tokens (alpha overlays for interaction states, so light and dark both work).
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

    /**
     * One id, two seats: the sidebar row and the central panel it opens are the same string,
     * because the sidebar resolves a panellist entry to the `main` cell of that exact id.
     */
    const PORTS_PANEL_ID = 'dsh-devcontainer.ports'

    /**
     * Mirrors the shipped `DirectoryBrowser` metrics (680px wide, 28px rows, 13px/500
     * labels) so the two pickers are visually interchangeable. Interaction states use the
     * alpha `interactive-bg-*` aliases, which composite correctly on either theme's surface.
     */
    const CSS = [
      '.dshDc_scrim{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.32))}',
      '.dshDc_dialog{box-sizing:border-box;display:flex;flex-direction:column;width:min(680px,100%);height:min(520px,100dvh - 32px);overflow:hidden;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.28);font-size:14px;line-height:20px}',
      '.dshDc_header{flex:none;display:flex;flex-direction:column;gap:10px;padding:16px 24px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3)}',
      '.dshDc_titleRow{display:flex;align-items:center;gap:12px;min-height:28px}',
      '.dshDc_title{margin:0;font-size:16px;font-weight:510;line-height:24px;color:var(--dsw-alias-label-primary)}',
      '.dshDc_tabs{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:9px;background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshDc_tab{cursor:pointer;padding:3px 14px;border:.5px solid transparent;border-radius:7px;background:0 0;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:13px;font-weight:500;line-height:20px;transition:background .12s,color .12s,border-color .12s}',
      '.dshDc_tab:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
      '.dshDc_tabOn,.dshDc_tabOn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover));border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}',
      '.dshDc_tab:disabled{cursor:default;color:var(--dsw-alias-label-caption)}',
      '.dshDc_sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dshDc_bar{flex:none;display:flex;align-items:center;gap:8px;padding:10px 24px;border-bottom:.5px solid var(--dsw-alias-border-l3)}',
      '.dshDc_label{flex:none;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',
      '.dshDc_select{box-sizing:border-box;flex:1;min-width:0;height:28px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px}',
      '.dshDc_select:disabled{cursor:not-allowed;opacity:.5}',
      '.dshDc_path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dshDc_body{position:relative;flex:1 1 0;min-height:0;display:flex;flex-direction:column;padding:12px 16px 12px 24px}',
      '.dshDc_list{flex:1 1 0;min-height:0;overflow-y:auto;scrollbar-width:thin;display:flex;flex-direction:column;gap:2px;padding-right:8px}',
      '.dshDc_row{display:flex;align-items:center;gap:6px;width:100%;height:28px;padding:4px;border:none;border-radius:6px;background:0 0;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.dshDc_row:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshDc_row:disabled{cursor:default;opacity:.5}',
      '.dshDc_rowIcon{flex:none;color:var(--dsw-alias-label-secondary)}',
      '.dshDc_rowName{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.dshDc_chev{flex:none;color:var(--dsw-alias-label-tertiary)}',
      '.dshDc_chip{flex:none;padding:1px 6px;border-radius:5px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-success-primary);font-size:11px;font-weight:500;line-height:16px}',
      '.dshDc_note{padding:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dshDc_err{padding:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}',
      '.dshDc_stack{display:flex;flex-direction:column;gap:10px;max-width:520px;padding:4px 4px 4px 0}',
      '.dshDc_stackTitle{font-size:14px;font-weight:510;line-height:22px;color:var(--dsw-alias-label-primary)}',
      '.dshDc_footer{flex:none;display:flex;align-items:center;gap:8px;padding:14px 24px;border-top:.5px solid var(--dsw-alias-border-l3)}',
      '.dshDc_gap{flex:1 1 0}',
      '.dshDc_btn{cursor:pointer;height:30px;padding:0 14px;border:.5px solid transparent;border-radius:8px;background:0 0;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;font-weight:500;line-height:20px;white-space:nowrap;transition:background .12s,border-color .12s,opacity .12s}',
      '.dshDc_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshDc_btn:disabled{cursor:not-allowed;opacity:.4}',
      '.dshDc_btnSec{border-color:var(--dsw-alias-border-l4)}',
      '.dshDc_btnPri{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.dshDc_btnPri:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.dshDc_panel{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:14px;line-height:20px}',
      '.dshDc_panelHead{flex:none;display:flex;align-items:baseline;gap:10px;padding:18px 24px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3)}',
      '.dshDc_panelTitle{margin:0;font-size:16px;font-weight:510;line-height:24px;color:var(--dsw-alias-label-primary)}',
      '.dshDc_panelSub{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dshDc_panelBody{flex:1 1 0;min-height:0;overflow-y:auto;scrollbar-width:thin;display:flex;flex-direction:column;gap:16px;padding:14px 24px 24px}',
      '.dshDc_section{display:flex;flex-direction:column;gap:2px}',
      '.dshDc_sectionTitle{padding:0 6px 4px;font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dshDc_portRow{display:flex;align-items:center;gap:10px;min-height:32px;padding:3px 6px;border-radius:6px}',
      '.dshDc_portRow:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshDc_portNum{flex:none;min-width:56px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.dshDc_portMeta{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dshDc_portActions{flex:none;display:flex;align-items:center;gap:4px}',
      '.dshDc_badge{flex:none;padding:1px 6px;border-radius:5px;background:var(--dsw-alias-interactive-bg-hover);font-size:11px;font-weight:500;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
      '.dshDc_badgeOn{color:var(--dsw-alias-state-success-primary)}',
      '.dshDc_empty{padding:4px 6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption)}',
    ].join('')

    const CSS_TAG = 'dsh-devcontainer/DirectoryFlow.css'

    if (
      typeof document !== 'undefined' &&
      document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']') === null
    ) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-devcontainer'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    const text = (value) => (value === undefined || value === null ? '' : String(value))
    const reason = (value) => (value instanceof Error ? value.message : text(value))

    async function request(url, init) {
      const response = await fetch(url, init)
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(text(payload.error) || 'HTTP ' + response.status)
      return payload
    }

    const getJson = (url) => request(url, { headers: { accept: 'application/json' } })
    const postJson = (url, body) =>
      request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })

    /** 16px inline glyphs, `currentColor` so they inherit the row/label tokens. */
    function glyph(path, className) {
      return h(
        'svg',
        {
          className,
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: path }),
      )
    }

    const folderGlyph = (className) =>
      glyph(
        'M1.9 4.7c0-.8.6-1.4 1.4-1.4h2.3l1.3 1.6h5.2c.8 0 1.4.6 1.4 1.4v5c0 .8-.6 1.4-1.4 1.4H3.3c-.8 0-1.4-.6-1.4-1.4z',
        className,
      )
    const chevronGlyph = (className) => glyph('M6.3 3.9L10.3 8l-4 4.1', className)

    /**
     * The directory-flow occupant.
     *
     * Exactly one user gesture produces exactly one outcome: either the owner adopts a path
     * (`onPicked`), or the flow ends (`onCancel`/`onError`). Nothing is started by an effect,
     * so re-entering the dialog can never launch a chooser the user did not ask for.
     */
    function ContainerDirectoryFlow(props) {
      const { open, busy, onPicked, onCancel, onError, pickLocalDirectory } = props

      const [world, setWorld] = React.useState('container')
      const [config, setConfig] = React.useState(null)
      const [host, setHost] = React.useState('')
      const [path, setPath] = React.useState('')
      const [listing, setListing] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [committing, setCommitting] = React.useState(false)
      const [localPhase, setLocalPhase] = React.useState('idle')
      const [localError, setLocalError] = React.useState(null)
      /**
       * Set when the deployment serves no container API at all — a profile that mounts this
       * plugin without configuring a stand-in. The occupant then steps aside and runs the
       * deployment's own chooser, instead of showing a dialog it could not act on.
       */
      const [delegating, setDelegating] = React.useState(false)

      // The owner re-renders with new callbacks; read them at call time rather than closing over them.
      const latest = React.useRef(props)
      latest.current = props

      // Bumped per interaction attempt so a slow response cannot land in a later one.
      const runId = React.useRef(0)
      const alive = React.useRef(true)
      React.useEffect(() => () => { alive.current = false }, [])

      const fresh = (id) => alive.current && runId.current === id

      // Separate from `runId`: browsing again within one open interaction (host switch, drill
      // down) must also invalidate an in-flight listing, or a slow reply could overwrite it.
      const listSeq = React.useRef(0)

      const browse = React.useCallback(async (target, machine, id) => {
        const seq = listSeq.current + 1
        listSeq.current = seq
        const current = () => fresh(id) && listSeq.current === seq
        setLoading(true)
        setError(null)
        try {
          const next = await getJson(
            API + '/list?host=' + encodeURIComponent(machine ?? '') + '&path=' + encodeURIComponent(target),
          )
          if (!current()) return
          setListing(next)
          setPath(text(next.path))
        } catch (problem) {
          if (current()) setError(reason(problem))
        } finally {
          if (current()) setLoading(false)
        }
      }, [])

      /**
       * Hand the whole interaction to the deployment's own chooser.
       *
       * This is the behaviour the shipped flow has without this plugin installed, so a profile
       * that configures no stand-in keeps a working "Add workspace" button. Cancelling ends the
       * flow exactly as the shipped chooser does; nothing is remembered, so the next open starts
       * the same way.
       */
      const delegateLocal = React.useCallback((id) => {
        setDelegating(true)
        const pick = latest.current.pickLocalDirectory
        if (typeof pick !== 'function') {
          setDelegating(false)
          setError('当前环境没有提供文件夹选择器。')
          return
        }
        let pending
        try {
          pending = pick()
        } catch (problem) {
          setDelegating(false)
          setError('无法打开文件夹选择器：' + reason(problem))
          return
        }
        Promise.resolve(pending).then(
          (picked) => {
            if (!fresh(id)) return
            if (picked === null || picked === undefined) latest.current.onCancel()
            else latest.current.onPicked(picked)
          },
          (problem) => {
            if (!fresh(id)) return
            setDelegating(false)
            setError('无法打开文件夹选择器：' + reason(problem))
          },
        )
      }, [])

      /** RISING edge of `open`: the component stayed mounted, so reset every interaction here. */
      React.useEffect(() => {
        if (!open) return undefined
        const id = runId.current + 1
        runId.current = id
        setWorld('container')
        setConfig(null)
        setHost('')
        setPath('')
        setListing(null)
        setError(null)
        setCommitting(false)
        setLocalPhase('idle')
        setLocalError(null)
        setDelegating(false)
        setLoading(true)
        getJson(API + '/config').then(
          (loaded) => {
            if (!fresh(id)) return
            setConfig(loaded)
            setHost(text(loaded.defaultHost))
            return browse(text(loaded.browseRoot) || '/', text(loaded.defaultHost), id)
          },
          () => {
            // No container API in this profile: defer to the shipped chooser rather than
            // reporting an error the operator cannot act on. `world` is deliberately left
            // alone — the dialog is not rendered at all on this path.
            if (!fresh(id)) return
            setLoading(false)
            delegateLocal(id)
          },
        )
        return undefined
      }, [open, browse, delegateLocal])

      const localPhaseRef = React.useRef(localPhase)
      localPhaseRef.current = localPhase
      const committingRef = React.useRef(committing)
      committingRef.current = committing

      /** Only ever called from a click, so cancelling leaves the dialog usable. */
      const askLocal = React.useCallback(() => {
        if (localPhaseRef.current === 'asking') return
        const pick = latest.current.pickLocalDirectory
        if (typeof pick !== 'function') {
          setLocalPhase('unavailable')
          return
        }
        const id = runId.current
        setLocalPhase('asking')
        setLocalError(null)
        let pending
        try {
          pending = pick()
        } catch (problem) {
          setLocalPhase('idle')
          setLocalError(reason(problem))
          return
        }
        // `Promise.resolve` also tolerates a picker that answers synchronously.
        Promise.resolve(pending).then(
          (picked) => {
            if (!fresh(id)) return
            if (picked === null || picked === undefined) {
              setLocalPhase('cancelled')
              return
            }
            setLocalPhase('idle')
            latest.current.onPicked(picked)
          },
          (problem) => {
            if (!fresh(id)) return
            setLocalPhase('idle')
            setLocalError(reason(problem))
          },
        )
      }, [])

      const commit = React.useCallback(async () => {
        const id = runId.current
        setCommitting(true)
        setError(null)
        try {
          const prepared = await postJson(API + '/prepare', { host, path })
          if (!fresh(id)) return
          latest.current.onPicked(text(prepared.mountPath))
        } catch (problem) {
          if (!fresh(id)) return
          setCommitting(false)
          setError(reason(problem))
        }
      }, [host, path])

      // Escape closes the flow, but never while the deployment is mid-commit.
      React.useEffect(() => {
        if (!open || world === 'local') return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          if (latest.current.busy === true || committingRef.current) return
          event.stopPropagation()
          latest.current.onCancel()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open, world])

      // `delegating` renders nothing: the deployment's own chooser owns the screen.
      if (!open || delegating) return null

      const disabled = busy === true || committing
      const hosts = config === null || !Array.isArray(config.hosts) ? [] : config.hosts
      const entries = listing === null || !Array.isArray(listing.entries) ? [] : listing.entries
      // The API answers `parent: null` at the browse root and may omit it entirely elsewhere,
      // so only a real string counts as a navigable parent.
      const parent =
        listing === null || typeof listing.parent !== 'string' || listing.parent === '' ? null : listing.parent
      const selectWorld = (next) => {
        setWorld(next)
        if (next === 'local') askLocal()
      }
      const tabs = h(
        'div',
        { className: 'dshDc_tabs', role: 'tablist' },
        ...[['container', '远程容器'], ['local', '本机']].map(([id, label]) =>
          h(
            'button',
            {
              key: id,
              type: 'button',
              role: 'tab',
              'aria-selected': world === id,
              className: world === id ? 'dshDc_tab dshDc_tabOn' : 'dshDc_tab',
              disabled,
              onClick: () => selectWorld(id),
            },
            label,
          ),
        ),
      )

      const header = h(
        'div',
        { className: 'dshDc_header' },
        h('div', { className: 'dshDc_titleRow' }, h('h2', { className: 'dshDc_title' }, '新增工作区'), tabs),
        h(
          'div',
          { className: 'dshDc_sub' },
          world === 'local'
            ? '使用这台电脑的文件夹选择器，登记为普通本地工作区。'
            : '在远程主机上选择目录，由它对应的开发容器打开。',
        ),
      )

      const cancelButton = h(
        'button',
        { type: 'button', className: 'dshDc_btn dshDc_btnSec', onClick: () => latest.current.onCancel() },
        '取消',
      )

      if (world === 'local') {
        const stack = [
          h('div', { key: 'title', className: 'dshDc_stackTitle' }, '在这台电脑上选择文件夹'),
          h(
            'div',
            { key: 'hint', className: 'dshDc_note' },
            '本机选择器由 DSH 提供；它弹出的窗口可能位于浏览器之后，取消后可以再试。',
          ),
        ]
        if (localPhase === 'asking') stack.push(h('div', { key: 'asking', className: 'dshDc_note' }, '等待选择器返回…'))
        if (localPhase === 'cancelled') stack.push(h('div', { key: 'off', className: 'dshDc_note' }, '上次未选择任何文件夹。'))
        if (localPhase === 'unavailable')
          stack.push(h('div', { key: 'na', className: 'dshDc_err' }, '当前环境没有提供本机文件夹选择器。'))
        if (localError !== null) stack.push(h('div', { key: 'err', className: 'dshDc_err' }, localError))
        stack.push(
          h(
            'div',
            { key: 'go' },
            h(
              'button',
              {
                type: 'button',
                className: 'dshDc_btn dshDc_btnSec',
                disabled: disabled || localPhase === 'asking' || localPhase === 'unavailable',
                onClick: askLocal,
              },
              localPhase === 'asking' ? '选择中…' : '选择文件夹…',
            ),
          ),
        )
        return h(
          'div',
          { className: 'dshDc_scrim', role: 'dialog', 'aria-modal': 'true', 'aria-label': '新增工作区' },
          h(
            'div',
            { className: 'dshDc_dialog' },
            header,
            h('div', { className: 'dshDc_body' }, h('div', { className: 'dshDc_stack' }, ...stack)),
            h('div', { className: 'dshDc_footer' }, h('div', { className: 'dshDc_gap' }), cancelButton),
          ),
        )
      }

      const rows = []
      if (loading) rows.push(h('div', { key: 'loading', className: 'dshDc_note' }, '读取中…'))
      else if (entries.length === 0) rows.push(h('div', { key: 'empty', className: 'dshDc_note' }, '没有子目录'))
      else {
        for (const entry of entries) {
          rows.push(
            h(
              'button',
              {
                key: text(entry.path),
                type: 'button',
                className: 'dshDc_row',
                disabled,
                title: text(entry.path),
                onClick: () => browse(text(entry.path), host, runId.current),
              },
              folderGlyph('dshDc_rowIcon'),
              h('span', { className: 'dshDc_rowName' }, text(entry.name)),
              entry.hasDevcontainer === true ? h('span', { className: 'dshDc_chip' }, 'devcontainer') : null,
              chevronGlyph('dshDc_chev'),
            ),
          )
        }
      }

      const body = []
      if (hosts.length > 0) {
        body.push(
          h(
            'div',
            { key: 'host', className: 'dshDc_bar' },
            h('span', { className: 'dshDc_label', title: text(config.sshConfigPath) }, '主机'),
            h(
              'select',
              {
                className: 'dshDc_select',
                value: host,
                disabled,
                onChange: (event) => {
                  const next = event.target.value
                  setHost(next)
                  setListing(null)
                  browse(text(config.browseRoot) || '/', next, runId.current)
                },
              },
              ...hosts.map((entry) =>
                h(
                  'option',
                  { key: text(entry.alias), value: text(entry.alias) },
                  text(entry.alias) +
                    (entry.hostName === undefined
                      ? ''
                      : '  ·  ' + (entry.user ? entry.user + '@' : '') + text(entry.hostName)),
                ),
              ),
            ),
          ),
        )
      }

      if (config !== null && config.hostsError !== undefined) {
        body.push(
          h(
            'div',
            { key: 'hostsError', className: 'dshDc_err', title: text(config.sshConfigPath) },
            '读取 SSH 主机失败：' + text(config.hostsError),
          ),
        )
      }

      body.push(
        h(
          'div',
          { key: 'path', className: 'dshDc_bar' },
          h(
            'button',
            {
              type: 'button',
              className: 'dshDc_btn dshDc_btnSec',
              disabled: disabled || parent === null,
              onClick: () => { if (parent !== null) browse(parent, host, runId.current) },
            },
            '上一级',
          ),
          h('span', { className: 'dshDc_path', title: path }, path || '…'),
        ),
      )

      if (error !== null) body.push(h('div', { key: 'error', className: 'dshDc_err' }, error))
      body.push(h('div', { key: 'list', className: 'dshDc_list' }, ...rows))

      return h(
        'div',
        { className: 'dshDc_scrim', role: 'dialog', 'aria-modal': 'true', 'aria-label': '新增工作区' },
        h(
          'div',
          { className: 'dshDc_dialog' },
          header,
          h('div', { className: 'dshDc_body' }, ...body),
          h(
            'div',
            { className: 'dshDc_footer' },
            hosts.length === 0 && config !== null
              ? h('span', { className: 'dshDc_label' }, host ? host + ' 上的宿主目录' : '未发现可用的 SSH 主机')
              : h('span', { className: 'dshDc_label' }, '带 devcontainer 标记的目录可直接建成开发容器工作区'),
            h('div', { className: 'dshDc_gap' }),
            cancelButton,
            h(
              'button',
              {
                type: 'button',
                className: 'dshDc_btn dshDc_btnPri',
                disabled: disabled || path === '' || loading,
                onClick: commit,
              },
              committing || busy === true ? '登记中…' : '使用此目录',
            ),
          ),
        ),
      )
    }

    /** Required services (cordis fiber inject): the slot registry and its workspace actions. */
    const inject = ['slots', 'uiWorkspace']

    /**
     * How often the panel re-reads the forward and listening state.
     *
     * Short enough that a dev server started a second ago appears while the operator is still
     * looking at the panel, long enough that an idle panel is not a busy channel.
     */
    const PORTS_POLL_MS = 3000

    /**
     * The sidebar's panel glyph.
     *
     * The sidebar owns the row, the tooltip, the active state and the CLICK — it calls
     * `ctx.layout.selectPanel(id)` itself. This component is only the icon inside that button,
     * so it must not draw a button of its own, and `currentColor` is what makes it follow the
     * row's own colour in both themes and in both the expanded and rail layouts.
     */
    function PortsGlyph(props) {
      const size = props.size === undefined ? 16 : props.size
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, [
        h('path', { key: 'prong-a', d: 'M5.5 2v3' }),
        h('path', { key: 'prong-b', d: 'M10.5 2v3' }),
        h('path', { key: 'body', d: 'M3.5 5h9v2.5a4.5 4.5 0 0 1-9 0z' }),
        h('path', { key: 'cable', d: 'M8 12v2' }),
      ])
    }

    /** One row of either list: the number, whatever is known about it, and its actions. */
    function PortRow(props) {
      return h('div', { className: 'dshDc_portRow' }, [
        h('span', { key: 'n', className: 'dshDc_portNum' }, text(props.label)),
        h('span', { key: 'm', className: 'dshDc_portMeta' }, text(props.meta)),
        props.badge === undefined
          ? null
          : h('span', { key: 'b', className: props.badgeOn === true ? 'dshDc_badge dshDc_badgeOn' : 'dshDc_badge' }, text(props.badge)),
        h('span', { key: 'a', className: 'dshDc_portActions' }, props.actions),
      ])
    }

    /**
     * The Ports panel: what this machine forwards, and what the container is listening on.
     *
     * It polls rather than subscribing: a listening port appears because a process inside the
     * container opened it, which nothing on this side is told about. Polling stops with the
     * component — the effect's cleanup clears the interval — so an unvisited panel costs
     * nothing.
     */
    function PortsPanel() {
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: null })
      const [busy, setBusy] = React.useState(null)
      const [note, setNote] = React.useState(null)
      // One shared reader, so a manual refresh and the poll cannot land out of order and show
      // a stale list under a newer one.
      const reading = React.useRef(false)

      const read = React.useCallback(async () => {
        if (reading.current) return
        reading.current = true
        try {
          const data = await getJson(API + '/ports')
          setState({ phase: 'ready', data, error: null })
        } catch (problem) {
          setState((previous) => ({ phase: 'ready', data: previous.data, error: reason(problem) }))
        } finally {
          reading.current = false
        }
      }, [])

      React.useEffect(() => {
        let live = true
        const tick = () => {
          if (live) void read()
        }
        tick()
        const timer = setInterval(tick, PORTS_POLL_MS)
        return () => {
          live = false
          clearInterval(timer)
        }
      }, [read])

      const act = React.useCallback(async (key, run) => {
        setBusy(key)
        setNote(null)
        try {
          const answer = await run()
          const forward = answer === undefined ? undefined : answer.forward
          if (forward !== undefined && forward.substituted === true) {
            setNote('本地端口已被占用，改在 ' + String(forward.localPort) + ' 上应答')
          }
          await read()
        } catch (problem) {
          setNote(reason(problem))
        } finally {
          setBusy(null)
        }
      }, [read])

      const start = (port) => act('add:' + String(port), () => postJson(API + '/ports', { port }))
      const stop = (port) => act('del:' + String(port), () => request(API + '/ports', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ port }),
      }))

      const data = state.data
      const forwards = data === null ? [] : data.forwards
      const forwarded = new Set(forwards.map((entry) => entry.remotePort))
      const listening = data === null ? [] : data.listening

      const parts = [
        h('div', { key: 'head', className: 'dshDc_panelHead' }, [
          h('h2', { key: 't', className: 'dshDc_panelTitle' }, '端口'),
          h('span', { key: 's', className: 'dshDc_panelSub' }, data === null
            ? ''
            : '容器 ' + text(data.container) + ' · 绑定 ' + text(data.bind)),
          h('button', {
            key: 'r',
            type: 'button',
            className: 'dshDc_btn dshDc_btnSec',
            onClick: () => void read(),
          }, '刷新'),
        ]),
      ]

      const body = [
        h('div', { key: 'fwd', className: 'dshDc_section' }, [
          h('div', { key: 't', className: 'dshDc_sectionTitle' }, '转发中'),
          forwards.length === 0
            ? h('div', { key: 'e', className: 'dshDc_empty' }, '还没有转发。在下面选一个端口，或让 agent 用 devc_forward。')
            : null,
          ...forwards.map((entry) => h(PortRow, {
            key: 'f' + String(entry.remotePort),
            label: String(entry.localPort),
            meta: '→ ' + text(entry.container) + ':' + String(entry.remotePort)
              + (entry.connections > 0 ? ' · ' + String(entry.connections) + ' 个连接' : ''),
            badge: entry.auto === true ? '自动' : undefined,
            badgeOn: true,
            actions: [
              h('button', {
                key: 'open',
                type: 'button',
                className: 'dshDc_btn dshDc_btnSec',
                onClick: () => window.open(entry.url, '_blank', 'noopener'),
              }, '打开'),
              h('button', {
                key: 'copy',
                type: 'button',
                className: 'dshDc_btn dshDc_btnSec',
                onClick: () => { void navigator.clipboard.writeText(entry.url) },
              }, '复制'),
              h('button', {
                key: 'stop',
                type: 'button',
                className: 'dshDc_btn',
                disabled: busy !== null,
                onClick: () => void stop(entry.remotePort),
              }, '停止'),
            ],
          })),
        ]),
        h('div', { key: 'lsn', className: 'dshDc_section' }, [
          h('div', { key: 't', className: 'dshDc_sectionTitle' }, '容器正在监听'),
          data !== null && data.listeningError !== undefined
            // A probe that failed says so. An empty list here would read as "nothing is
            // listening", which is a different fact and a wrong one.
            ? h('div', { key: 'e', className: 'dshDc_err' }, '探测失败：' + text(data.listeningError))
            : null,
          data !== null && data.listeningError === undefined && listening.length === 0
            ? h('div', { key: 'e', className: 'dshDc_empty' }, '容器里没有检测到监听端口。')
            : null,
          ...listening.map((entry) => h(PortRow, {
            key: 'l' + String(entry.port),
            label: String(entry.port),
            meta: (entry.process === undefined ? '' : text(entry.process) + ' · ')
              + (entry.loopback === true ? '仅供容器内部' : text(entry.address)),
            badge: forwarded.has(entry.port) ? '已转发' : undefined,
            badgeOn: forwarded.has(entry.port),
            actions: forwarded.has(entry.port)
              ? [h('button', {
                key: 'stop',
                type: 'button',
                className: 'dshDc_btn',
                disabled: busy !== null,
                onClick: () => void stop(entry.port),
              }, '停止')]
              : [h('button', {
                key: 'go',
                type: 'button',
                className: 'dshDc_btn dshDc_btnPri',
                disabled: busy !== null,
                onClick: () => void start(entry.port),
              }, '转发')],
          })),
        ]),
      ]

      parts.push(h('div', { key: 'body', className: 'dshDc_panelBody' }, [
        state.error === null ? null : h('div', { key: 'x', className: 'dshDc_err' }, state.error),
        note === null ? null : h('div', { key: 'n', className: 'dshDc_note' }, note),
        ...body,
      ]))
      return h('div', { className: 'dshDc_panel' }, parts)
    }

    /**
     * Does this deployment serve the container picker API at all?
     *
     * The client bundle is delivered to every profile that installs the package, but the
     * browse API behind the dialog is registered only where a stand-in is configured. The
     * directory-picker seam is a discriminated capability — a `native` backend answers
     * `pickDirectory()`, while a `browse` backend serves listing primitives for an in-app
     * browser this bundle cannot reproduce — so an occupant with nothing to add must not
     * take the hole. Leaving it alone lets the deployment's own chooser render itself for
     * whichever backend it resolved, exactly as if this plugin were not installed.
     *
     * Only a definitive 404 counts as "not mounted": anything ambiguous keeps the occupant,
     * so a transient hiccup cannot silently remove a working picker.
     */
    async function containerApiMounted() {
      try {
        const response = await fetch(API + '/config', { headers: { accept: 'application/json' } })
        return response.status !== 404
      } catch (problem) {
        return true
      }
    }

    /**
     * Register the occupant into BOTH directory-flow holes through `slots.inject()`, because
     * the ui-workspace entries may activate later or replace their declarations.
     */
    async function apply(ctx) {
      if (!(await containerApiMounted())) return

      // The port panel rides the SAME probe as the picker: the routes behind it live in the
      // one prefix handler, so a profile that answers `/config` answers `/ports` too — and a
      // profile that answers neither gets no panel icon at all rather than an icon that opens
      // a panel that cannot load.
      //
      // Two seats, one id: the sidebar resolves a panellist entry's id to the matching `main`
      // panel, so these must agree or the icon opens nothing.
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.inject(
        'main',
        function* () {
          yield ctx.slots.register({
            name: 'sidebar.panellist',
            id: PORTS_PANEL_ID,
            order: 100,
            label: '端口',
          }, PortsGlyph)
          yield ctx.slots.register({ name: 'main', key: PORTS_PANEL_ID }, PortsPanel)
        },
      ))

      const injected = () => ({ pickLocalDirectory: () => ctx.uiWorkspace.pickDirectory() })
      ctx.slots.inject('conversation.hero.workspace.directoryFlow', () => ctx.slots.inject(
        'sidebar.workspaces.directoryFlow',
        function* () {
          // Below the shipped chooser, so this occupant owns the interaction where it
          // registered at all — which happens only when there is something to own.
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

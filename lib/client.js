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
     * The tab type this plugin registers for CONTAINER file addresses.
     *
     * `id` is what a pane dispatches on (a tab body registers under the type's `id`), and
     * `kind` is the discriminator the address resolver ranks. They are kept apart because the
     * shipped text preview already owns `kind: "text"` in the `fallback` band, and the
     * registry refuses to share a kind with a fallback at all — so a second file viewer has to
     * be a kind of its own. That is not a workaround: `candidates()` ranks across every kind,
     * so a distinct kind competes with the text preview on band first.
     */
    const CONTAINER_FILE_TAB_ID = 'dsh-devcontainer.file'
    const CONTAINER_FILE_TAB_KIND = 'dsh-devcontainer'

    /** The address grammar the Sidebar and the resource model name a file with. */
    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/session/'

    /**
     * Every root this profile can route into a container, as the HOST answers it.
     *
     * Read once from `/config` so `canOpen` can stay synchronous — the resolver consults it
     * while deciding which type opens an address, which is not a place that can await a
     * request. It is the same authority the `/file` route itself uses, so a path this accepts
     * is a path that route will serve.
     */
    let containerRoots = []

    /**
     * The absolute container path an address names, or undefined when it names something else.
     *
     * The grammar encodes path segments individually, so decoding the whole remainder at once
     * is correct: a segment never contains a literal separator to confuse the split.
     */
    function containerPathOfAddress(address) {
      if (typeof address !== 'string' || !address.startsWith(FILE_ADDRESS_PREFIX)) return undefined
      const rest = address.slice(FILE_ADDRESS_PREFIX.length)
      const separator = rest.indexOf('/')
      if (separator === -1) return undefined
      const raw = rest.slice(separator)
      let decoded
      try {
        decoded = decodeURIComponent(raw)
      } catch {
        decoded = raw
      }
      // The grammar encodes the path segment by segment, so an ABSOLUTE path contributes an
      // empty first segment and the join leaves a doubled leading separator. Collapse it —
      // two spellings of one path must not disagree about which root it sits under, and every
      // comparison downstream is a prefix test against a root that has exactly one slash.
      return decoded.replace(/^\/+/, '/')
    }

    /** Whether a container path sits under one of the roots this profile routes. */
    function underContainerRoot(path) {
      return containerRoots.some((root) => path.startsWith(root + '/'))
    }

    const basenameOf = (path) => {
      const trimmed = text(path).replace(/[/\\]+$/, '')
      const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
      return cut === -1 ? trimmed : trimmed.slice(cut + 1)
    }

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
      '.dshDc_fileWrap{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;color:var(--dsw-alias-label-primary)}',
      '.dshDc_fileBar{flex:none;display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3)}',
      '.dshDc_filePath{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dshDc_fileNote{flex:none;padding:1px 6px;border-radius:5px;background:var(--dsw-alias-interactive-bg-hover);font-size:11px;font-weight:500;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
      '.dshDc_fileCode{flex:1 1 0;min-height:0;overflow:auto;scrollbar-width:thin;margin:0;padding:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;white-space:pre;tab-size:4;color:var(--dsw-alias-label-primary)}',
      // Wrapping is a property of this scrollport. The shipped document body renders each page
      // as a `pre` with `white-space: inherit`, so the toggle only has to change this element,
      // and no class from another package is ever named here.
      '.dshDc_fileScroll{flex:1 1 0;min-height:0;overflow:auto;scrollbar-width:thin;white-space:pre}',
      '.dshDc_fileScroll pre{white-space:inherit;margin:0}',
      '.dshDc_fileWrapped{white-space:pre-wrap;word-break:break-word}',
      '.dshDc_fileMsg{padding:16px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.dshDc_fileErr{color:var(--dsw-alias-state-error-primary)}',
      '.dshDc_fileTool{cursor:pointer;flex:none;height:24px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:6px;background:0 0;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:1;white-space:nowrap}',
      '.dshDc_fileTool:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshDc_fileTool[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-label-primary)}',
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

    /**
     * Required services (cordis fiber inject): the slot registry and its workspace actions.
     *
     * Note what is deliberately NOT here: `sidebarRightTabs`. The container-file tab is an
     * addition, so it reads that registry through `ctx.get` and stands down when it is absent.
     * Declaring it would make this whole bundle wait for it, and a deployment without the right
     * sidebar would then lose the directory picker and the port panel as well — three features
     * traded for one.
     */
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

    /** A byte count a reader can act on, rather than a number they have to divide. */
    function sizeLabel(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value < 0) return ''
      if (value < 1024) return value + ' B'
      if (value < 1024 * 1024) return Math.round(value / 1024) + ' KB'
      return (value / (1024 * 1024)).toFixed(1) + ' MB'
    }

    /**
     * The body implementation the shipped previewer would pick for this path.
     *
     * `sidebar.right.tab.document` dispatches by implementation id, and the choice is the
     * previewer's own: an extension-matched implementation in the external band wins, the
     * builtin plain-text one is the fallback. Reproduced from the shipped ranking rather than
     * hardcoded, so a deployment that registers a better viewer for an extension gets it here
     * too — and this file never names a package's private id.
     *
     * @param registry - the `documentPreviews` service, or undefined where it is not mounted.
     * @param path - the container path being opened.
     * @returns the implementation id, or undefined when nothing can render it.
     */
    function bodyImplementationFor(registry, path) {
      if (registry === undefined || typeof registry.getSnapshot !== 'function') return undefined
      const definitions = registry.getSnapshot()
      if (!Array.isArray(definitions)) return undefined
      const name = text(path).toLowerCase()
      const base = name.slice(name.lastIndexOf('/') + 1)
      const ranked = definitions
        .map((definition, order) => ({
          definition,
          order,
          rank: definition.priority === 'builtin' ? 0 : 1,
          length: Math.max(0, ...(definition.extensions ?? [])
            .map((extension) => extension.toLowerCase().replace(/^\./u, ''))
            .filter((extension) => base.endsWith('.' + extension))
            .map((extension) => extension.length)),
        }))
        // An implementation with no matching extension does not qualify at all — which is why a
        // catch-all, whose `extensions` is empty, can only ever arrive as the fallback below.
        .filter((candidate) => candidate.length > 0)
        .sort((left, right) => right.rank - left.rank || right.length - left.length || left.order - right.order)
      // The fallback has to render ANY path, so it is the builtin that declares no extensions —
      // the catch-all — and not merely the first builtin-registered one, which may well claim an
      // extension of its own. Same choice the shipped previewer makes by naming its plain-text
      // id, reached here without naming another package's private id.
      const catchAll = definitions.find(
        (definition) => definition.priority === 'builtin' && (definition.extensions ?? []).length === 0,
      )
      const chosen = ranked[0]?.definition
        ?? catchAll
        ?? definitions.find((definition) => definition.priority === 'builtin')
      return chosen === undefined ? undefined : chosen.id
    }

    /** The `DocumentContent` the shipped body renders: one page holding the whole read. */
    function textContentOf(value) {
      const body = text(value)
      return {
        kind: 'text',
        text: body,
        pages: [{ offset: 0, text: body, lines: body === '' ? 0 : body.split('\n').length }],
        eof: true,
      }
    }

    /**
     * The tab body for one container file: its text, or the reason it is not showing.
     *
     * It reads through this plugin's OWN route rather than `workspaceFiles`. That Remote
     * service resolves a path against the composed `ctx.fs`, which for a routed session is the
     * LOCAL stand-in — an empty directory. The container path a tool call named is not there
     * and never will be: the file lives on the other side of the channel. Serving it here is
     * what makes the "Files changed" row's chips open at all, since that row records exactly
     * the `file_path` the model passed to `write`/`edit`.
     *
     * Only the FETCH is ours. The drawing is delegated to the shipped document body through
     * the public `sidebar.right.tab.document` slot, whose `DocumentContent` owner prop is
     * part of that slot's documented contract — so line numbers, the per-line DOM, the
     * addressed-line highlight and the `data-textpreview-*` hooks are the original
     * implementation's, not a lookalike. Wrapping is a `white-space` inherited from this
     * component's own scrollport (the shipped page element sets `white-space: inherit`
     * precisely so a host can own it), which is why the toggle can live here.
     */
    function ContainerFileBody(props) {
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined
      const address = info === undefined || info.tab === undefined ? undefined : info.tab.contentId
      const path = containerPathOfAddress(address)
      const [state, setState] = React.useState({ phase: 'loading' })
      const [attempt, setAttempt] = React.useState(0)
      // The shipped previewer opens wrapped; matching that is the whole point of the default.
      const [wrap, setWrap] = React.useState(true)
      const scrollport = React.useRef(null)

      React.useEffect(() => {
        if (path === undefined) {
          setState({ phase: 'error', message: '这个标签页没有指向一个容器路径。' })
          return undefined
        }
        const abort = new AbortController()
        setState({ phase: 'loading' })
        fetch(API + '/file?path=' + encodeURIComponent(path), {
          signal: abort.signal,
          headers: { accept: 'application/json' },
        })
          .then(async (response) => {
            const payload = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(text(payload.error) || 'HTTP ' + response.status)
            return payload
          })
          .then((payload) => {
            if (!abort.signal.aborted) setState({ phase: 'ready', payload })
          })
          .catch((problem) => {
            // An aborted read means this component is unmounting or reloading, which is not a
            // failure the reader should ever be shown.
            if (abort.signal.aborted) return
            setState({ phase: 'error', message: reason(problem) })
          })
        return () => abort.abort()
      }, [path, attempt])

      const payload = state.phase === 'ready' ? state.payload : undefined
      const content = React.useMemo(
        () => (payload === undefined ? undefined : textContentOf(payload.text)),
        [payload],
      )
      const bodyId = bodyImplementationFor(props.documentPreviews, path)

      /** The header's own controls: this type's chrome, not a viewer's. */
      const tools = [
        h('button', {
          key: 'wrap',
          type: 'button',
          className: 'dshDc_fileTool',
          'aria-pressed': wrap,
          title: wrap ? '关闭自动折行' : '开启自动折行',
          onClick: () => setWrap((on) => !on),
        }, wrap ? '不折行' : '折行'),
        h('button', {
          key: 'reload',
          type: 'button',
          className: 'dshDc_fileTool',
          title: '重新读取',
          onClick: () => setAttempt((count) => count + 1),
        }, '刷新'),
      ]

      const bar = h('div', { key: 'bar', className: 'dshDc_fileBar' }, [
        h('span', { key: 'p', className: 'dshDc_filePath', title: text(path) }, text(payload === undefined ? path : payload.remotePath)),
        payload !== undefined && payload.truncated === true
          ? h('span', { key: 't', className: 'dshDc_fileNote' }, '已截断，原文件 ' + sizeLabel(payload.bytes))
          : null,
        ...tools,
      ])

      if (state.phase === 'loading') {
        return h('div', { className: 'dshDc_fileWrap' }, [
          bar,
          h('div', { key: 'm', className: 'dshDc_fileMsg' }, '读取中…'),
        ])
      }

      if (state.phase === 'error') {
        return h('div', { className: 'dshDc_fileWrap' }, [
          bar,
          h('div', { key: 'm', className: 'dshDc_fileMsg dshDc_fileErr' }, text(state.message)),
        ])
      }

      // The fallback is this plugin's own `<pre>`, and it is what renders in a deployment that
      // never mounted the shipped previewer: a plain file is still readable there, just without
      // the original's line numbers.
      const fallback = h('pre', { key: 'plain', className: 'dshDc_fileCode' }, text(payload.text))
      const body = payload.text === ''
        ? h('div', { key: 'm', className: 'dshDc_fileMsg' }, '这个文件是空的。')
        : typeof props.renderSlot !== 'function' || bodyId === undefined
          ? fallback
          : props.renderSlot(
            'sidebar.right.tab.document',
            { resourceAddress: address, content, wrap, scrollportRef: scrollport },
            {
              entryKey: bodyId,
              hookContext: props.useTabInfo,
              fallback,
            },
          )

      return h('div', { className: 'dshDc_fileWrap' }, [
        bar,
        h(
          'div',
          {
            key: 'scroll',
            ref: scrollport,
            className: wrap ? 'dshDc_fileScroll dshDc_fileWrapped' : 'dshDc_fileScroll',
            'data-textpreview-wrap': wrap ? '' : undefined,
          },
          body,
        ),
      ])
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
        if (response.status === 404) return false
        // Remember what this profile routes while the answer is already in hand. `canOpen`
        // runs inside the tab registry's synchronous address ranking, so it cannot fetch;
        // the host's own list of roots is the one authority both sides then share.
        const config = await response.json().catch(() => ({}))
        if (Array.isArray(config.knownRoots)) {
          containerRoots = config.knownRoots
            .map((entry) => (entry === null || typeof entry !== 'object' ? undefined : entry.path))
            .filter((path) => typeof path === 'string' && path !== '' && path !== '/')
        }
        return true
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

      // A file the agent changed lives in the CONTAINER, and every shipped surface that opens
      // one — the "Files changed" chips, the closing prose's inline mentions — routes through
      // the Sidebar, which reads the local `ctx.fs`. That filesystem is this plugin's empty
      // stand-in, so those paths resolve nowhere and the chips do nothing. Claiming the
      // address here is what gives them somewhere to land.
      //
      // The claim is narrow on purpose: `canOpen` vetoes everything that is not under a root
      // this profile routes, so an ordinary local file still opens in the shipped previewer
      // and a session whose cwd is local is untouched. The `extension` band outranks the text
      // previewer's `fallback`, so this wins without depending on pattern length.
      //
      // `ctx.inject` rather than a fiber `inject`, and rather than a bare `ctx.get`: this is an
      // ADDITION, so it must wait for the registry without making the whole bundle wait for it.
      // A fiber inject would cost the directory picker and the port panel wherever the right
      // sidebar is absent — three features traded for one — while a bare `get` would race the
      // registry's own registration and silently register nothing at all.
      ctx.inject(['slots', 'sidebarRightTabs'], (scope) => {
        scope.sidebarRightTabs.register({
          id: CONTAINER_FILE_TAB_ID,
          kind: CONTAINER_FILE_TAB_KIND,
          patterns: [FILE_ADDRESS_PREFIX + '**'],
          priority: 'extension',
          canOpen: (address) => {
            const path = containerPathOfAddress(address)
            return path !== undefined && underContainerRoot(path)
          },
          title: (address) => basenameOf(containerPathOfAddress(address)),
        })

        // The pane dispatches a tab body by the id of the type in force, so the key is the id
        // above and not the kind. No child body slot is declared: this type has exactly one
        // viewer, so there is nothing for an implementation registry to choose between.
        //
        // `documentPreviews` rides in as a prop rather than being read here, because the body
        // needs it at render time to pick the implementation the shipped previewer would pick.
        scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
          name: 'sidebar.right.pane.tab',
          key: CONTAINER_FILE_TAB_ID,
          inject: () => ({ documentPreviews: scope.get('documentPreviews') }),
        }, ContainerFileBody))
      })

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

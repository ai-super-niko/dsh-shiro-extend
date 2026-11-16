window.__ModuleLoader__.load({
  id: "dsh-shiro-extend",
  factory(require) {
    const React = require("react")
    const h = React.createElement

    // =======================================================================
    // Diagnostics.
    //
    // The renderer console only reaches disk when the application crashes, so a
    // silent failure here (a rejected mount, a seat that never declares) leaves
    // no trace at all: the pill is simply absent. These lines are appended to
    // `localStorage`, which the app profile keeps in its LevelDB on disk, and
    // mirrored to the console for DevTools. Bounded to the last 40 events.
    // =======================================================================
    const DIAG_KEY = "dsh-shiro-extend:diagnostics"

    /** Record one diagnostic event. Never throws. */
    function diag(event, detail) {
      try {
        const raw = window.localStorage.getItem(DIAG_KEY)
        const previous = raw === null ? [] : JSON.parse(raw)
        const events = Array.isArray(previous) ? previous : []
        events.push({ at: new Date().toISOString(), event, detail: detail === undefined ? null : String(detail) })
        window.localStorage.setItem(DIAG_KEY, JSON.stringify(events.slice(-40)))
      } catch {
        // Diagnostics must never break the pill.
      }
      try {
        console.info("[dsh-shiro-extend]", event, detail === undefined ? "" : detail)
      } catch {
        // Console access can be unavailable in a sandboxed frame.
      }
    }

    /** Describe this plugin's row in the injected boot graph, for one diag line. */
    function bootRow() {
      try {
        const graph = window.__DSH_BOOT__
        const entries = Array.isArray(graph?.entries) ? graph.entries : undefined
        if (entries === undefined) return "no-boot-graph"
        const row = entries.find((entry) => typeof entry?.id === "string" && entry.id.includes("shiro"))
        if (row === undefined) return `no-row-of-${String(entries.length)}`
        return `row:${row.id} inject:${(row.inject ?? []).join("+")}`
      } catch (error) {
        return `boot-read-failed:${String(error && error.message !== undefined ? error.message : error)}`
      }
    }

    diag("bundle", bootRow())

    // =======================================================================
    // Styles — theme tokens only, `dse-` prefixed so future extensions in this
    // package stay namespaced. The pill deliberately matches the shipped
    // StatsPills entries in `conversation.composer.dock` (transparent, no
    // border, 999px radius, tertiary label) so a session's status row reads as
    // one row of peers rather than a wider bespoke control.
    // =======================================================================
    const STYLE_ID = "dsh-shiro-extend/styles"
    if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) === null) {
      const style = document.createElement("style")
      style.dataset.pluginCss = STYLE_ID
      style.textContent = [
        // --- pill -------------------------------------------------------
        ".dse-pill{box-sizing:border-box;corner-shape:round;max-width:100%;min-width:0;",
        "  color:var(--dsw-alias-label-tertiary);font:inherit;",
        "  font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);",
        "  line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));",
        "  white-space:nowrap;background:0 0;border:none;border-radius:999px;",
        "  align-items:center;gap:6px;padding:1px 8px;display:inline-flex}",
        ".dse-pill svg{flex:none;width:14px;height:14px}",
        "button.dse-pill{cursor:pointer}",
        "button.dse-pill:hover,button.dse-pill[aria-expanded=true]{",
        "  background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
        ".dse-pill-label{min-width:0;max-width:220px;overflow:hidden;text-overflow:ellipsis;",
        "  font-family:var(--dsw-font-mono,monospace)}",
        ".dse-pill-detached{font-style:italic}",
        // --- anchored menu ----------------------------------------------
        // `position: fixed` on purpose. The composer lives inside
        // `.…_composerSeat` (position: absolute) under a view area that sets
        // `overflow: hidden`, so an absolutely positioned menu is clipped to the
        // composer's own box no matter how large its z-index is. A fixed layer
        // is positioned against the viewport instead, and no ancestor in that
        // chain creates a containing block for it (no transform/filter/contain),
        // so it escapes the clip. Coordinates and the flip direction are set
        // inline from the pill's rect on open and on resize/scroll.
        ".dse-menu-root{position:relative;display:inline-flex;min-width:0}",
        ".dse-menu{position:fixed;z-index:2147483000;box-sizing:border-box;",
        "  background:var(--dsw-specific-menu);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);",
        "  width:300px;max-width:calc(100vw - 16px);",
        "  box-shadow:var(--dsw-elevation-prominent);border:0;border-radius:12px;",
        "  padding:6px;display:flex;flex-direction:column;gap:2px;",
        "  color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}",
        ".dse-menu-header{display:flex;align-items:center;gap:6px;padding:4px 6px 6px;",
        "  color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
        ".dse-menu-search{box-sizing:border-box;width:100%;height:30px;margin:0 0 4px;",
        "  border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-base);",
        "  color:var(--dsw-alias-label-primary);border-radius:8px;outline:none;padding:0 8px;",
        "  font:inherit;font-size:13px}",
        ".dse-menu-search:focus{border-color:var(--dsw-alias-state-business-primary)}",
        ".dse-menu-list{margin:0;padding:0;list-style:none;overflow-y:auto;",
        "  max-height:var(--dse-menu-list-max,260px);",
        "  display:flex;flex-direction:column;gap:1px}",
        ".dse-menu-empty{padding:10px 8px;color:var(--dsw-alias-label-tertiary);font-size:12px}",
        ".dse-row{box-sizing:border-box;width:100%;min-height:30px;text-align:left;",
        "  color:var(--dsw-alias-label-primary);background:0 0;border:none;border-radius:8px;",
        "  cursor:pointer;align-items:center;gap:8px;padding:4px 8px;font:inherit;",
        "  font-size:13px;line-height:20px;display:flex}",
        ".dse-row:hover:not(:disabled),.dse-row:focus-visible:not(:disabled){",
        "  background:var(--dsw-alias-interactive-bg-hover)}",
        ".dse-row:disabled{opacity:.5;cursor:default}",
        ".dse-row-mark{flex:none;width:14px;height:14px;display:inline-flex;",
        "  align-items:center;justify-content:center;color:var(--dsw-alias-state-business-primary)}",
        ".dse-row-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
        "  font-family:var(--dsw-font-mono,monospace);font-size:12px}",
        ".dse-row-subject{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;",
        "  white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px;text-align:right}",
        ".dse-row-create{color:var(--dsw-alias-state-business-primary)}",
        ".dse-error{padding:6px 8px;color:var(--dsw-alias-state-error-primary);font-size:12px;",
        "  line-height:18px;word-break:break-word}",
        ".dse-notice{padding:6px 8px;color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary));",
        "  font-size:12px;line-height:18px;word-break:break-word}",
        ".dse-session-delete-item{box-sizing:border-box;width:100%;min-height:30px;text-align:left;",
        "  color:var(--dsw-alias-state-error-primary);background:0 0;border:none;border-radius:8px;",
        "  cursor:pointer;align-items:center;gap:8px;padding:4px 8px;font:inherit;font-size:13px;",
        "  line-height:20px;display:flex}",
        ".dse-session-delete-item:hover,.dse-session-delete-item:focus-visible{",
        "  background:var(--dsw-alias-interactive-bg-hover)}",
        ".dse-session-delete-item:disabled{opacity:.5;cursor:default}",
        ".dse-session-delete-item svg{flex:none;width:14px;height:14px}",
        // The New-Session row renders its options container with
        // `margin-left: auto`, which pins everything inside it to the far right
        // of the row. This pill belongs beside the mode chip instead, so that
        // container gives up the auto margin.
        //
        // The shipped slot renderer wraps every entry in an addressable anchor,
        // so the real chain is `heroOptions > div[data-slot=…hero.options] >
        // button.dse-pill`. Selecting the box by the slot key it contains keeps
        // this independent of the shipped, hashed class name, and cannot reach
        // the composer dock — whose anchor carries a different slot key and whose
        // wrapper's own margin must stay.
        //
        // `!important` is deliberate: otherwise this ties on specificity with the
        // shipped `margin-left: auto`, leaving the result to depend on which
        // plugin's stylesheet the browser injected last.
        "*:has(> [data-slot=\"conversation.hero.options\"]){margin-left:0 !important}",
        // Native actions reserve 60px for two 28px buttons and a 4px gap.
        // Leave room for the third button, preserving the search collapse state.
        "[data-slot=\"sidebar.workspaces\"] [class*=\"headerActions\"]:has(.dse-workspace-view-toggle):not([class*=\"headerActionsHidden\"]){max-width:92px}",
        ".dse-workspace-view-toggle[aria-pressed=true]{color:var(--dsw-alias-label-primary);",
        "  background:var(--dsw-alias-interactive-bg-hover)}",
        "@media (prefers-reduced-motion:reduce){.dse-pill,.dse-row{transition:none}}",
      ].join("\n")
      document.head.appendChild(style)
    }

    // =======================================================================
    // Text
    // =======================================================================
    const NS = "shiro-extend"
    const zh = {
      "branch.aria": "Git 分支：{name}",
      "branch.detached": "游离 {sha}",
      "branch.unborn": "无提交",
      "menu.title": "切换分支",
      "menu.search": "搜索分支",
      "menu.empty": "没有匹配的分支",
      "menu.current": "当前分支",
      "menu.create": "新建分支「{name}」",
      "menu.loading": "正在读取分支…",
      "menu.noRepo": "当前工作区不是 Git 仓库",
      "menu.working": "正在处理…",
      "error.not-a-repo": "当前工作区不是 Git 仓库",
      "error.branch-exists": "同名分支已存在",
      "error.branch-missing": "分支不存在",
      "error.dirty-worktree": "工作区有未提交的改动，无法切换分支",
      "error.switch-refused": "Git 拒绝切换该分支",
      "error.already-checked-out": "该分支已在另一个工作树中检出",
      "error.timeout": "Git 命令超时",
      "error.no-git": "未找到 git 命令",
      "error.empty-name": "分支名不能为空",
      "error.no-path": "没有可用的工作区路径",
      "error.git-failed": "Git 操作失败",
      "menu.deleteSession": "永久删除会话",
      "delete.confirm": "确定永久删除“{name}”吗？该操作不可恢复。",
      "delete.pending": "正在永久删除…",
      "delete.queuedButton": "已加入删除队列",
      "delete.queued": "会话卸载后将自动永久删除；队列会在重启后保留。",
      "error.invalid-session": "无效的会话 ID",
      "error.session-running": "会话正在运行，停止后才能删除",
      "error.session-live": "会话仍在内存中，删除请求未排队",
      "error.subagent": "子会话不能从此处删除",
      "error.busy": "会话正被其他进程使用",
      "error.unsupported": "当前 DSH 版本不支持此存储布局",
      "error.not-found": "会话已不存在",
      "error.workspace-failed": "工作区状态更新失败，未删除会话",
      "error.delete-failed": "永久删除失败",
      "view.flat": "切换为单列表",
      "view.restore.workspace": "恢复按工作区",
      "view.restore.workspace-tree": "恢复按工作区树",
    }
    const en = {
      "branch.aria": "Git branch: {name}",
      "branch.detached": "detached {sha}",
      "branch.unborn": "no commits",
      "menu.title": "Switch branch",
      "menu.search": "Search branches",
      "menu.empty": "No matching branch",
      "menu.current": "Current branch",
      "menu.create": "Create branch “{name}”",
      "menu.loading": "Loading branches…",
      "menu.noRepo": "This workspace is not a git repository",
      "menu.working": "Working…",
      "error.not-a-repo": "This workspace is not a git repository",
      "error.branch-exists": "A branch with that name already exists",
      "error.branch-missing": "That branch does not exist",
      "error.dirty-worktree": "Uncommitted changes block switching branches",
      "error.switch-refused": "Git refused to switch to that branch",
      "error.already-checked-out": "That branch is already checked out in another worktree",
      "error.timeout": "The git command timed out",
      "error.no-git": "The git command was not found",
      "error.empty-name": "A branch name is required",
      "error.no-path": "No workspace path is available",
      "error.git-failed": "The git operation failed",
      "menu.deleteSession": "Permanently delete session",
      "delete.confirm": "Permanently delete “{name}”? This cannot be undone.",
      "delete.pending": "Permanently deleting…",
      "delete.queuedButton": "Deletion queued",
      "delete.queued": "The session will be permanently deleted after it unloads; the queue survives restarts.",
      "error.invalid-session": "The session ID is invalid",
      "error.session-running": "The session is running; stop it before deleting",
      "error.session-live": "The session is still live in memory; deletion was not queued",
      "error.subagent": "Subagent sessions cannot be deleted here",
      "error.busy": "The session is being used by another process",
      "error.unsupported": "This DSH storage layout is not supported",
      "error.not-found": "The session no longer exists",
      "error.workspace-failed": "Workspace state could not be updated; the session was not deleted",
      "error.delete-failed": "Permanent deletion failed",
      "view.flat": "Switch to single list",
      "view.restore.workspace": "Restore workspace groups",
      "view.restore.workspace-tree": "Restore workspace tree",
    }

    // =======================================================================
    // Icons (hand-written; this plugin imports no Harness Client package)
    // =======================================================================
    function BranchIcon() {
      return h("svg", { viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
        h("path", {
          d: "M4 2.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm0 8a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm8-8a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM4 5.5v5M8 2.75a5.5 5.5 0 0 1 0 10.5",
          stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round",
        }))
    }
    function CheckIcon() {
      return h("svg", { viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
        h("path", {
          d: "M3.5 8.5 6.5 11.5 12.5 5",
          stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round",
        }))
    }
    function TrashIcon() {
      return h("svg", { viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
        h("path", {
          d: "M3.5 4.5h9M6 4.5V2.75h4V4.5M5 6.5v5.75h6V6.5M7 8v2.5M9 8v2.5",
          stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round", strokeLinejoin: "round",
        }))
    }

    // =======================================================================
    // Git access through the plugin's own Remote namespace.
    //
    // A Client reaches Host code only through a mounted Remote contribution:
    // the `remote.shiroGit` service exists only after `ctx.remote.$mount()`,
    // and the Gateway client refuses a contribution whose parameter codecs are
    // not strict. The Host half (`index.js`) registers the same five methods
    // under the same namespace — keep both lists in sync.
    // =======================================================================
    /** Wire methods and their parameter order, matching the Host descriptors. */
    const WIRE_METHODS = [
      { method: "status", parameters: ["path"] },
      { method: "branches", parameters: ["path"] },
      { method: "checkout", parameters: ["path", "name"] },
      { method: "create", parameters: ["path", "name", "from"] },
      { method: "deleteSession", parameters: ["sessionId"] },
    ]

    /**
     * Build one strict JSON codec.
     *
     * A plain-JS plugin has no generated schema factory, so this carries a
     * passthrough `create()`: only the Host decodes wire fields, and the Client
     * merely has to satisfy the strict-shape contract the Gateway validates.
     *
     * @param {string} symbol - unique type symbol for diagnostics.
     * @returns {object} a strict codec carrying a passthrough schema factory.
     */
    function jsonCodec(symbol) {
      return {
        mode: "strict",
        typeSymbol: `dsh-shiro-extend#${symbol}`,
        create: () => ({ parse: (value) => value }),
      }
    }

    /**
     * The contribution that installs `remote.shiroGit`.
     *
     * @returns {{ package: string, descriptors: object[] }} mountable form.
     */
    function contribution() {
      return {
        package: "dsh-shiro-extend",
        descriptors: WIRE_METHODS.map((spec) => ({
          id: `dsh-shiro-extend:shiroGit#${spec.method}`,
          service: "shiroGit",
          namespace: "shiroGit",
          method: spec.method,
          invocation: { kind: "direct" },
          parameters: spec.parameters.map((name) => ({
            name,
            wire: name,
            source: "json",
            acceptsUndefined: true,
            codec: jsonCodec(`${spec.method}:${name}`),
          })),
          result: { mode: "src-json" },
        })),
      }
    }

    /**
     * Call one method on the host `shiroGit` namespace.
     *
     * Remote calls resolve to a `RemoteResult`; a rejected carrier call would
     * be an assembly fault, so both are folded into one failure shape here.
     *
     * @param {object} remote - the client `ctx.remote` face.
     * @param {string} method - service method name.
     * @param {unknown[]} args - JSON arguments.
     * @returns {Promise<{ ok: boolean, value?: any, reason?: string, message?: string }>}
     */
    async function callGit(remote, method, args) {
      try {
        const namespace = remote === undefined || remote === null ? undefined : remote.shiroGit
        if (namespace === undefined || typeof namespace[method] !== "function") {
          return { ok: false, reason: "git-failed", message: "shiroGit remote namespace is unavailable" }
        }
        const result = await namespace[method](...args)
        if (result !== null && typeof result === "object" && "ok" in result) return result
        if (result !== null && typeof result === "object" && "value" in result) {
          return result.ok === false ? { ok: false, ...(result.error ?? {}) } : { ok: true, value: result.value }
        }
        return { ok: true, value: result }
      } catch (error) {
        return { ok: false, reason: "git-failed", message: error instanceof Error ? error.message : String(error) }
      }
    }

    const DELETE_ERROR_REASONS = new Set([
      "invalid-session",
      "session-running",
      "session-live",
      "subagent",
      "busy",
      "unsupported",
      "not-found",
      "workspace-failed",
      "delete-failed",
    ])

    function deleteErrorText(result, t) {
      const reason = typeof result?.reason === "string" ? result.reason : "delete-failed"
      return t(DELETE_ERROR_REASONS.has(reason) ? `error.${reason}` : "error.delete-failed")
    }

    // =======================================================================
    // Branch state hook: resolves the workspace path, then reads branch state.
    // =======================================================================
    const POLL_MS = 30000

    /**
     * Track the branch of one workspace path, refreshing on a slow interval so
     * an external `git checkout` is eventually reflected.
     *
     * @param {object} args - { remote, path }.
     * @returns {{ status: object|null, refresh: () => void }} status is null
     *   while unknown or when the path is not a repository (render nothing).
     */
    function useBranchStatus(remote, path) {
      const [status, setStatus] = React.useState(null)
      const [nonce, setNonce] = React.useState(0)

      React.useEffect(() => {
        if (path === undefined || path === null || path === "") {
          setStatus(null)
          return undefined
        }
        let cancelled = false

        const read = async () => {
          const result = await callGit(remote, "status", [path])
          if (cancelled) return
          if (result.ok !== true) {
            setStatus(null)
            return
          }
          const value = result.value
          setStatus(value !== null && typeof value === "object" && value.present === true ? value : null)
        }

        void read()
        const timer = setInterval(() => { void read() }, POLL_MS)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [remote, path, nonce])

      const refresh = React.useCallback(() => { setNonce((n) => n + 1) }, [])
      return { status, refresh }
    }

    /** Human label for one status value. */
    function branchLabel(status, t) {
      if (status === null) return ""
      if (status.detached === true) return t("branch.detached", { sha: status.sha ?? "" })
      if (status.unborn === true) return t("branch.unborn")
      return status.branch ?? ""
    }

    // =======================================================================
    // Anchored branch menu: search, switch, and create.
    // =======================================================================
    const MENU_WIDTH = 300

    /** Smallest useful menu height before flipping to the other side. */
    const MENU_MIN_HEIGHT = 180

    /** Largest list box, before the viewport gets the final say. */
    const MENU_MAX_LIST = 260

    /** Gap between the pill and the menu. */
    const MENU_GAP = 8

    /**
     * Place a fixed-position popover against its anchor.
     *
     * Opens upward — the composer sits at the bottom of the window — unless the
     * space above cannot hold a useful menu and the space below is larger. The
     * returned coordinates are viewport-relative because the menu is
     * `position: fixed`, which is what lifts it out of the composer's clipped
     * view area. The list box shrinks to whatever room the chosen side has.
     *
     * @param {HTMLElement} anchor - the pill that owns the menu.
     * @param {HTMLElement} menu - the popover, measured after mount.
     * @returns {{ left: number, top?: number, bottom?: number, side: string, listMax: number }}
     */
    function placeMenu(anchor, menu) {
      const rect = anchor.getBoundingClientRect()
      const width = menu.offsetWidth === 0 ? MENU_WIDTH : menu.offsetWidth
      const height = menu.offsetHeight === 0 ? MENU_MIN_HEIGHT : menu.offsetHeight
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const spaceAbove = rect.top - MENU_GAP
      const spaceBelow = viewportHeight - rect.bottom - MENU_GAP
      const side = spaceAbove >= MENU_MIN_HEIGHT || spaceAbove >= spaceBelow ? "top" : "bottom"
      const room = side === "top" ? spaceAbove : spaceBelow

      // Keep the whole menu on screen: clamp horizontally, and cap its height to
      // the room on the chosen side so the list scrolls instead of overflowing.
      const left = Math.max(MENU_GAP, Math.min(rect.left, viewportWidth - width - MENU_GAP))
      const chrome = height - MENU_MAX_LIST
      const listMax = Math.max(80, Math.min(MENU_MAX_LIST, room - Math.max(chrome, 0)))

      return side === "top"
        ? { left, bottom: viewportHeight - rect.top + MENU_GAP, side, listMax }
        : { left, top: rect.bottom + MENU_GAP, side, listMax }
    }

    function BranchMenu({ remote, path, anchorRef, onClose, onChanged, t }) {
      const [query, setQuery] = React.useState("")
      const [branches, setBranches] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const rootRef = React.useRef(null)
      const inputRef = React.useRef(null)
      const [placement, setPlacement] = React.useState(null)

      // Load the branch roster once per open menu.
      React.useEffect(() => {
        let cancelled = false
        const load = async () => {
          const result = await callGit(remote, "branches", [path])
          if (cancelled) return
          if (result.ok !== true) {
            setError(t(`error.${result.reason ?? "git-failed"}`))
            setBranches([])
            return
          }
          const value = result.value
          setBranches(value !== null && typeof value === "object" && Array.isArray(value.branches) ? value.branches : [])
        }
        void load()
        return () => { cancelled = true }
      }, [remote, path, t])

      // Focus the search field, then measure the pill and place the menu. It is
      // re-measured when the roster arrives (the menu grows), and on resize or
      // any scroll, so it tracks the composer instead of drifting away from it.
      React.useLayoutEffect(() => {
        inputRef.current?.focus()
      }, [])

      React.useLayoutEffect(() => {
        const anchor = anchorRef?.current
        const menu = rootRef.current
        if (anchor === null || anchor === undefined || menu === null) return undefined
        const place = () => { setPlacement(placeMenu(anchor, menu)) }
        place()
        window.addEventListener("resize", place)
        window.addEventListener("scroll", place, true)
        return () => {
          window.removeEventListener("resize", place)
          window.removeEventListener("scroll", place, true)
        }
      }, [anchorRef, branches, query, error, busy])

      // Dismiss on an outside pointer press or Escape.
      React.useEffect(() => {
        const onPointerDown = (event) => {
          const node = rootRef.current
          if (node !== null && !node.contains(event.target)) onClose()
        }
        const onKeyDown = (event) => {
          if (event.key === "Escape") onClose()
        }
        document.addEventListener("pointerdown", onPointerDown, true)
        document.addEventListener("keydown", onKeyDown, true)
        return () => {
          document.removeEventListener("pointerdown", onPointerDown, true)
          document.removeEventListener("keydown", onKeyDown, true)
        }
      }, [onClose])

      const normalized = query.trim()
      const lowered = normalized.toLowerCase()
      const list = branches ?? []
      const filtered = lowered === ""
        ? list
        : list.filter((entry) => entry.name.toLowerCase().includes(lowered))
      const exact = list.some((entry) => entry.name === normalized)
      const canCreate = normalized !== "" && !exact

      /**
       * Run one mutation, surfacing the host's reason as localized text.
       *
       * @param {() => Promise<{ ok: boolean, reason?: string }>} action - the call.
       */
      const run = React.useCallback(async (action) => {
        if (busy) return
        setBusy(true)
        setError(null)
        const result = await action()
        setBusy(false)
        if (result.ok === true) {
          onChanged()
          onClose()
          return
        }
        setError(t(`error.${result.reason ?? "git-failed"}`))
      }, [busy, onChanged, onClose, t])

      const onSwitch = (name) => { void run(() => callGit(remote, "checkout", [path, name])) }
      const onCreate = () => { void run(() => callGit(remote, "create", [path, normalized, ""])) }

      // Enter switches to the typed exact branch, else creates it.
      const onKeyDownInput = (event) => {
        if (event.key !== "Enter") return
        event.preventDefault()
        if (exact) onSwitch(normalized)
        else if (canCreate) onCreate()
      }

      // `visibility: hidden` until the first measurement lands: the menu must be
      // in the DOM to be measured, but must not flash at the wrong place.
      const style = placement === null
        ? { visibility: "hidden" }
        : {
            left: `${String(placement.left)}px`,
            ...(placement.side === "top" ? { bottom: `${String(placement.bottom)}px` } : { top: `${String(placement.top)}px` }),
            "--dse-menu-list-max": `${String(placement.listMax)}px`,
          }

      return h("div", { className: "dse-menu-root", ref: rootRef },
        h("div", {
          className: "dse-menu",
          "data-side": placement === null ? "top" : placement.side,
          style,
          role: "menu",
          "aria-label": t("menu.title"),
        },
          error !== null ? h("div", { className: "dse-error", role: "alert" }, error) : null,
          h("div", { className: "dse-menu-header" }, t("menu.title")),
          h("input", {
            ref: inputRef,
            className: "dse-menu-search",
            type: "text",
            value: query,
            placeholder: t("menu.search"),
            "aria-label": t("menu.search"),
            disabled: busy,
            onChange: (event) => { setQuery(event.target.value) },
            onKeyDown: onKeyDownInput,
          }),
          branches === null
            ? h("div", { className: "dse-menu-empty" }, t("menu.loading"))
            : h("ul", { className: "dse-menu-list" },
                canCreate
                  ? h("li", null, h("button", {
                      type: "button",
                      className: "dse-row dse-row-create",
                      role: "menuitem",
                      disabled: busy,
                      onClick: onCreate,
                    }, h("span", { className: "dse-row-mark" }, "+"),
                       h("span", { className: "dse-row-name" }, t("menu.create", { name: normalized }))))
                  : null,
                filtered.length === 0 && !canCreate
                  ? h("li", { className: "dse-menu-empty" }, t("menu.empty"))
                  : filtered.map((entry) => h("li", { key: entry.name },
                      h("button", {
                        type: "button",
                        className: "dse-row",
                        role: "menuitem",
                        disabled: busy || entry.current,
                        title: entry.subject === "" ? entry.name : `${entry.name} — ${entry.subject}`,
                        onClick: () => { onSwitch(entry.name) },
                      },
                        h("span", { className: "dse-row-mark" }, entry.current ? h(CheckIcon) : null),
                        h("span", { className: "dse-row-name" }, entry.name),
                        entry.subject === "" ? null : h("span", { className: "dse-row-subject" }, entry.subject),
                      ))),
              ),
        ),
      )
    }

    // =======================================================================
    // The pill. Clicking opens the menu when an interactive remote is present.
    // =======================================================================
    /**
     * The slot kit supplies `t` from the entry's declared locale namespace. A
     * composition without that seat would hand over no translator at all, and a
     * throw inside the pill would retire this entry through the slot error
     * boundary — silently, since nothing else renders. Falling back to the raw
     * key keeps the pill alive and visible instead.
     *
     * @param {unknown} t - translator supplied by the slot.
     * @returns {(key: string, params?: object) => string} always callable.
     */
    function localizer(t) {
      return typeof t === "function" ? t : (key) => key
    }

    /** Paths already reported as rendering no pill, and labels already reported as shown. */
    const reportedNullPill = new Set()
    const reportedPill = new Set()

    function BranchPill({ remote, path, t: supplied }) {
      const t = localizer(supplied)
      const { status, refresh } = useBranchStatus(remote, path)
      const [open, setOpen] = React.useState(false)
      // The menu is anchored to the button's own rect, which is what the fixed
      // placement is computed from.
      const pillRef = React.useRef(null)

      // Close the menu when the workspace changes under it.
      React.useEffect(() => { setOpen(false) }, [path])

      if (status === null) {
        if (reportedNullPill.add(String(path))) diag("pill-hidden", `path:${String(path)} (no repository or no answer)`)
        return null
      }

      const label = branchLabel(status, t)
      if (label === "") return null

      if (reportedPill.add(label)) diag("pill-shown", `${label} @ ${String(path)}`)

      const interactive = path !== undefined && path !== null && path !== ""

      const body = [
        h("span", { key: "icon", "aria-hidden": true, style: { display: "inline-flex" } }, h(BranchIcon)),
        h("span", { key: "label", className: "dse-pill-label" }, label),
      ]

      if (!interactive) {
        return h("span", {
          className: "dse-pill",
          "data-shiro-extend": "git-branch",
          title: label,
        }, body)
      }

      return h(React.Fragment, null,
        h("button", {
          ref: pillRef,
          type: "button",
          className: "dse-pill",
          "data-shiro-extend": "git-branch",
          title: label,
          "aria-haspopup": "menu",
          "aria-expanded": open,
          "aria-label": t("branch.aria", { name: label }),
          onClick: () => { setOpen((value) => !value) },
        }, body),
        open
          ? h(BranchMenu, {
              remote,
              path,
              anchorRef: pillRef,
              t,
              onClose: () => { setOpen(false) },
              onChanged: refresh,
            })
          : null,
      )
    }

    // =======================================================================
    // Slot entries.
    //
    // One component, two additive seats, both `list` and both session-scoped:
    //
    //   conversation.composer.dock   below the composer card, beside the shipped
    //                                stats pills
    //   conversation.hero.options    the New-Session row. It is declared as a
    //                                right-aligned options box, and the pill
    //                                drops that auto margin (see the stylesheet)
    //                                so it sits directly beside the mode chip.
    //
    // `conversation.hero.workspace` (the picker itself) is a `single` seat owned
    // by shipped UI, so it is deliberately not used.
    // =======================================================================
    const HERO_OPTIONS_SEAT = "conversation.hero.options"
    const DOCK_SEAT = "conversation.composer.dock"
    const DOCK_ID = "shiro.git-branch"
    const HERO_ID = "shiro.git-branch.hero"

    /**
     * Resolve the workspace directory behind one session.
     *
     * A session that has not run a turn yet carries no `cwd`, but it is already
     * attached to a Workspace, so the bridge pill would otherwise vanish exactly
     * on the New-Session screen. Fall back to the Workspace that lists this
     * session.
     *
     * @param {{ byId?: object }|undefined} sessionsState - session list snapshot.
     * @param {{ items?: unknown[] }|undefined} workspacesState - workspace list snapshot.
     * @param {string} sessionId - the rendered session.
     * @returns {string|undefined} absolute workspace path, when one is known.
     */
    function resolveSessionPath(sessionsState, workspacesState, sessionId) {
      const cwd = sessionsState?.byId?.[sessionId]?.cwd
      if (typeof cwd === "string" && cwd !== "") return cwd
      const items = Array.isArray(workspacesState?.items) ? workspacesState.items : []
      // Client workspace items are `WorkspaceView`s: the identity is
      // `workspaceId` and the session roster is `sessionIds`.
      const owner = items.find((item) => Array.isArray(item?.sessionIds) && item.sessionIds.includes(sessionId))
      return typeof owner?.path === "string" && owner.path !== "" ? owner.path : undefined
    }

    /**
     * Hook form of {@link resolveSessionPath}.
     *
     * Both hooks are always called (Rules of Hooks), and both come from the
     * slot's standard kit.
     *
     * @param {(selector: (state: object) => unknown) => unknown} useSessions - standard kit hook.
     * @param {(selector: (state: object) => unknown) => unknown} useWorkspaces - standard kit hook.
     * @param {string} sessionId - the rendered session.
     * @returns {string|undefined} absolute workspace path, when one is known.
     */
    function useSessionWorkspace(useSessions, useWorkspaces, sessionId) {
      const path = useSessions((state) => resolveSessionPath(state, undefined, sessionId))
      const attached = useWorkspaces((state) => resolveSessionPath(undefined, state, sessionId))
      return path ?? attached
    }

    /**
     * DSH 0.2.1 has no header action slot. Add one DOM button only after the
     * native header mounts; never touch the loading DOM that DSH hydrates.
     * The workspace entry's store.create() returns its existing shared instance.
     */
    function installWorkspaceViewToggle(ctx) {
      const seat = "sidebar.workspaces"
      const previousKey = "dsh-shiro-extend:previous-group-by"
      const t = ctx.locale.bind(NS)
      const workspaceText = ctx.locale.bind("workspace")
      let previous = "workspace"
      try {
        if (window.localStorage.getItem(previousKey) === "workspace-tree") previous = "workspace-tree"
      } catch {}

      const button = document.createElement("button")
      button.type = "button"
      button.dataset.shiroExtend = "workspace-view-toggle"
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
      svg.setAttribute("viewBox", "0 0 16 16")
      svg.setAttribute("width", "16")
      svg.setAttribute("height", "16")
      svg.setAttribute("fill", "none")
      svg.setAttribute("aria-hidden", "true")
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
      path.setAttribute("d", "M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.5M2.5 8h.5M2.5 12h.5")
      path.setAttribute("stroke", "currentColor")
      path.setAttribute("stroke-width", "1.3")
      path.setAttribute("stroke-linecap", "round")
      svg.appendChild(path)
      button.appendChild(svg)

      let handle
      let view
      let unsubscribeView = () => {}
      let frame
      const update = () => {
        const groupBy = view?.getSnapshot().groupBy
        if (groupBy === "workspace" || groupBy === "workspace-tree") {
          if (previous !== groupBy) {
            previous = groupBy
            try { window.localStorage.setItem(previousKey, previous) } catch {}
          }
        }
        const flat = groupBy === "flat"
        const label = t(flat ? `view.restore.${previous}` : "view.flat")
        button.setAttribute("aria-pressed", String(flat))
        button.setAttribute("aria-label", label)
        button.title = label
      }
      button.addEventListener("click", () => {
        const groupBy = view.getSnapshot().groupBy
        view.actions.setGroupBy(groupBy === "flat" ? previous : "flat")
      })

      const reconcile = () => {
        frame = undefined
        const nextHandle = ctx.slots.entriesOfSlot(seat)[0]?.store
        if (handle !== nextHandle) {
          unsubscribeView()
          handle = nextHandle
          // Gate this compatibility bridge on the known native store contract.
          view = handle?.spec?.persist === "dsh.workspace.view.v5" ? handle.create() : undefined
          unsubscribeView = view === undefined ? () => {} : view.subscribe(update)
        }
        const anchor = document.querySelector('[data-slot="sidebar.workspaces"]')
        const native = Array.from(anchor?.querySelectorAll("button[aria-label]") ?? [])
          .find((element) => element.getAttribute("aria-label") === workspaceText("viewOptions.label"))
        if (view === undefined || native === undefined) {
          button.remove()
          return
        }
        button.className = `${native.className} dse-workspace-view-toggle`
        if (button.nextSibling !== native) native.parentElement.insertBefore(button, native)
        update()
      }
      const schedule = () => {
        if (frame === undefined) frame = window.requestAnimationFrame(reconcile)
      }
      const observer = new MutationObserver(schedule)
      observer.observe(document.body, { childList: true, subtree: true })
      const unsubscribeSlot = ctx.slots.subscribe(seat, schedule)
      const unsubscribeLocale = ctx.locale.subscribe(schedule)
      schedule()
      return () => {
        observer.disconnect()
        unsubscribeSlot()
        unsubscribeLocale()
        unsubscribeView()
        if (frame !== undefined) window.cancelAnimationFrame(frame)
        button.remove()
      }
    }

    return {
      // `remote.shiroGit` is deliberately absent: it does not exist until this
      // plugin mounts its own contribution, so injecting it here would leave the
      // entry pending forever — which fails the whole web boot with
      // "1 entry did not activate". It is declared afterwards, on the child
      // fiber created by `ctx.inject()` once the mount has installed it.
      //
      // `typert` is required even though this file never names it: mounting a
      // contribution makes the Gateway register those descriptors on the
      // *caller's* context (`callerCtx.typert.remotes.register`), and Cordis
      // refuses a service read the fiber never declared.
      inject: ["remote", "typert"],
      async apply(ctx) {
        diag("apply", `remote:${typeof ctx.remote} typert:${typeof ctx.typert}`)
        try {
          // Install `remote.shiroGit` first: everything below calls it.
          const disposeRemote = await ctx.remote.$mount(contribution())
          diag("mount-ok")

          // Register the UI on a child fiber that declares the namespace. A
          // service proxy forwards `remote.shiroGit` back into the owning
          // Context, so this declaration is what makes the namespace readable
          // at both registration time and render time.
          const ui = ctx.inject(["remote.shiroGit", "slots", "locale"], (inner) => {
            diag("ui-inject", `namespace:${typeof inner.remote.shiroGit}`)
            const remote = inner.remote
            inner.effect(() => inner.locale.register(NS, { zh, en }), "shiro-extend: dictionaries")

            inner.effect(() => installWorkspaceViewToggle(inner), "shiro-extend: workspace view toggle")

            // Session status row (the composer's bottom dock), beside the
            // shipped stats pills.
            inner.slots.inject(DOCK_SEAT, () => {
              diag("dock-inject", `seat:${String(inner.slots.spec(DOCK_SEAT)?.kind)}`)
              return inner.slots.register({
                name: DOCK_SEAT,
                id: DOCK_ID,
                order: 20,
                locale: NS,
              }, function ComposerBranchPill(props) {
                const path = useSessionWorkspace(props.useSessions, props.useWorkspaces, props.sessionId)
                diag("dock-render", `session:${String(props.sessionId)} path:${String(path)}`)
                return h(BranchPill, { remote, path, t: props.t })
              })
            })

            // Options at the right end of the New-Session row, beside the
            // workspace chip and the preset control. Additive list seat with no
            // shipped occupants, which is why it is the correct place for this:
            // `conversation.hero.workspace` is a single seat owned by the
            // shipped picker and rejects a second registration.
            inner.slots.inject(HERO_OPTIONS_SEAT, () => {
              diag("hero-inject", `seat:${String(inner.slots.spec(HERO_OPTIONS_SEAT)?.kind)}`)
              return inner.slots.register({
                name: HERO_OPTIONS_SEAT,
                id: HERO_ID,
                order: 20,
                locale: NS,
              }, function HeroBranchPill(props) {
                const path = useSessionWorkspace(props.useSessions, props.useWorkspaces, props.sessionId)
                diag("hero-render", `session:${String(props.sessionId)} path:${String(path)}`)
                return h(BranchPill, { remote, path, t: props.t })
              })
            })

            // Permanent deletion is deliberately a menu-only action. The Host
            // repeats every eligibility check because the menu snapshot can be stale.
            inner.slots.inject("sidebar.workspaces.session.menu.item", function* () {
              diag("session-delete-inject")
              yield inner.slots.register({
                name: "sidebar.workspaces.session.menu.item",
                id: "delete-session",
                order: 460,
                locale: NS,
              }, function SessionDeleteMenuItem({ sessionId, displayTitle, useMenuOpenState, t }) {
                const [deleting, setDeleting] = React.useState(false)
                const [error, setError] = React.useState(null)
                const [queued, setQueued] = React.useState(false)
                const menuState = typeof useMenuOpenState === "function" ? useMenuOpenState() : [false, () => {}]
                const setMenuOpen = menuState[1]

                const onSelect = async (event) => {
                  event.stopPropagation()
                  if (deleting) return
                  if (typeof window === "undefined" || typeof window.confirm !== "function") return
                  const name = displayTitle || sessionId
                  if (!window.confirm(t("delete.confirm", { name }))) return

                  setDeleting(true)
                  setError(null)
                  setQueued(false)
                  const result = await callGit(remote, "deleteSession", [sessionId])
                  if (result.ok !== true) {
                    setDeleting(false)
                    setError(deleteErrorText(result, t))
                    diag("session-delete-failed", `${sessionId}:${String(result.reason ?? "unknown")}`)
                    return
                  }

                  if (result.queued === true) {
                    setDeleting(false)
                    setQueued(true)
                    diag("session-delete-queued", sessionId)
                    return
                  }

                  if (Array.isArray(result.warnings) && result.warnings.length > 0) {
                    diag("session-delete-warning", `${sessionId}:${result.warnings.join(";")}`)
                  }
                  try {
                    const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : undefined
                    if (typeof sessions?.refresh === "function") await sessions.refresh()
                  } catch (refreshError) {
                    diag("session-delete-refresh-failed", refreshError instanceof Error ? refreshError.message : String(refreshError))
                  }
                  setMenuOpen(false)
                  setDeleting(false)
                }

                return h(React.Fragment, null,
                  h("button", {
                    type: "button",
                    className: "dse-session-delete-item",
                    disabled: deleting || queued,
                    "aria-label": t("menu.deleteSession"),
                    onClick: onSelect,
                  }, h(TrashIcon), h("span", null, deleting ? t("delete.pending") : queued ? t("delete.queuedButton") : t("menu.deleteSession"))),
                  error === null ? null : h("div", { className: "dse-error", role: "alert" }, error),
                  queued ? h("div", { className: "dse-notice", role: "status" }, t("delete.queued")) : null,
                )
              })
            })
          })

          try {
            await ui
          } catch (error) {
            await ui.dispose()
            await disposeRemote()
            throw error
          }

          return async () => {
            await ui.dispose()
            await disposeRemote()
          }
        } catch (error) {
          // Never fail the boot for this extension: the entry activates, the
          // pill stays hidden, and the reason is recorded.
          diag("activation-failed", `${String(error && error.message !== undefined ? error.message : error)}\n${String(error && error.stack !== undefined ? error.stack : "")}`)
          return undefined
        }
      },
      /**
       * Pure helpers exposed for the offline probe (`ui-probe.mjs`). They are
       * geometry and path arithmetic with no Cordis or DOM lifecycle, so they can
       * be exercised without a browser. Nothing in this file calls them through
       * this object.
       */
      __debug: { placeMenu, resolveSessionPath },
    }
  },
})

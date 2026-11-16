/**
 * dsh-shiro-extend — host half.
 *
 * Shiro's personal DSH extensions. This half owns the git operations used by
 * the session status row and blank-session (Hero) composer, plus the guarded
 * persistence operation used to permanently delete eligible sessions.
 *
 * Bridge design. A Client slot can only reach Host code through a Remote
 * namespace. The generated `./typert` artifact path is unavailable to a
 * plain-JS package (it needs @deepseek-ai/dsh-typert-generator), so this
 * plugin registers its invocation descriptors by hand — the explicit
 * `ctx.typert.register()` ownership that `dsh-typert-loader` documents for
 * plugins the Loader does not discover. Descriptors are derived from the
 * service methods, so adding a method means adding one entry to
 * DESCRIPTOR_SPECS.
 *
 * Registration is not enough on its own: the Host Gateway validates every
 * dispatch against the owning Service's `typertRemote` binding (the value
 * `TypertRemoteService` installs for generated packages), so {@link apply}
 * freezes that binding onto the service instance too.
 *
 * The wire contract below is duplicated in the Client half (`lib/client.js`),
 * which mounts the matching descriptors into `ctx.remote`. Changing a method
 * name, its parameter order, or its namespace means changing both halves.
 *
 * Git operations take an absolute workspace path; permanent session deletion
 * takes an exact durable session id and is exposed by the sidebar menu.
 */
import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"

/** The Cordis service key and the wire namespace both use this name. */
const SERVICE_KEY = "shiroGit"

/** Package identity stamped on the registered invocation descriptors. */
const PACKAGE_NAME = "dsh-shiro-extend"

/**
 * Diagnostic log written by this Host half.
 *
 * The renderer console is only captured into a crash report, so this file is
 * the one place that answers "did the Client half mount, and which workspace
 * is it reading?" after a restart. It records one line per activation, one per
 * distinct workspace path, and every failure, and rolls over at
 * {@link LOG_MAX_BYTES}.
 */
const LOG_DIR = join(homedir(), ".dsh", "logs")
const LOG_PATH = join(LOG_DIR, `${PACKAGE_NAME}.log`)
const LOG_MAX_BYTES = 256 * 1024

/** Pending confirmed deletions are stored beside the active session root. */
const PENDING_DELETE_DIR = join("plugins", PACKAGE_NAME, "pending-session-deletions")
const PENDING_DELETE_RETRY_MS = 30000

/** Paths already reported, so a 30-second poll does not become one line per tick. */
const reportedPaths = new Set()

/**
 * Append one diagnostic line, swallowing every filesystem failure.
 *
 * Diagnostics must never break what they observe, so this never rejects.
 *
 * @param {string} line - one human-readable event.
 * @returns {Promise<void>}
 */
async function note(line) {
  try {
    await mkdir(LOG_DIR, { recursive: true })
    const existing = await stat(LOG_PATH).catch(() => undefined)
    if (existing !== undefined && existing.size > LOG_MAX_BYTES) {
      await writeFile(LOG_PATH, "")
    }
    await appendFile(LOG_PATH, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // A read-only home or a concurrent rotation is not worth surfacing.
  }
}

/** How long one git invocation may run before it is killed. */
const GIT_TIMEOUT_MS = 10000

/** Cap on captured stdout/stderr so a pathological repo cannot balloon memory. */
const GIT_MAX_BUFFER = 4 * 1024 * 1024

/**
 * Run one git command in a workspace directory.
 *
 * Uses `execFile` with an argv array — never a shell — so a branch name or
 * path can never be interpreted as shell syntax.
 *
 * @param {string} cwd - absolute workspace directory.
 * @param {string[]} args - git arguments, already split.
 * @returns {Promise<{ ok: true, stdout: string, stderr: string } | { ok: false, message: string, code: string }>}
 */
function runGit(cwd, args) {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ ok: true, stdout, stderr })
          return
        }
        const text = `${stderr || ""}${error.message || ""}`.trim()
        if (error.killed === true) {
          resolve({ ok: false, code: "timeout", message: `git ${args.join(" ")} timed out` })
          return
        }
        if (error.code === "ENOENT") {
          resolve({ ok: false, code: "no-git", message: "git is not installed or not on PATH" })
          return
        }
        resolve({ ok: false, code: "git-failed", message: text === "" ? `git ${args.join(" ")} failed` : text })
      },
    )
  })
}

/** Normalize a path for comparison and for passing to git. */
function normalizePath(value) {
  return typeof value === "string" ? value.trim() : ""
}

/** Return a stable reason for a private persistence operation failure. */
function classifySessionDeleteError(error) {
  const name = typeof error?.name === "string" ? error.name : ""
  const code = typeof error?.code === "string" ? error.code : ""
  if (name === "SessionAlreadyOwnedError" || code === "EAGAIN" || code === "EWOULDBLOCK" || code === "EBUSY") return "busy"
  if (name.includes("Unsupported") || name.includes("Corruption") || code === "ENOTDIR") return "unsupported"
  if (name === "SessionPersistenceNotFoundError" || code === "ENOENT") return "not-found"
  return "delete-failed"
}

/** Extract a diagnostic string without exposing an arbitrary thrown value. */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Resolve the session directory and prove it remains below the persistence root. */
function sessionDirectory(persistence, header) {
  if (typeof persistence.root !== "string" || typeof persistence.locate !== "function") return { ok: false, reason: "unsupported" }
  let located
  try {
    located = persistence.locate(header)
  } catch {
    return { ok: false, reason: "unsupported" }
  }
  if (located?.kind !== "jsonl" || typeof located.path !== "string") return { ok: false, reason: "unsupported" }
  const root = resolve(persistence.root)
  const directory = resolve(dirname(located.path))
  const within = relative(root, directory)
  if (within === "" || within.startsWith("..") || isAbsolute(within)) return { ok: false, reason: "unsupported" }
  return { ok: true, path: directory }
}

/** Capture the immutable identity fields needed to reject a stale queued delete. */
function sessionIdentity(header) {
  return {
    version: header.version,
    id: header.id,
    createdAt: header.createdAt,
    cwd: header.cwd ?? null,
    parentSession: header.parentSession ?? null,
    isSeeded: header.isSeeded,
    origin: header.origin ?? null,
    delegationDepth: header.delegationDepth ?? null,
    agentPreset: header.agentPreset ?? null,
  }
}

/** Compare one queued identity with a current persisted or live header. */
function sameSessionIdentity(left, right) {
  if (left === null || typeof left !== "object" || right === null || typeof right !== "object") return false
  return JSON.stringify(sessionIdentity(left)) === JSON.stringify(sessionIdentity(right))
}

/** Validate one persisted pending-delete record before trusting its session id. */
function validPendingDelete(value) {
  const header = value?.header
  return value !== null
    && typeof value === "object"
    && typeof value.sessionId === "string"
    && value.sessionId !== ""
    && header !== null
    && typeof header === "object"
    && header.id === value.sessionId
    && Number.isSafeInteger(header.createdAt)
    && typeof header.version === "number"
    && typeof header.isSeeded === "boolean"
    && (header.cwd === null || typeof header.cwd === "string")
    && (header.parentSession === null || typeof header.parentSession === "string")
    && (header.origin === null || header.origin === "subagent")
    && (header.delegationDepth === null || Number.isSafeInteger(header.delegationDepth))
    && (header.agentPreset === null || typeof header.agentPreset === "string")
}

/**
 * Translate git's stderr into a stable reason code plus its original text, so
 * the UI can show a translated sentence while the raw message stays available.
 *
 * @param {string} message - raw git stderr.
 * @returns {{ code: string, message: string }}
 */
function classify(message) {
  const text = message.toLowerCase()
  if (text.includes("not a git repository")) return { code: "not-a-repo", message }
  if (text.includes("already exists")) return { code: "branch-exists", message }
  if (text.includes("did not match any file") || text.includes("pathspec") || text.includes("unknown revision")) {
    return { code: "branch-missing", message }
  }
  if (text.includes("your local changes") || text.includes("would be overwritten") || text.includes("please commit") || text.includes("please, commit")) {
    return { code: "dirty-worktree", message }
  }
  if (text.includes("already checked out") || text.includes("is already used by worktree")) {
    return { code: "already-checked-out", message }
  }
  if (text.includes("not fully merged") || text.includes("cannot switch")) return { code: "switch-refused", message }
  return { code: "git-failed", message }
}

/**
 * Record the first read of one workspace path, and its resolved outcome.
 *
 * The Client polls every 30 seconds, so only the first sighting of a path is
 * written; a changed outcome (a repository created, a branch switched by other
 * tooling) is reported again because the reason string differs.
 *
 * @param {string} path - absolute workspace path, or "" when none was supplied.
 * @param {string} outcome - `present:<branch>` or the failure reason code.
 */
function reportOnce(path, outcome) {
  const key = `${path}\u0000${outcome}`
  if (reportedPaths.has(key)) return
  reportedPaths.add(key)
  void note(`status ${JSON.stringify(path)} -> ${outcome}`)
}

/**
 * The git capability. One instance per plugin activation; every method is
 * addressed by an absolute workspace path and never by a session id.
 */
class ShiroGit {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - owning context.
   */
  constructor(ctx) {
    this.ctx = ctx
    this.name = SERVICE_KEY
    this.deleteOperations = Promise.resolve()
    this.pendingRetryTimer = undefined
    this.pendingDeleteRun = undefined
  }

  /** Serialize delete and queue mutations so concurrent menu calls cannot lose intents. */
  serializeDelete(operation) {
    const result = this.deleteOperations.then(operation, operation)
    this.deleteOperations = result.then(() => undefined, () => undefined)
    return result
  }

  /** Resolve this plugin's durable pending-delete queue path. */
  pendingDeletePath(persistence) {
    if (typeof persistence?.root !== "string" || persistence.root === "") return undefined
    return join(dirname(resolve(persistence.root)), PENDING_DELETE_DIR)
  }

  /** Return the collision-resistant marker path for one exact session id. */
  pendingDeleteMarker(path, sessionId) {
    return join(path, `${createHash("sha256").update(sessionId).digest("hex")}.json`)
  }

  /** Read all queued requests, ignoring malformed or mismatched markers. */
  async readPendingDeletes(path) {
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch (error) {
      if (error?.code === "ENOENT") return []
      throw error
    }
    const pending = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue
      const marker = join(path, entry.name)
      try {
        const record = JSON.parse(await readFile(marker, "utf8"))
        if (validPendingDelete(record) && this.pendingDeleteMarker(path, record.sessionId) === marker) pending.push(record)
      } catch {
        // A partial marker is never trusted as a delete instruction.
      }
    }
    return pending
  }

  /** Atomically create or replace one per-session marker without lost updates. */
  async writePendingDelete(path, pending) {
    await mkdir(dirname(path), { recursive: true })
    await mkdir(path, { recursive: true, mode: 0o700 })
    const marker = this.pendingDeleteMarker(path, pending.sessionId)
    const temporary = `${marker}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(pending), { flag: "wx", mode: 0o600 })
      await rename(temporary, marker)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }

  /** Add one durable, identity-bound deletion request. */
  async queuePendingDelete(sessionId, header, persistence) {
    const path = this.pendingDeletePath(persistence)
    if (path === undefined) throw new Error("session persistence root is unavailable")
    const marker = this.pendingDeleteMarker(path, sessionId)
    try {
      const existing = JSON.parse(await readFile(marker, "utf8"))
      if (!validPendingDelete(existing) || !sameSessionIdentity(existing.header, header)) {
        throw new Error("a different deletion request already exists for this session id")
      }
      return
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
    await this.writePendingDelete(path, { sessionId, header: sessionIdentity(header) })
  }

  /** Remove a completed or superseded deletion request from the durable queue. */
  async removePendingDelete(sessionId, persistence, expectedHeader) {
    const path = this.pendingDeletePath(persistence)
    if (path === undefined) return
    const marker = this.pendingDeleteMarker(path, sessionId)
    if (expectedHeader !== undefined) {
      try {
        const current = JSON.parse(await readFile(marker, "utf8"))
        if (!validPendingDelete(current) || !sameSessionIdentity(current.header, expectedHeader)) return
      } catch (error) {
        if (error?.code === "ENOENT") return
        throw error
      }
    }
    await rm(marker, { force: true })
  }

  /** Retry queued deletes at activation, after lifecycle release, or after a writer lock clears. */
  async processPendingDeletes() {
    if (this.pendingDeleteRun !== undefined) return this.pendingDeleteRun
    const run = this.serializeDelete(async () => {
      const persistence = this.ctx.get("sessionPersistence")
      const path = this.pendingDeletePath(persistence)
      if (path === undefined) return
      const pending = await this.readPendingDeletes(path)
      let retry = false
      for (const item of pending) {
        const result = await this.deleteSessionNow(item.sessionId, item.header)
        if (result.ok === true || result.reason === "not-found" || result.reason === "superseded") {
          await this.removePendingDelete(item.sessionId, persistence, item.header)
          void note(`delete ${JSON.stringify(item.sessionId)} -> ${result.reason === "superseded" ? "pending-superseded" : "pending-complete"}`)
        } else {
          if (["busy", "session-live", "session-running"].includes(result.reason)) retry = true
          void note(`delete ${JSON.stringify(item.sessionId)} -> pending ${result.reason ?? "delete-failed"}`)
        }
      }
      if (retry) this.schedulePendingDeleteRetry()
    })
    this.pendingDeleteRun = run.finally(() => { this.pendingDeleteRun = undefined })
    return this.pendingDeleteRun
  }

  /** Schedule a bounded, low-frequency retry while a writer or live session remains. */
  schedulePendingDeleteRetry() {
    if (this.pendingRetryTimer !== undefined) return
    this.pendingRetryTimer = setTimeout(() => {
      this.pendingRetryTimer = undefined
      void this.processPendingDeletes().catch((error) => {
        void note(`pending-delete-retry-failed ${JSON.stringify(errorMessage(error))}`)
      })
    }, PENDING_DELETE_RETRY_MS)
    this.pendingRetryTimer.unref?.()
  }

  /** Stop the retry timer when the plugin unloads. */
  disposePendingDeleteWorker() {
    if (this.pendingRetryTimer !== undefined) clearTimeout(this.pendingRetryTimer)
    this.pendingRetryTimer = undefined
  }

  /**
   * Read the workspace's current branch state.
   *
   * @param {string} rawPath - absolute workspace directory.
   * @returns {Promise<{ present: boolean, reason?: string, branch?: string|null, detached?: boolean, sha?: string|null, unborn?: boolean }>}
   *   `present: false` means "show nothing": not a repository, no git, or an
   *   unreadable directory. Anything else describes a real repository.
   */
  async status(rawPath) {
    const cwd = normalizePath(rawPath)
    if (cwd === "") {
      reportOnce("", "no-path")
      return { present: false, reason: "no-path" }
    }

    // `rev-parse --git-dir` is the single authoritative repository probe: it
    // succeeds for normal checkouts, worktrees, and submodules alike.
    const probe = await runGit(cwd, ["rev-parse", "--git-dir"])
    if (!probe.ok) {
      const classified = classify(probe.message)
      reportOnce(cwd, classified.code)
      return { present: false, reason: classified.code }
    }

    // `symbolic-ref` is the branch name, or fails on a detached HEAD.
    const symbolic = await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    if (symbolic.ok && symbolic.stdout.trim() !== "") {
      const branch = symbolic.stdout.trim()
      const head = await runGit(cwd, ["rev-parse", "--short", "HEAD"])
      reportOnce(cwd, `present:${branch}`)
      return {
        present: true,
        branch,
        detached: false,
        sha: head.ok ? head.stdout.trim() : null,
        unborn: !head.ok,
      }
    }

    // Detached HEAD: report the short sha instead of a branch name.
    const head = await runGit(cwd, ["rev-parse", "--short", "HEAD"])
    if (head.ok && head.stdout.trim() !== "") {
      reportOnce(cwd, "present:detached")
      return { present: true, branch: null, detached: true, sha: head.stdout.trim(), unborn: false }
    }

    // A repository with no commits yet.
    reportOnce(cwd, "present:unborn")
    return { present: true, branch: null, detached: false, sha: null, unborn: true }
  }

  /**
   * List local branches, most recently committed first, for the picker.
   *
   * @param {string} rawPath - absolute workspace directory.
   * @returns {Promise<{ ok: boolean, reason?: string, message?: string, branches: Array<{ name: string, current: boolean, subject: string, committedAt: number }> }>}
   */
  async branches(rawPath) {
    const cwd = normalizePath(rawPath)
    if (cwd === "") return { ok: false, reason: "no-path", message: "no workspace path", branches: [] }

    // Unit-separated, record-separated format: branch name, HEAD marker,
    // committer timestamp, subject. Sorting happens here so the picker is
    // stable without re-sorting in the browser.
    const format = [
      "%(refname:short)",
      "%(HEAD)",
      "%(committerdate:unix)",
      "%(contents:subject)",
    ].join("%1f")

    const result = await runGit(cwd, ["for-each-ref", "--sort=-committerdate", `--format=${format}%1e`, "refs/heads"])
    if (!result.ok) {
      const classified = classify(result.message)
      return { ok: false, reason: classified.code, message: classified.message, branches: [] }
    }

    const branches = result.stdout
      .split("\x1e")
      .map((record) => record.replace(/^\n/, ""))
      .filter((record) => record.trim() !== "")
      .map((record) => {
        const [name = "", head = "", committedAt = "0", subject = ""] = record.split("\x1f")
        return {
          name: name.trim(),
          current: head.trim() === "*",
          subject: subject.trim(),
          committedAt: Number.parseInt(committedAt, 10) || 0,
        }
      })
      .filter((entry) => entry.name !== "")

    return { ok: true, branches }
  }

  /**
   * Switch to an existing local branch.
   *
   * @param {string} rawPath - absolute workspace directory.
   * @param {string} rawName - exact branch name.
   * @returns {Promise<{ ok: boolean, reason?: string, message?: string, branch?: string }>}
   */
  async checkout(rawPath, rawName) {
    const cwd = normalizePath(rawPath)
    const name = typeof rawName === "string" ? rawName.trim() : ""
    if (cwd === "") return { ok: false, reason: "no-path", message: "no workspace path" }
    if (name === "") return { ok: false, reason: "empty-name", message: "branch name is empty" }

    const result = await runGit(cwd, ["checkout", name])
    if (!result.ok) {
      const classified = classify(result.message)
      return { ok: false, reason: classified.code, message: classified.message }
    }
    return { ok: true, branch: name }
  }

  /**
   * Create a new local branch from an optional starting point and switch to it.
   *
   * @param {string} rawPath - absolute workspace directory.
   * @param {string} rawName - new branch name.
   * @param {string} [rawFrom] - starting point; defaults to HEAD.
   * @returns {Promise<{ ok: boolean, reason?: string, message?: string, branch?: string }>}
   */
  async create(rawPath, rawName, rawFrom) {
    const cwd = normalizePath(rawPath)
    const name = typeof rawName === "string" ? rawName.trim() : ""
    const from = typeof rawFrom === "string" ? rawFrom.trim() : ""
    if (cwd === "") return { ok: false, reason: "no-path", message: "no workspace path" }
    if (name === "") return { ok: false, reason: "empty-name", message: "branch name is empty" }

    const args = from === "" ? ["checkout", "-b", name] : ["checkout", "-b", name, from]
    const result = await runGit(cwd, args)
    if (!result.ok) {
      const classified = classify(result.message)
      return { ok: false, reason: classified.code, message: classified.message }
    }
    return { ok: true, branch: name }
  }

  /**
   * Permanently remove one ordinary session from JSONL persistence. Live or
   * externally owned sessions are queued and removed after their writer is
   * released or on a later Host activation.
   *
   * @param {string} rawSessionId - exact durable session id.
   * @returns {Promise<{ ok: boolean, reason?: string, message?: string, sessionId?: string, warnings?: string[] }>}
   */
  async deleteSession(rawSessionId) {
    const sessionId = typeof rawSessionId === "string" ? rawSessionId : ""
    if (sessionId === "") return { ok: false, reason: "invalid-session", message: "session id is empty" }
    void note(`delete ${JSON.stringify(sessionId)} -> requested`)

    return this.serializeDelete(async () => {
      const result = await this.deleteSessionNow(sessionId)
      if (["session-live", "busy"].includes(result.reason)) {
        const persistence = this.ctx.get("sessionPersistence")
        const agents = this.ctx.get("agents")
        const sessions = this.ctx.get("sessions")
        const live = (typeof agents?.get === "function" ? agents.get(sessionId)?.session : undefined)
          ?? (typeof sessions?.get === "function" ? sessions.get(sessionId) : undefined)
        let header = live?.header
        if (header === undefined && typeof persistence?.stat === "function") {
          try {
            header = (await persistence.stat(sessionId))?.header
          } catch (error) {
            const reason = classifySessionDeleteError(error)
            return { ok: false, reason, message: errorMessage(error) }
          }
        }
        if (header === undefined) return { ok: false, reason: "not-found", message: "session was not found" }
        if (header.id !== sessionId) return { ok: false, reason: "unsupported", message: "stored session id does not match the request" }
        if (header.origin !== undefined || header.parentSession !== undefined) {
          return { ok: false, reason: "subagent", message: "subagent sessions cannot be deleted here" }
        }
        const location = sessionDirectory(persistence, header)
        if (location.ok !== true) return { ok: false, reason: location.reason, message: "session storage layout is unsupported" }
        try {
          await this.queuePendingDelete(sessionId, header, persistence)
        } catch (error) {
          void note(`delete ${JSON.stringify(sessionId)} -> queue-failed ${JSON.stringify(errorMessage(error))}`)
          return { ok: false, reason: "delete-failed", message: errorMessage(error) }
        }
        void note(`delete ${JSON.stringify(sessionId)} -> queued`)
        this.schedulePendingDeleteRetry()
        return { ok: true, queued: true, sessionId }
      }

      if (result.ok === true || result.reason === "not-found") {
        await this.removePendingDelete(sessionId, this.ctx.get("sessionPersistence")).catch((error) => {
          void note(`delete ${JSON.stringify(sessionId)} -> queue-cleanup-failed ${JSON.stringify(errorMessage(error))}`)
        })
      }
      return result
    })
  }

  /** Execute the guarded persistence deletion without changing queue state. */
  async deleteSessionNow(sessionId, expectedIdentity) {
    const persistence = this.ctx.get("sessionPersistence")
    const workspaceRegistry = this.ctx.get("workspaceRegistry")
    if (persistence === undefined || typeof persistence.stat !== "function" || typeof persistence.open !== "function" || workspaceRegistry === undefined) {
      return { ok: false, reason: "unsupported", message: "session deletion is unavailable in this DSH build" }
    }

    const agents = this.ctx.get("agents")
    const agent = typeof agents?.get === "function" ? agents.get(sessionId) : undefined
    if (agent?.status === "running") {
      if (expectedIdentity !== undefined && (agent.session?.header === undefined || !sameSessionIdentity(expectedIdentity, agent.session.header))) {
        return { ok: false, reason: "superseded", message: "the session id now refers to a different session" }
      }
      return { ok: false, reason: "session-running", message: "session is still running" }
    }
    if (agent !== undefined) {
      if (expectedIdentity !== undefined && (agent.session?.header === undefined || !sameSessionIdentity(expectedIdentity, agent.session.header))) {
        return { ok: false, reason: "superseded", message: "the session id now refers to a different session" }
      }
      void note(`delete ${JSON.stringify(sessionId)} -> blocked session-live`)
      return { ok: false, reason: "session-live", message: "session is still live in memory" }
    }

    const sessions = this.ctx.get("sessions")
    const liveSession = typeof sessions?.get === "function" ? sessions.get(sessionId) : undefined
    if (liveSession !== undefined) {
      if (expectedIdentity !== undefined && !sameSessionIdentity(expectedIdentity, liveSession.header)) {
        return { ok: false, reason: "superseded", message: "the session id now refers to a different session" }
      }
      void note(`delete ${JSON.stringify(sessionId)} -> blocked session-live`)
      return { ok: false, reason: "session-live", message: "session is still live in memory" }
    }

    let snapshot
    try {
      snapshot = await persistence.stat(sessionId)
    } catch (error) {
      const reason = classifySessionDeleteError(error)
      void note(`delete ${JSON.stringify(sessionId)} -> ${reason} ${JSON.stringify(errorMessage(error))}`)
      return { ok: false, reason, message: errorMessage(error) }
    }
    if (snapshot === undefined || snapshot.header === undefined) return { ok: false, reason: "not-found", message: "session was not found" }

    const header = snapshot.header
    if (header.id !== sessionId) return { ok: false, reason: "unsupported", message: "stored session id does not match the request" }
    if (expectedIdentity !== undefined && !sameSessionIdentity(expectedIdentity, header)) {
      return { ok: false, reason: "superseded", message: "the session id now refers to a different session" }
    }
    if (header.origin !== undefined || header.parentSession !== undefined) return { ok: false, reason: "subagent", message: "subagent sessions cannot be deleted here" }

    const location = sessionDirectory(persistence, header)
    if (location.ok !== true) return { ok: false, reason: location.reason, message: "session storage layout is unsupported" }

    let handle
    try {
      handle = await persistence.open(sessionId, "write")
    } catch (error) {
      const reason = classifySessionDeleteError(error)
      void note(`delete ${JSON.stringify(sessionId)} -> ${reason} ${JSON.stringify(errorMessage(error))}`)
      return { ok: false, reason, message: errorMessage(error) }
    }
    if (!sameSessionIdentity(header, handle.header)
      || (expectedIdentity !== undefined && !sameSessionIdentity(expectedIdentity, handle.header))) {
      await handle.close().catch((error) => {
        void note(`delete ${JSON.stringify(sessionId)} -> persistence-close-failed ${JSON.stringify(errorMessage(error))}`)
      })
      return { ok: false, reason: "superseded", message: "the session id now refers to a different session" }
    }

    const archivedIds = Array.isArray(workspaceRegistry.archivedSessionIds) ? workspaceRegistry.archivedSessionIds : []
    const pinnedIds = Array.isArray(workspaceRegistry.pinnedSessionIds) ? workspaceRegistry.pinnedSessionIds : []
    const wasArchived = archivedIds.includes(sessionId)
    const wasPinned = pinnedIds.includes(sessionId)
    let archivedByUs = false
    try {
      if (!wasArchived) {
        await workspaceRegistry.archiveSession(sessionId)
        archivedByUs = true
      }
    } catch (error) {
      await handle.close().catch((closeError) => {
        void note(`delete ${JSON.stringify(sessionId)} -> persistence-close-failed ${JSON.stringify(errorMessage(closeError))}`)
      })
      const message = errorMessage(error)
      void note(`delete ${JSON.stringify(sessionId)} -> workspace-archive-failed ${JSON.stringify(message)}`)
      return { ok: false, reason: "workspace-failed", message }
    }

    const tombstoneContainer = join(dirname(resolve(persistence.root)), ".dsh-shiro-extend-delete", randomUUID())
    const tombstone = join(tombstoneContainer, basename(location.path))
    try {
      // Move the whole session directory out of its canonical id path before
      // releasing the write lease. Future opens can no longer find the old
      // log, and cleanup cannot unlink the canonical session.lock inode.
      await mkdir(tombstoneContainer, { recursive: true, mode: 0o700 })
      await rename(location.path, tombstone)
    } catch (error) {
      await rm(tombstoneContainer, { recursive: true, force: true }).catch(() => {})
      await handle.close().catch((closeError) => {
        void note(`delete ${JSON.stringify(sessionId)} -> persistence-close-failed ${JSON.stringify(errorMessage(closeError))}`)
      })
      const warnings = []
      if (archivedByUs) {
        try {
          await workspaceRegistry.unarchiveSession(sessionId)
          if (wasPinned && typeof workspaceRegistry.pinSession === "function") await workspaceRegistry.pinSession(sessionId)
        } catch (restoreError) {
          warnings.push(`workspace-restore-failed:${errorMessage(restoreError)}`)
        }
      }
      const message = errorMessage(error)
      void note(`delete ${JSON.stringify(sessionId)} -> delete-move-failed ${JSON.stringify(message)}`)
      return { ok: false, reason: "delete-failed", message, ...(warnings.length === 0 ? {} : { warnings }) }
    }

    const closeWarnings = []
    try {
      await handle.close()
    } catch (error) {
      closeWarnings.push(`persistence-close-failed:${errorMessage(error)}`)
      void note(`delete ${JSON.stringify(sessionId)} -> persistence-close-failed ${JSON.stringify(errorMessage(error))}`)
    }

    try {
      await rm(tombstone, { recursive: true, force: true })
    } catch (error) {
      const warnings = [...closeWarnings]
      const originalExists = await stat(location.path).then(() => true, (statError) => statError?.code !== "ENOENT")
      if (!originalExists) {
        try {
          await rename(tombstone, location.path)
          if (archivedByUs) {
            await workspaceRegistry.unarchiveSession(sessionId)
            if (wasPinned && typeof workspaceRegistry.pinSession === "function") await workspaceRegistry.pinSession(sessionId)
          }
        } catch (restoreError) {
          warnings.push(`delete-restore-failed:${errorMessage(restoreError)}`)
        }
      } else {
        warnings.push("deleted-session-id-was-reused-before-cleanup")
      }
      const message = errorMessage(error)
      void note(`delete ${JSON.stringify(sessionId)} -> delete-cleanup-failed ${JSON.stringify(message)}`)
      return { ok: false, reason: "delete-failed", message, ...(warnings.length === 0 ? {} : { warnings }) }
    }
    await rm(tombstoneContainer, { recursive: true, force: true }).catch((error) => {
      closeWarnings.push(`delete-staging-cleanup-failed:${errorMessage(error)}`)
      void note(`delete ${JSON.stringify(sessionId)} -> staging-cleanup-failed ${JSON.stringify(errorMessage(error))}`)
    })

    const warnings = [...closeWarnings]
    const cache = this.ctx.get("sessionProjectionCache")
    if (typeof cache?.table?.delete === "function") {
      try {
        await cache.table.delete(sessionId)
      } catch (error) {
        warnings.push(`projection-cache-cleanup-failed:${errorMessage(error)}`)
        void note(`delete ${JSON.stringify(sessionId)} -> projection-cache-cleanup-failed ${JSON.stringify(errorMessage(error))}`)
      }
    }
    for (const cleanup of [
      () => workspaceRegistry.unarchiveSession(sessionId),
      () => workspaceRegistry.unpinSession(sessionId),
    ]) {
      try {
        await cleanup()
      } catch (error) {
        warnings.push(`workspace-cleanup-failed:${errorMessage(error)}`)
        void note(`delete ${JSON.stringify(sessionId)} -> workspace-cleanup-failed ${JSON.stringify(errorMessage(error))}`)
      }
    }
    void note(`delete ${JSON.stringify(sessionId)} -> deleted`)
    return { ok: true, sessionId, ...(warnings.length === 0 ? {} : { warnings }) }
  }
}

/** Wire methods and their parameter order, matching the Client descriptors. */
const DESCRIPTOR_SPECS = [
  { method: "status", parameters: ["path"] },
  { method: "branches", parameters: ["path"] },
  { method: "checkout", parameters: ["path", "name"] },
  { method: "create", parameters: ["path", "name", "from"] },
  { method: "deleteSession", parameters: ["sessionId"] },
]

/**
 * Build the hand-written invocation descriptors for {@link ShiroGit}.
 *
 * `src-json` carries arguments and results as plain JSON, which is what a
 * plain-JS plugin needs: no generated schema factories. Every parameter may be
 * omitted, because `ShiroGit` normalizes a missing path or name into its own
 * failure shape instead of rejecting the call at the wire boundary.
 *
 * @returns {Array<object>} ready for `ctx.typert.register()`.
 */
function descriptors() {
  return DESCRIPTOR_SPECS.map((spec) => ({
    id: `${PACKAGE_NAME}:${SERVICE_KEY}#${spec.method}`,
    service: SERVICE_KEY,
    namespace: SERVICE_KEY,
    method: spec.method,
    invocation: { kind: "direct" },
    parameters: spec.parameters.map((name) => ({
      name,
      wire: name,
      source: "json",
      acceptsUndefined: true,
      codec: { mode: "src-json" },
    })),
    result: { mode: "src-json" },
  }))
}

/** Services this plugin needs before it can activate. */
export const inject = ["agents", "sessionPersistence", "sessions", "typert", "workspaceRegistry"]

/**
 * Host plugin body: expose the git service and register its wire definitions.
 *
 * The Gateway resolves an endpoint from the local Typert store, then requires
 * the named Cordis Service to carry a matching `typertRemote` binding before it
 * dispatches — so this plugin both registers descriptors and freezes the
 * binding that `TypertRemoteService` would otherwise supply.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - profile context.
 */
export function apply(ctx) {
  const service = new ShiroGit(ctx)

  // Frozen so a later mutation cannot desynchronize the binding the Gateway
  // reads (`service`, `serviceKey`, `namespace`) from the live Service.
  service.typertRemote = Object.freeze({
    service,
    serviceKey: SERVICE_KEY,
    namespace: SERVICE_KEY,
  })

  ctx.provide(SERVICE_KEY, service)

  ctx.effect(
    () => ctx.typert.register({
      package: PACKAGE_NAME,
      face: "host",
      schemas: [],
      invocations: descriptors(),
    }),
    "shiro-extend: Remote definitions",
  )

  ctx.effect(() => {
    const retry = (session) => {
      if (session?.id !== undefined) {
        void service.processPendingDeletes().catch((error) => {
          void note(`pending-delete-event-failed ${JSON.stringify(errorMessage(error))}`)
        })
      }
    }
    const stopAgent = ctx.on("agent/disposed", ({ agent }) => { retry(agent?.session) })
    const stopSession = ctx.on("session/disposed", retry)
    void service.processPendingDeletes().catch((error) => {
      void note(`pending-delete-startup-failed ${JSON.stringify(errorMessage(error))}`)
    })
    return () => {
      stopAgent()
      stopSession()
      service.disposePendingDeleteWorker()
    }
  }, "shiro-extend: pending session deletions")

  // Activation marker: seeing this line after a restart proves the Host half
  // loaded and published its endpoints. A following `status ...` line proves
  // the Client half mounted and is polling.
  void note(
    `activated pid=${String(process.pid)} endpoints=${descriptors().map((descriptor) => `${descriptor.namespace}/${descriptor.method}`).join(",")}`,
  )
}

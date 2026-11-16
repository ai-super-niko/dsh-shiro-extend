import assert from "node:assert/strict"
import { after, test } from "node:test"
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const originalHome = process.env.HOME
const testHome = await mkdtemp(join(tmpdir(), "dsh-shiro-tests-"))
process.env.HOME = testHome
const { apply } = await import("../index.js")

after(async () => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  await rm(testHome, { recursive: true, force: true })
})

function harness(root, shared = {}) {
  const persistenceRoot = join(root, "sessions")
  const stored = shared.stored ?? new Map()
  const busyIds = shared.busyIds ?? new Set()
  const liveAgents = shared.liveAgents ?? new Map()
  const liveSessions = shared.liveSessions ?? new Map()
  const workspaceRegistry = shared.workspaceRegistry ?? {
    archivedSessionIds: [],
    pinnedSessionIds: [],
    async archiveSession(id) { this.archivedSessionIds = [...new Set([...this.archivedSessionIds, id])] },
    async unarchiveSession(id) { this.archivedSessionIds = this.archivedSessionIds.filter(value => value !== id) },
    async unpinSession(id) { this.pinnedSessionIds = this.pinnedSessionIds.filter(value => value !== id) },
    async pinSession(id) { this.pinnedSessionIds = [...new Set([...this.pinnedSessionIds, id])] },
  }
  const persistence = {
    root: persistenceRoot,
    locate(header) {
      return { kind: "jsonl", path: join(persistenceRoot, "--tmp-test--", header.id, "session.v4.jsonl.zstd") }
    },
    async stat(id) {
      const value = stored.get(id)
      return value === undefined ? undefined : { header: value.header }
    },
    async open(id) {
      const value = stored.get(id)
      if (value === undefined) {
        const error = new Error("session not found")
        error.name = "SessionPersistenceNotFoundError"
        throw error
      }
      if (busyIds.has(id)) {
        const error = new Error("session is owned")
        error.name = "SessionAlreadyOwnedError"
        throw error
      }
      busyIds.add(id)
      return { header: value.header, async close() { busyIds.delete(id) } }
    },
  }
  const cacheDeletes = []
  const services = {
    sessionPersistence: persistence,
    workspaceRegistry,
    agents: { get: id => liveAgents.get(id) },
    sessions: { get: id => liveSessions.get(id) },
    sessionProjectionCache: { table: { async delete(id) { cacheDeletes.push(id) } } },
  }
  const handlers = new Map()
  const cleanups = []
  const ctx = {
    typert: { register() {} },
    get(name) { return services[name] },
    provide(name, service) { services[name] = service },
    effect(callback) {
      const cleanup = callback()
      if (typeof cleanup === "function") cleanups.push(cleanup)
      return cleanup
    },
    on(name, callback) {
      const listeners = handlers.get(name) ?? new Set()
      listeners.add(callback)
      handlers.set(name, listeners)
      return () => listeners.delete(callback)
    },
  }
  apply(ctx)
  return {
    service: services.shiroGit,
    persistence,
    stored,
    busyIds,
    liveAgents,
    liveSessions,
    workspaceRegistry,
    cacheDeletes,
    cleanups,
    async persist(id, createdAt = 123) {
      const header = { version: 4, id, createdAt, cwd: "/tmp/test", isSeeded: false }
      const logPath = persistence.locate(header).path
      await mkdir(dirname(logPath), { recursive: true })
      await writeFile(logPath, "test log")
      stored.set(id, { header })
      return logPath
    },
    dispose() { for (const cleanup of cleanups) cleanup() },
  }
}

async function tempRoot() {
  return mkdtemp(join(tmpdir(), "dsh-shiro-delete-case-"))
}

test("deletes a cold session and clears its workspace and projection indexes", async () => {
  const root = await tempRoot()
  const instance = harness(root)
  try {
    const logPath = await instance.persist("cold-delete")
    const result = await instance.service.deleteSession("cold-delete")
    assert.equal(result.ok, true)
    await assert.rejects(stat(dirname(logPath)), { code: "ENOENT" })
    assert.deepEqual(instance.workspaceRegistry.archivedSessionIds, [])
    assert.deepEqual(instance.cacheDeletes, ["cold-delete"])
  } finally {
    instance.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test("keeps a confirmed live-session deletion queued and completes it after restart", async () => {
  const root = await tempRoot()
  const first = harness(root)
  let second
  try {
    const logPath = await first.persist("queued-delete")
    const header = first.stored.get("queued-delete").header
    first.liveAgents.set("queued-delete", { id: "queued-delete", status: "idle", session: { header } })
    first.liveSessions.set("queued-delete", { id: "queued-delete", header })
    const result = await first.service.deleteSession("queued-delete")
    assert.deepEqual(result, { ok: true, queued: true, sessionId: "queued-delete" })
    assert.equal((await readdir(join(root, "plugins", "dsh-shiro-extend", "pending-session-deletions"))).length, 1)

    first.dispose()
    second = harness(root, { stored: first.stored, workspaceRegistry: first.workspaceRegistry })
    await second.service.processPendingDeletes()
    await assert.rejects(stat(dirname(logPath)), { code: "ENOENT" })
    assert.equal((await readdir(join(root, "plugins", "dsh-shiro-extend", "pending-session-deletions"))).length, 0)
  } finally {
    first.dispose()
    second?.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test("retries a queued live session until it is released without a lifecycle event", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const root = await tempRoot()
  const instance = harness(root)
  try {
    const logPath = await instance.persist("live-retry")
    const header = instance.stored.get("live-retry").header
    const agent = { id: "live-retry", status: "idle", session: { header } }
    instance.liveAgents.set("live-retry", agent)
    instance.liveSessions.set("live-retry", { id: "live-retry", header })
    assert.equal((await instance.service.deleteSession("live-retry")).queued, true)
    assert.notEqual(instance.service.pendingRetryTimer, undefined)

    for (const status of ["idle", "running"]) {
      agent.status = status
      t.mock.timers.tick(30000)
      assert.notEqual(instance.service.pendingDeleteRun, undefined)
      await instance.service.pendingDeleteRun
      assert.ok(await stat(dirname(logPath)))
      assert.notEqual(instance.service.pendingRetryTimer, undefined)
    }

    instance.liveAgents.delete("live-retry")
    instance.liveSessions.delete("live-retry")
    t.mock.timers.tick(30000)
    assert.notEqual(instance.service.pendingDeleteRun, undefined)
    await instance.service.pendingDeleteRun
    await assert.rejects(stat(dirname(logPath)), { code: "ENOENT" })
    assert.equal((await readdir(join(root, "plugins", "dsh-shiro-extend", "pending-session-deletions"))).length, 0)
    assert.equal(instance.service.pendingRetryTimer, undefined)
  } finally {
    instance.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test("reschedules a pending deletion when the session is still live at startup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const root = await tempRoot()
  const first = harness(root)
  let second
  try {
    const logPath = await first.persist("startup-live")
    const header = first.stored.get("startup-live").header
    first.liveSessions.set("startup-live", { id: "startup-live", header })
    assert.equal((await first.service.deleteSession("startup-live")).queued, true)
    first.dispose()

    second = harness(root, { stored: first.stored, liveSessions: first.liveSessions })
    await second.service.processPendingDeletes()
    assert.notEqual(second.service.pendingRetryTimer, undefined)
    second.liveSessions.delete("startup-live")
    t.mock.timers.tick(30000)
    assert.notEqual(second.service.pendingDeleteRun, undefined)
    await second.service.pendingDeleteRun
    await assert.rejects(stat(dirname(logPath)), { code: "ENOENT" })
  } finally {
    first.dispose()
    second?.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test("waits for a writer lock but never queues a running agent", async () => {
  const root = await tempRoot()
  const instance = harness(root)
  try {
    const busyPath = await instance.persist("busy-delete")
    instance.busyIds.add("busy-delete")
    assert.equal((await instance.service.deleteSession("busy-delete")).queued, true)
    instance.busyIds.delete("busy-delete")
    await instance.service.processPendingDeletes()
    await assert.rejects(stat(dirname(busyPath)), { code: "ENOENT" })

    const runningPath = await instance.persist("running-delete")
    const header = instance.stored.get("running-delete").header
    instance.liveAgents.set("running-delete", { id: "running-delete", status: "running", session: { header } })
    const result = await instance.service.deleteSession("running-delete")
    assert.equal(result.reason, "session-running")
    assert.equal((await readdir(join(root, "plugins", "dsh-shiro-extend", "pending-session-deletions"))).length, 0)
    assert.ok(await stat(dirname(runningPath)))
  } finally {
    instance.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test("drops a stale queue entry without deleting a later session reusing its id", async () => {
  const root = await tempRoot()
  const instance = harness(root)
  try {
    const logPath = await instance.persist("reused-id", 1)
    const oldHeader = instance.stored.get("reused-id").header
    instance.liveSessions.set("reused-id", { id: "reused-id", header: oldHeader })
    assert.equal((await instance.service.deleteSession("reused-id")).queued, true)
    instance.liveSessions.delete("reused-id")
    instance.stored.set("reused-id", { header: { ...oldHeader, createdAt: 2 } })

    await instance.service.processPendingDeletes()
    assert.ok(await stat(dirname(logPath)))
    assert.equal((await readdir(join(root, "plugins", "dsh-shiro-extend", "pending-session-deletions"))).length, 0)
  } finally {
    instance.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

/**
 * Behaviour of the malformed-SSE retry guard.
 *
 * The guard exists because a gateway can emit `data: : keep-alive` instead of a
 * `: keep-alive` comment; the OpenAI SDK then fails the attempt with
 * `Error reading response: malformed server-sent event JSON.`, which DSH
 * classifies as the non-retryable `PI_AI_ERROR`, ending the turn. These tests
 * pin the decision itself and the budget that keeps it bounded.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const originalHome = process.env.HOME
const testHome = await mkdtemp(join(tmpdir(), "dsh-shiro-sse-tests-"))
process.env.HOME = testHome
const { apply, isMalformedSseFailure } = await import("../index.js")

after(async () => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  await rm(testHome, { recursive: true, force: true })
})

/** The failure a corrupted SSE frame produces after pi-ai normalizes it. */
const MALFORMED_SSE_FAILURE = Object.freeze({
  code: "PI_AI_ERROR",
  message: "Error reading response: malformed server-sent event JSON.",
})

/** Minimal Cordis context: enough to activate the Host half and drive one event. */
function harness() {
  const handlers = new Map()
  const cleanups = []
  const ctx = {
    typert: { register() {} },
    get() { return undefined },
    provide() {},
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
    /**
     * Drive one waterfall event the way the loop does: hand each listener the
     * payload plus a `next` that resolves to `undefined` (no downstream action).
     */
    async emit(name, payload) {
      let decision
      for (const listener of handlers.get(name) ?? []) {
        decision = await listener(payload, async () => undefined)
      }
      return decision
    },
    disposed() {
      for (const cleanup of cleanups) cleanup()
    },
  }
}

/** One request-error payload for the given step, with an already-open signal. */
function payload(overrides = {}) {
  return {
    agent: {},
    turn: 1,
    step: 2,
    provider: "evol-codex",
    failure: MALFORMED_SSE_FAILURE,
    retryPolicy: { mode: "normal", maxRetries: 5 },
    signal: new AbortController().signal,
    ...overrides,
  }
}

test("recognizes the malformed SSE wording from both readers", () => {
  assert.equal(isMalformedSseFailure(MALFORMED_SSE_FAILURE), true)
  assert.equal(isMalformedSseFailure({ code: "PI_AI_ERROR", message: "Invalid Codex SSE JSON: Unexpected token" }), true)
})

test("ignores unrelated failures so other policies keep their decisions", () => {
  assert.equal(isMalformedSseFailure(undefined), false)
  assert.equal(isMalformedSseFailure({ code: "PI_AI_ERROR", message: "pi-ai stream ended pending" }), false)
  assert.equal(isMalformedSseFailure({ code: "TRANSPORT", message: MALFORMED_SSE_FAILURE.message }), false)
  assert.equal(isMalformedSseFailure({ message: MALFORMED_SSE_FAILURE.message }), false)
})

test("retries a corrupted frame twice, then lets the failure through", async () => {
  const instance = harness()
  try {
    const call = payload()
    assert.deepEqual(await instance.emit("agent/request-error", call), { kind: "retry" })
    assert.deepEqual(await instance.emit("agent/request-error", call), { kind: "retry" })
    assert.equal(await instance.emit("agent/request-error", call), undefined)
  } finally {
    instance.disposed()
  }
})

test("stays exhausted instead of replenishing the budget on the next failure", async () => {
  const instance = harness()
  try {
    const call = payload()
    await instance.emit("agent/request-error", call)
    await instance.emit("agent/request-error", call)
    assert.equal(await instance.emit("agent/request-error", call), undefined)
    // Another recovery listener retrying the same step must not mint a new budget.
    assert.equal(await instance.emit("agent/request-error", call), undefined)
    assert.equal(await instance.emit("agent/request-error", call), undefined)
  } finally {
    instance.disposed()
  }
})

test("budgets per step rather than per agent", async () => {
  const instance = harness()
  try {
    const agent = {}
    assert.deepEqual(await instance.emit("agent/request-error", payload({ agent, step: 1 })), { kind: "retry" })
    assert.deepEqual(await instance.emit("agent/request-error", payload({ agent, step: 2 })), { kind: "retry" })
    assert.deepEqual(await instance.emit("agent/request-error", payload({ agent, step: 1 })), { kind: "retry" })
  } finally {
    instance.disposed()
  }
})

test("a new turn starts from idle with a fresh budget", async () => {
  const instance = harness()
  try {
    const agent = {}
    const call = payload({ agent, turn: 3 })
    await instance.emit("agent/request-error", call)
    await instance.emit("agent/request-error", call)
    assert.equal(await instance.emit("agent/request-error", call), undefined)
    await instance.emit("agent/status", { agent, status: "idle" })
    assert.deepEqual(await instance.emit("agent/request-error", call), { kind: "retry" })
  } finally {
    instance.disposed()
  }
})

test("honours an explicit no-retry policy and a cancelled turn", async () => {
  const instance = harness()
  try {
    assert.equal(
      await instance.emit("agent/request-error", payload({ retryPolicy: { mode: "normal", maxRetries: 0 } })),
      undefined,
    )
    const controller = new AbortController()
    controller.abort()
    assert.equal(await instance.emit("agent/request-error", payload({ signal: controller.signal })), undefined)
  } finally {
    instance.disposed()
  }
})

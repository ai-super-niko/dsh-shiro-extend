// The SSE guard must turn the gateway's heartbeat frames into legal SSE
// comments, pass JSON frames through byte-identical, forward an
// unclassifiable payload instead of dropping it, and leave non-SSE traffic
// untouched.
import assert from "node:assert/strict"
import { test } from "node:test"

import { classifySseLine, installSseGuard } from "../lib/sse-guard.js"

const raw = [
  'event: response.created\ndata: {"type":"response.created","n":1}\n\n',
  "data: : keep-alive\n\n",
  "data:: keep-alive\r\n\r\n",
  "data: keep-alive\n\n",
  "data: ping\n\n",
  "data:\n\n",
  "data: \n\n",
  "data: <html>upstream error</html>\n\n",
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","d":"hi"}\n\n',
  "data: [DONE]\n\n",
].join("")

const sseResponse = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        // Split mid-line and mid-frame to prove the line buffer works.
        const bytes = new TextEncoder().encode(raw)
        const cuts = [37, 95, 96, 190, 250, 300, bytes.length]
        let from = 0
        for (const to of cuts) {
          controller.enqueue(bytes.slice(from, to))
          from = to
        }
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream; charset=utf-8", "content-length": "999" } },
  )

test("repairs heartbeat frames and forwards everything else", async () => {
  const original = globalThis.fetch
  const lines = []
  globalThis.fetch = async () => sseResponse()
  const restore = installSseGuard((line) => lines.push(line))

  try {
    const response = await globalThis.fetch("https://example.invalid/v1/messages", { method: "POST" })
    assert.equal(response.headers.get("content-length"), null, "stale length dropped")

    const text = await response.text()
    assert.ok(text.includes("\n: keep-alive\n\n"), "colon comment repaired")
    assert.ok(text.includes("\n: keep-alive\r\n\r\n"), "crlf comment repaired")
    assert.equal((text.match(/: keep-alive\n\n/g) ?? []).length, 5, "heartbeats normalised")
    assert.ok(!text.includes("data: : keep-alive"), "no mislabelled comment remains")
    assert.ok(!text.includes("data: keep-alive"), "no bare heartbeat remains")
    assert.ok(text.includes("data: <html>upstream error</html>"), "unknown payload forwarded unchanged")
    assert.ok(text.includes('data: {"type":"response.created","n":1}'), "json frame untouched")
    assert.ok(text.includes("data: [DONE]"), "terminator untouched")

    assert.equal(lines.length, 2, "one line per report kind")
    assert.match(lines[0], /^repaired=6 heartbeat=4 url=https:\/\/example\.invalid\/v1\/messages$/)
    assert.match(lines[1], /^unknown-non-json=\["data: <html>upstream error<\/html>"\]/)
  } finally {
    restore()
    globalThis.fetch = original
  }
})

test("leaves non-SSE responses untouched", async () => {
  const original = globalThis.fetch
  const plain = new Response("hello", { headers: { "content-type": "application/json" } })
  globalThis.fetch = async () => plain
  const restore = installSseGuard()

  try {
    assert.equal(await globalThis.fetch("https://example.invalid/x"), plain, "same object returned")
  } finally {
    restore()
    globalThis.fetch = original
  }
})

test("does not nest wrappers when installed twice", async () => {
  const original = globalThis.fetch
  const base = async () => new Response("x", { headers: { "content-type": "text/plain" } })
  globalThis.fetch = base
  const first = installSseGuard()
  const second = installSseGuard()

  try {
    // The second install sees an already-patched fetch and must be a no-op, so
    // the first restore is the one that brings the original back.
    second()
    assert.notEqual(globalThis.fetch, base, "second restore must not unpatch the first guard")
  } finally {
    first()
    globalThis.fetch = original
  }
})

test("classifies each frame shape", () => {
  assert.deepEqual(classifySseLine("data: : keep-alive\n"), { text: ": keep-alive\n", kind: "comment" })
  assert.deepEqual(classifySseLine("data: ping\n"), { text: ": keep-alive\n", kind: "heartbeat" })
  assert.deepEqual(classifySseLine("data:\n"), { text: ": keep-alive\n", kind: "heartbeat" })
  assert.deepEqual(classifySseLine('data: {"a":1}\n'), { text: 'data: {"a":1}\n', kind: null })
  assert.deepEqual(classifySseLine("data: oops\n"), { text: "data: oops\n", kind: "unknown" })
  assert.deepEqual(classifySseLine("event: done\n"), { text: "event: done\n", kind: null })
})

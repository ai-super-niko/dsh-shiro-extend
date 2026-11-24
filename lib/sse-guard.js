/**
 * Repair malformed server-sent-event heartbeat frames.
 *
 * Some OpenAI/Anthropic-compatible gateways emit keep-alives as
 *
 *     data: : keep-alive
 *
 * which is a comment frame (`: keep-alive`) that the gateway wrongly prefixed
 * with `data: `. Both the OpenAI and Anthropic clients parse every `data:`
 * payload as JSON, so the frame aborts the response with
 *
 *     Error reading response: malformed server-sent event JSON.
 *
 * DSH classifies that as `PI_AI_ERROR`, no retry policy covers it, and the turn
 * ends as “运行失败”. Measured against mg-new.evolai.cn on 2026-11-17, the frame
 * arrives every ~5 s of idle, so any reasoning-heavy request fails, and
 * {@link installSseGuard} — not the retry guard in `index.js` — is what fixes
 * it: the corruption is deterministic per idle interval, so a retry replays it.
 *
 * `install` wraps the process `fetch`. For `text/event-stream` responses it
 * rewrites a `data:` payload that cannot be JSON back into a legal SSE comment
 * and forwards every other byte of every other response untouched.
 */

/** Marker on the patched function, so a second activation does not nest wrappers. */
const PATCHED = Symbol.for("dsh-shiro-extend:sse-guard")

/** One `data:` line whose payload is an SSE comment, e.g. `data: : keep-alive`. */
const COMMENT_PAYLOAD = /^data:[ \t]*(:[^\r\n]*?)\r?\n?$/

/**
 * A `data:` line whose payload is a bare heartbeat word.
 *
 * The same gateway that emits `data: : keep-alive` also emits `data: keep-alive`
 * without the comment colon; either way the payload is not JSON, so the client
 * throws. These words cannot begin a JSON document, so treating them as
 * heartbeats cannot swallow real content.
 */
const HEARTBEAT_PAYLOAD = /^data:[ \t]*(?:keep[-_ ]?alive|ping|pong|heartbeat|heart[-_ ]?beat|noop|no[-_ ]?op|empty|ok)[ \t]*\r?\n?$/i

/**
 * A `data:` line with no payload at all.
 *
 * `JSON.parse("")` throws the same error, and an empty line contributes nothing
 * to a joined multi-line payload (the join would only add a leading newline,
 * which JSON tolerates), so turning it into a comment is lossless.
 */
const EMPTY_PAYLOAD = /^data:[ \t]*\r?\n?$/

/** A payload that cannot be the start of a JSON document, but is not a heartbeat. */
const NON_JSON_PAYLOAD = /^data:[ \t]*[^ \t\r\n{[]/

/**
 * Classify and, when safe, rewrite one line.
 *
 * @param {string} line - one raw line, including any line terminator.
 * @returns {{ text: string, kind: "comment" | "heartbeat" | "unknown" | null }}
 *   `text` is what to forward; `kind` is null when the line is left alone.
 */
export function classifySseLine(line) {
  const terminator = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : ""
  const comment = COMMENT_PAYLOAD.exec(line)
  if (comment !== null) return { text: `${comment[1]}${terminator}`, kind: "comment" }
  if (EMPTY_PAYLOAD.test(line)) return { text: `: keep-alive${terminator}`, kind: "heartbeat" }
  if (HEARTBEAT_PAYLOAD.test(line)) return { text: `: keep-alive${terminator}`, kind: "heartbeat" }
  // Reported, never rewritten: a payload we cannot classify may be a JSON frame
  // that merely spans several `data:` lines, so dropping it could lose content.
  if (NON_JSON_PAYLOAD.test(line)) return { text: line, kind: "unknown" }
  return { text: line, kind: null }
}

/**
 * Build a TransformStream that repairs heartbeat frames while keeping framing.
 *
 * Chunks are split on `\n`, and an incomplete tail waits for the next chunk, so
 * a `data:` line is never examined half-delivered. Text is decoded and
 * re-encoded as UTF-8, which SSE mandates, so payload bytes keep their meaning.
 *
 * @param {(report: { repaired: number, heartbeat: number, unknown: string[] }) => void} onDone
 *   called once when the stream ends.
 * @returns {TransformStream<Uint8Array, Uint8Array>}
 */
export function repairStream(onDone) {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ""
  let repaired = 0
  let heartbeat = 0
  const unknown = []

  const handle = (line, controller) => {
    const result = classifySseLine(line)
    if (result.kind === "comment") repaired += 1
    else if (result.kind === "heartbeat") { repaired += 1; heartbeat += 1 }
    else if (result.kind === "unknown" && unknown.length < 2) unknown.push(result.text.trim().slice(0, 80))
    controller.enqueue(encoder.encode(result.text))
  }

  return new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true })
      let index
      while ((index = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, index + 1)
        pending = pending.slice(index + 1)
        handle(line, controller)
      }
    },
    flush(controller) {
      if (pending !== "") handle(pending, controller)
      const rest = decoder.decode()
      if (rest !== "") controller.enqueue(encoder.encode(rest))
      onDone({ repaired, heartbeat, unknown })
    },
  })
}

/**
 * Wrap `globalThis.fetch` so SSE heartbeats survive the client's JSON parser.
 *
 * The original fetch remains the only thing that touches the network; this
 * wrapper only replaces the body of a successful event stream.
 *
 * @param {(line: string) => void} log - diagnostic sink owned by the caller.
 * @returns {() => void} restores the previous implementation.
 */
export function installSseGuard(log = () => {}) {
  const previous = globalThis.fetch
  if (typeof previous !== "function" || previous[PATCHED] === true) return () => {}

  const patched = async function fetch(input, init) {
    const response = await previous.call(this, input, init)
    const type = response.headers.get("content-type") ?? ""
    if (response.body === null || !type.toLowerCase().includes("text/event-stream")) return response

    const url = typeof input === "string" ? input : String(input?.url ?? "")
    const headers = new Headers(response.headers)
    // The repaired body is a different byte stream; a stale length would lie.
    headers.delete("content-length")
    headers.delete("content-encoding")

    const body = response.body.pipeThrough(repairStream(({ repaired, heartbeat, unknown }) => {
      if (repaired > 0) log(`repaired=${repaired} heartbeat=${heartbeat} url=${url}`)
      if (unknown.length > 0) log(`unknown-non-json=${JSON.stringify(unknown)} url=${url}`)
    }))
    return new Response(body, { status: response.status, statusText: response.statusText, headers })
  }

  patched[PATCHED] = true
  globalThis.fetch = patched
  return () => {
    if (globalThis.fetch === patched) globalThis.fetch = previous
  }
}

import { spawn } from "node:child_process"
import { mkdirSync, openSync, readFileSync, renameSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { CACHE_DIR, DEFAULT_PORT, PROTOCOL, TOKEN_FILE } from "../daemon/config.mjs"

const DAEMON = fileURLToPath(new URL("../daemon/server.mjs", import.meta.url))
const LOG_FILE = join(CACHE_DIR, "daemon.log")
const LOG_MAX_BYTES = 5 * 1024 * 1024
const START_INTERVAL_MS = 15000
const START_WAIT_MS = 20000
const RETRY_MS = 300

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readToken() {
  try {
    return readFileSync(TOKEN_FILE, "utf8").trim()
  } catch {
    return ""
  }
}

export function createClient(options = {}) {
  const base = `http://127.0.0.1:${options.port ?? DEFAULT_PORT}`
  let token = readToken()
  let started = 0

  const send = (path, init = {}) => fetch(base + path, { ...init, headers: { "x-voice-token": token } })

  const authorized = async (path, init) => {
    const response = await send(path, init)
    if (response.status !== 401) return response
    token = readToken()
    return send(path, init)
  }

  const call = async (path, body) => {
    const response = await authorized(`/${path}`, { method: body ? "POST" : "GET", body: body && JSON.stringify(body) })
    const answer = await response.json()
    if (!response.ok) throw Object.assign(new Error(answer.error ?? `the daemon answered ${response.status}`), { status: response.status })
    return answer
  }

  const start = () => {
    if (Date.now() - started < START_INTERVAL_MS) return
    started = Date.now()
    mkdirSync(CACHE_DIR, { recursive: true })
    try {
      if (statSync(LOG_FILE).size > LOG_MAX_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`)
    } catch {}
    const log = openSync(LOG_FILE, "a")
    const env = { ...process.env, OPENCODE_VOICE_PORT: String(options.port ?? DEFAULT_PORT) }
    const child = spawn(options.node ?? "node", [DAEMON], { env, detached: true, stdio: ["ignore", log, log], windowsHide: true })
    child.on("error", (error) => console.error("[opencode-voice] could not start the daemon:", error.message))
    child.unref()
  }

  const ready = async () => {
    const deadline = Date.now() + START_WAIT_MS
    for (;;) {
      const health = await fetch(`${base}/health`).then((response) => response.json(), () => undefined)
      if (health?.protocol === PROTOCOL) return
      if (Date.now() > deadline) throw new Error(`The voice daemon did not start. See ${LOG_FILE}`)
      if (health) await authorized("/shutdown", { method: "POST" }).catch(() => undefined)
      else start()
      await sleep(RETRY_MS)
    }
  }

  const events = async (onEvent, signal) => {
    const response = await authorized("/events", { signal })
    if (!response.ok) throw new Error(`the daemon answered ${response.status}`)
    const decoder = new TextDecoder()
    let buffer = ""
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true })
      const blocks = buffer.split("\n\n")
      buffer = blocks.pop()
      for (const block of blocks) if (block.startsWith("data: ")) onEvent(JSON.parse(block.slice(6)))
    }
  }

  return { call, ready, events }
}

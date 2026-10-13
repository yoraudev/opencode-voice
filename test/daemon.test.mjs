import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { DEFAULTS, load, save, validate } from "../daemon/config.mjs"
import { createDaemon } from "../daemon/server.mjs"
import { fakeRecorder, fakeVad, frames } from "./fakes.mjs"

const TOKEN = "secret"
const servers = []
after(() => servers.forEach((server) => server.close()))

async function boot(overrides = {}) {
  const calls = { download: [], load: [], persisted: [] }
  const daemon = createDaemon({
    config: { ...DEFAULTS, silenceMs: 600 },
    persist: (config) => calls.persisted.push({ ...config }),
    download: async (model) => calls.download.push(model),
    loadEngine: async (options) => {
      calls.load.push(options)
      return { transcribe: async () => "hello", createVad: fakeVad }
    },
    openMic: () => fakeRecorder(frames("..SSS")),
    listDevices: () => ["Mic A"],
    listModels: () => [{ id: "small", bytes: 1, downloaded: true }],
    token: TOKEN,
    ...overrides,
  })
  const server = createServer(daemon.handle)
  servers.push({ close: () => (daemon.close(), server.close()) })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const request = async (method, path, body, headers = { "x-voice-token": TOKEN }) => {
    const response = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }

  const until = async (types, owner) => {
    const response = await fetch(`${base}/events`, { headers: { "x-voice-token": TOKEN } })
    const seen = []
    let buffer = ""
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      buffer += chunk
      const blocks = buffer.split("\n\n")
      buffer = blocks.pop()
      for (const block of blocks) {
        if (!block.startsWith("data: ")) continue
        const event = JSON.parse(block.slice(6))
        seen.push(event)
        if (types.includes(event.type) && (!owner || event.owner === owner)) {
          await response.body.cancel().catch(() => {})
          return seen
        }
      }
    }
    return seen
  }
  return { request, until, calls }
}

test("requests need the token and must not come from a web page", async () => {
  const { request } = await boot()
  assert.equal((await request("GET", "/config", undefined, {})).status, 401)
  assert.equal((await request("POST", "/start", { owner: "a" }, { "x-voice-token": TOKEN, origin: "https://example.com" })).status, 403)
  assert.equal((await request("GET", "/health", undefined, {})).status, 200)
})

test("a recording loads the model, sends the text to its owner and frees the microphone", async () => {
  const { request, until, calls } = await boot()
  const events = until(["final"], "a")
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual((await request("POST", "/start", { owner: "a" })).body, { ok: true })
  assert.equal((await request("POST", "/start", { owner: "b" })).status, 409)
  const seen = await events
  assert.deepEqual(seen.at(-1), { type: "final", text: "hello", owner: "a" })
  assert.deepEqual(calls.download, ["small"])
  assert.deepEqual(calls.load, [{ model: "small", language: "auto", threads: 4 }])
  assert.equal((await request("GET", "/config")).body.recording, false)
  assert.equal((await request("POST", "/start", { owner: "b" })).status, 200)
})

test("only the owner can stop a recording", async () => {
  const { request, until } = await boot({ openMic: () => fakeRecorder(frames("S".repeat(100000))) })
  const listening = until(["listening"], "a")
  await new Promise((resolve) => setTimeout(resolve, 50))
  await request("POST", "/start", { owner: "a" })
  await listening
  assert.deepEqual((await request("POST", "/stop", { owner: "b" })).body, { ok: false })
  const ended = until(["cancelled"], "a")
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual((await request("POST", "/cancel", { owner: "a" })).body, { ok: true })
  await ended
})

test("a microphone that cannot be opened is reported and does not block the next recording", async () => {
  const { request, until } = await boot({
    openMic: () => {
      throw new Error("no microphone")
    },
  })
  const events = until(["error"], "a")
  await new Promise((resolve) => setTimeout(resolve, 50))
  await request("POST", "/start", { owner: "a" })
  assert.deepEqual((await events).at(-1), { type: "error", message: "no microphone", owner: "a" })
  assert.equal((await request("GET", "/config")).body.recording, false)
})

test("changing the model saves the setting and loads the new model", async () => {
  const { request, calls } = await boot()
  const { status, body } = await request("POST", "/config", { model: "turbo" })
  assert.equal(status, 200)
  assert.equal(body.model, "turbo")
  assert.equal(calls.persisted.at(-1).model, "turbo")
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(calls.download, ["turbo"])
  assert.equal((await request("GET", "/config")).body.status.state, "ready")
})

test("a setting that does not need the model again leaves it loaded", async () => {
  const { request, calls } = await boot()
  assert.equal((await request("POST", "/config", { silenceMs: 3000 })).body.silenceMs, 3000)
  assert.deepEqual(calls.load, [])
})

test("an invalid setting is refused and nothing is saved", async () => {
  const { request, calls } = await boot()
  const { status, body } = await request("POST", "/config", { model: "huge" })
  assert.equal(status, 400)
  assert.match(body.error, /model must be one of/)
  assert.deepEqual(calls.persisted, [])
})

test("settings survive a save and unknown or invalid stored values fall back to the defaults", () => {
  const file = join(mkdtempSync(join(tmpdir(), "opencode-voice-")), "nested", "config.json")
  assert.deepEqual(load(file), DEFAULTS)
  save({ ...DEFAULTS, model: "medium", silenceMs: 99999, extra: 1 }, file)
  assert.equal(JSON.parse(readFileSync(file, "utf8")).model, "medium")
  assert.deepEqual(load(file), { ...DEFAULTS, model: "medium" })
  assert.equal(validate("language", " TR "), "tr")
  assert.throws(() => validate("threads", 0))
  assert.throws(() => validate("port", 1))
})

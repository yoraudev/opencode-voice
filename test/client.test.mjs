import assert from "node:assert/strict"
import { createServer } from "node:http"
import { after, test } from "node:test"
import { DEFAULTS } from "../daemon/config.mjs"
import { createDaemon } from "../daemon/server.mjs"
import { createClient } from "../plugin/client.js"
import { openSettings, statusLine } from "../plugin/settings.js"
import { fakeRecorder, fakeVad, frames } from "./fakes.mjs"

const closers = []
after(() => closers.forEach((close) => close()))

async function boot({ loadMs = 0 } = {}) {
  const config = { ...DEFAULTS, silenceMs: 600 }
  const daemon = createDaemon({
    config,
    persist: () => {},
    download: async () => {},
    loadEngine: async () => {
      await new Promise((resolve) => setTimeout(resolve, loadMs))
      return { transcribe: async () => "hello", createVad: fakeVad }
    },
    openMic: () => fakeRecorder(frames("..SSS")),
    listDevices: () => ["Mic A"],
    listModels: () => [
      { id: "small", bytes: 375 * 1024 * 1024, downloaded: true },
      { id: "turbo", bytes: 1036 * 1024 * 1024, downloaded: false },
    ],
  })
  const server = createServer(daemon.handle)
  closers.push(() => (daemon.close(), server.close()))
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { config, client: createClient({ port: server.address().port }) }
}

test("the client records through the daemon and receives the text", async () => {
  const { client } = await boot()
  await client.ready()
  const stream = new AbortController()
  const seen = []
  const final = new Promise((resolve) => {
    client.events((event) => {
      seen.push(event.type)
      if (seen.length === 1) client.call("start", { owner: "me" })
      if (event.type === "final") resolve(event)
    }, stream.signal).catch(() => {})
  })
  assert.deepEqual(await final, { type: "final", text: "hello", owner: "me" })
  assert.deepEqual(seen.slice(0, 2), ["status", "started"])
  assert.ok(seen.includes("listening"))
  stream.abort()
})

test("a refused call carries the daemon's message and status", async () => {
  const { client } = await boot()
  await assert.rejects(client.call("config", { model: "huge" }), (error) => error.status === 400 && /model must be one of/.test(error.message))
})

function scripted(answers) {
  const shown = []
  const toasts = []
  const next = (options) => {
    shown.push(options)
    return Promise.resolve(answers.shift())
  }
  return { shown, toasts, dialog: { select: next, prompt: next, set() {} }, toast: { show: (toast) => toasts.push(toast) } }
}

test("the settings menu lists every setting and changes the one that is picked", async () => {
  const { client, config } = await boot()
  const ui = scripted(["silenceMs", "3000", "language", "tr", undefined])
  await openSettings({ ...ui, call: client.call, ready: client.ready, watch: async () => {} })
  assert.deepEqual(ui.shown[0].options.map((option) => option.value), ["status", "key", "model", "language", "device", "silenceMs", "threads", "speak", "voiceTr", "voiceEn"])
  assert.equal(config.silenceMs, 3000)
  assert.equal(config.language, "tr")
  assert.deepEqual(ui.toasts.map((toast) => toast.message), ["Silence before sending (ms) set to 3000.", "Language set to Turkish."])
  assert.match(ui.shown.at(-1).options.find((option) => option.value === "language").title, /Turkish/)
})

test("changing the model shows the loading progress and reports when it is ready", async () => {
  const { client, config } = await boot({ loadMs: 150 })
  const ui = scripted(["model", "turbo", undefined])
  const watched = []
  const watch = async (status) => {
    watched.push(status.state)
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  await openSettings({ ...ui, call: client.call, ready: client.ready, watch })
  assert.equal(config.model, "turbo")
  assert.deepEqual(watched, ["loading"])
  assert.deepEqual(ui.shown[1].options.map((option) => option.description.split(". ")[1]), ["375 MB, downloaded", "1036 MB, will be downloaded"])
  assert.deepEqual(ui.toasts.map((toast) => toast.variant), ["success"])
})

test("a refused value is shown as an error and the menu stays open", async () => {
  const { client, config } = await boot()
  const ui = scripted(["threads", "0", undefined])
  await openSettings({ ...ui, call: client.call, ready: client.ready, watch: async () => {} })
  assert.equal(config.threads, 4)
  assert.equal(ui.toasts[0].variant, "error")
  assert.equal(ui.shown.length, 3)
})

test("the status line names the state of the model", () => {
  assert.equal(statusLine({ state: "downloading", model: "small", percent: 40 }), "Downloading small: 40%")
  assert.equal(statusLine(undefined), "The daemon is not running")
})

test("the shortcut is changed in the menu and handed to the window at once", async () => {
  const { client, config } = await boot()
  const ui = scripted(["key", " Ctrl+Shift+R ", "key", "r", "key", "escape", undefined])
  const applied = []
  await openSettings({ ...ui, call: client.call, ready: client.ready, watch: async () => {}, onChange: (result) => applied.push(result.key) })
  assert.equal(config.key, "ctrl+shift+r")
  assert.deepEqual(applied, ["ctrl+shift+r"])
  assert.deepEqual(ui.toasts.map((toast) => toast.variant), ["success", "error", "error"])
  assert.equal(ui.toasts[0].message, "Shortcut set to ctrl+shift+r.")
  assert.match(ui.toasts[1].message, /would fire while you type/)
  assert.match(ui.toasts[2].message, /escape cancels a recording/)
  assert.equal(ui.shown[1].value, "alt+r")
})

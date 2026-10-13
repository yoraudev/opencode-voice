import assert from "node:assert/strict"
import { createServer } from "node:http"
import { after, test } from "node:test"
import { DEFAULTS, validate } from "../daemon/config.mjs"
import { createDaemon } from "../daemon/server.mjs"
import { sentences, speak, toPcm } from "../daemon/speaker.mjs"
import { INSTRUCTION, TOOL, createVoice } from "../plugin/server.js"
import { fakeRecorder, fakeVad, frames } from "./fakes.mjs"

const closers = []
after(() => closers.forEach((close) => close()))

const until = async (check) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(check(), "the expected state was not reached")
}

function fakeAudio() {
  const log = { spoken: [], loaded: [], downloaded: [], written: 0, closed: 0 }
  return {
    log,
    downloadVoice: async (voice) => log.downloaded.push(voice),
    loadSpeech: async ({ voice }) => {
      log.loaded.push(voice)
      return async (text) => {
        log.spoken.push({ voice, text })
        await new Promise((resolve) => setTimeout(resolve, 20))
        return { samples: new Float32Array(2205).fill(0.5), sampleRate: 22050 }
      }
    },
    openSpeaker: () => ({ write: async (pcm) => void (log.written += pcm.length), close: () => log.closed++ }),
  }
}

async function boot(overrides = {}) {
  const audio = fakeAudio()
  const config = { ...DEFAULTS, ...overrides.config }
  const daemon = createDaemon({
    persist: () => {},
    download: async () => {},
    loadEngine: async () => ({ transcribe: async () => "hello", createVad: fakeVad }),
    openMic: () => fakeRecorder(frames("S".repeat(100000))),
    listDevices: () => [],
    listModels: () => [],
    listVoices: () => [],
    downloadVoice: audio.downloadVoice,
    loadSpeech: audio.loadSpeech,
    openSpeaker: audio.openSpeaker,
    ...overrides,
    config,
  })
  const server = createServer(daemon.handle)
  closers.push(() => (daemon.close(), server.close()))
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const post = async (path, body) => {
    const response = await fetch(base + path, { method: "POST", body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  return { post, log: audio.log, config }
}

test("a reply is spoken with the voice of the language the model names", async () => {
  const { post, log } = await boot()
  assert.deepEqual((await post("/speak", { text: "Testler geçti. Bir dosya değişti.", language: "tr" })).body, { ok: true })
  await until(() => log.closed === 1)
  assert.deepEqual(log.spoken, [
    { voice: "tr_TR-dfki-medium", text: "Testler geçti." },
    { voice: "tr_TR-dfki-medium", text: "Bir dosya değişti." },
  ])
  assert.equal(log.written, 4410)

  await post("/speak", { text: "All tests pass.", language: "en" })
  await until(() => log.closed === 2)
  assert.deepEqual(log.spoken.at(-1), { voice: "en_US-lessac-medium", text: "All tests pass." })
  assert.deepEqual(log.loaded, ["tr_TR-dfki-medium", "en_US-lessac-medium"])
})

test("a voice is loaded once and the chosen voice of a language is used", async () => {
  const { post, log } = await boot({ config: { voiceEn: "en_US-ryan-medium" } })
  await post("/speak", { text: "One.", language: "en" })
  await until(() => log.closed === 1)
  await post("/speak", { text: "Two.", language: "en" })
  await until(() => log.closed === 2)
  assert.deepEqual(log.loaded, ["en_US-ryan-medium"])
})

test("a language without a voice and an empty text are refused", async () => {
  const { post } = await boot()
  assert.equal((await post("/speak", { text: "Hallo.", language: "de" })).status, 400)
  assert.equal((await post("/speak", { text: "  ", language: "en" })).status, 400)
})

test("nothing is spoken while spoken replies are off", async () => {
  const { post, log } = await boot({ config: { speak: false } })
  assert.deepEqual((await post("/speak", { text: "Done.", language: "en" })).body, { ok: false, reason: "Spoken replies are turned off." })
  assert.deepEqual(log.loaded, [])
})

test("starting a recording cuts the reply off, and nothing is spoken during one", async () => {
  const { post, log } = await boot()
  await post("/speak", { text: "One. Two. Three. Four. Five. Six. Seven. Eight.", language: "en" })
  await until(() => log.written > 0)
  await post("/start", { owner: "a" })
  await until(() => log.closed === 1)
  assert.ok(log.spoken.length < 8, `spoke ${log.spoken.length} of 8 sentences`)
  assert.deepEqual((await post("/speak", { text: "Done.", language: "en" })).body, { ok: false, reason: "A recording is running." })
})

test("choosing a voice fetches it, and a voice of the wrong language is refused", async () => {
  const { post, log, config } = await boot()
  assert.equal((await post("/config", { voiceTr: "tr_TR-fettah-medium" })).status, 200)
  await until(() => log.loaded.length === 1)
  assert.deepEqual(log.downloaded, ["tr_TR-fettah-medium"])
  assert.equal((await post("/config", { voiceTr: "en_US-amy-medium" })).status, 400)
  assert.equal(config.voiceTr, "tr_TR-fettah-medium")
  assert.throws(() => validate("speak", "yes"))
})

test("speech stops between sentences and closes the speaker once", async () => {
  const audio = fakeAudio()
  const generate = await audio.loadSpeech({ voice: "v" })
  const speech = speak("One. Two. Three.", { generate, open: audio.openSpeaker })
  await until(() => audio.log.written > 0)
  await speech.stop()
  assert.ok(audio.log.spoken.length < 3)
  assert.equal(audio.log.closed, 1)
})

test("text is split into sentences and samples into 16-bit audio", () => {
  assert.deepEqual(sentences("Tamam. Bitti mi? Evet!\nSon satır"), ["Tamam.", "Bitti mi?", "Evet!", "Son satır"])
  assert.deepEqual(sentences("   "), [])
  assert.deepEqual([...toPcm(Float32Array.from([0, 1, -1, 2]))], [0, 32767, -32767, 32767])
})

function voice({ speak: speakEnabled = true } = {}) {
  const calls = []
  const plugin = createVoice({
    ready: async () => calls.push(["ready"]),
    call: async (path, body) => {
      calls.push([path, body])
      return path === "config" ? { speak: speakEnabled } : { ok: true }
    },
  })
  const context = (sessionID) => ({
    sessionID,
    messages: [
      { role: "user", content: [{ type: "text", text: "earlier" }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
      { role: "user", content: [{ type: "text", text: "now" }] },
      { role: "tool", content: [] },
    ],
    tools: { read: {}, [TOOL]: {} },
  })
  const texts = (request) => request.messages.map((message) => message.content.map((part) => part.text))
  return { plugin, calls, context, texts }
}

test("only the turn after a spoken prompt gets the tool and the instruction", async () => {
  const { plugin, context, texts } = voice()
  plugin.onPrompt({ sessionID: "s1", metadata: { voice: true } })
  plugin.onPrompt({ sessionID: "s2" })
  const untouched = [["earlier"], ["answer"], ["now"], []]

  const spoken = context("s1")
  await plugin.onContext(spoken)
  assert.deepEqual(Object.keys(spoken.tools), ["read", TOOL])
  assert.deepEqual(texts(spoken), [["earlier"], ["answer"], ["now", INSTRUCTION], []])

  const typed = context("s2")
  await plugin.onContext(typed)
  assert.deepEqual(Object.keys(typed.tools), ["read"])
  assert.deepEqual(texts(typed), untouched)

  plugin.onPrompt({ sessionID: "s1" })
  const next = context("s1")
  await plugin.onContext(next)
  assert.deepEqual(Object.keys(next.tools), ["read"])
  assert.deepEqual(texts(next), untouched)
})

test("the tool is withheld while spoken replies are off", async () => {
  const { plugin, context, texts } = voice({ speak: false })
  plugin.onPrompt({ sessionID: "s1", metadata: { voice: true } })
  const spoken = context("s1")
  await plugin.onContext(spoken)
  assert.deepEqual(Object.keys(spoken.tools), ["read"])
  assert.deepEqual(texts(spoken), [["earlier"], ["answer"], ["now"], []])
})

test("the tool passes text and language to the daemon and tells the model the outcome", async () => {
  const { plugin, calls } = voice()
  assert.deepEqual(plugin.tool.input.properties.language.enum, ["tr", "en"])
  assert.deepEqual(plugin.tool.input.required, ["text", "language"])
  assert.deepEqual(await plugin.tool.execute({ text: "Bitti.", language: "tr" }), { content: "Said aloud to the user." })
  assert.deepEqual(calls, [["ready"], ["speak", { text: "Bitti.", language: "tr" }]])

  const failing = createVoice({ ready: async () => {}, call: async () => ({ ok: false, reason: "Spoken replies are turned off." }) })
  assert.deepEqual(await failing.tool.execute({ text: "Done.", language: "en" }), { content: "Not said aloud: Spoken replies are turned off." })
})

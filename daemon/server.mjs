import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { CACHE_DIR, DEFAULT_PORT, PROTOCOL, SPOKEN, TOKEN_FILE, load, save, validate } from "./config.mjs"
import { catalog, ensure } from "./models.mjs"
import { MIN_SILENCE_MS, createEngine } from "./recognizer.mjs"
import { devices, openRecorder } from "./recorder.mjs"
import { createSession } from "./session.mjs"
import { loadVoice, speak } from "./speaker.mjs"
import { ensureVoice, voiceCatalog } from "./voices.mjs"

const IDLE_EXIT_MS = 10 * 60 * 1000
const HEARTBEAT_MS = 15000
const RELOADS = new Set(["model", "language", "threads"])

function readToken() {
  try {
    const token = readFileSync(TOKEN_FILE, "utf8").trim()
    if (token) return token
  } catch {}
  const token = randomBytes(24).toString("hex")
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 })
  return token
}

export function createDaemon({
  config = load(),
  persist = save,
  download = ensure,
  loadEngine = createEngine,
  openMic = openRecorder,
  listDevices = devices,
  listModels = catalog,
  downloadVoice = ensureVoice,
  loadSpeech = loadVoice,
  openSpeaker,
  listVoices = voiceCatalog,
  token,
  onIdle = () => {},
} = {}) {
  const clients = new Set()
  let status = { state: "idle" }
  let engine
  let generation = 0
  let recording
  let idleTimer
  let voiceStatus
  const voices = new Map()
  let speech

  const broadcast = (event) => {
    const line = `data: ${JSON.stringify(event)}\n\n`
    for (const client of clients) client.write(line)
  }

  const shown = () => voiceStatus ?? status

  const setStatus = (next) => {
    status = next
    broadcast({ type: "status", status: shown() })
  }

  const setVoiceStatus = (next) => {
    voiceStatus = next
    broadcast({ type: "status", status: shown() })
  }

  const touch = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (recording || speech || engine?.pending) return touch()
      onIdle()
    }, IDLE_EXIT_MS)
    idleTimer.unref?.()
  }

  const prepare = () => {
    if (engine) return engine.promise
    const mine = ++generation
    const { model, language, threads } = config
    const current = { pending: true }
    setStatus({ state: "loading", model })
    current.promise = (async () => {
      await download(model, {
        onProgress: ({ percent }) => mine === generation && setStatus({ state: "downloading", model, percent }),
      })
      if (mine === generation) setStatus({ state: "loading", model })
      const loaded = await loadEngine({ model, language, threads })
      if (mine === generation) setStatus({ state: "ready", model })
      return loaded
    })()
      .catch((error) => {
        if (mine === generation) {
          engine = undefined
          setStatus({ state: "error", message: error.message })
        }
        throw error
      })
      .finally(() => {
        current.pending = false
      })
    current.promise.catch(() => {})
    engine = current
    return current.promise
  }

  const prepareVoice = (voice) => {
    if (voices.has(voice)) return voices.get(voice)
    setVoiceStatus({ state: "loading", model: voice })
    const promise = (async () => {
      await downloadVoice(voice, { onProgress: ({ percent }) => setVoiceStatus({ state: "downloading", model: voice, percent }) })
      setVoiceStatus({ state: "loading", model: voice })
      const generate = await loadSpeech({ voice, threads: config.threads })
      setVoiceStatus(undefined)
      return generate
    })().catch((error) => {
      voices.delete(voice)
      setVoiceStatus({ state: "error", message: error.message })
      throw error
    })
    promise.catch(() => {})
    voices.set(voice, promise)
    return promise
  }

  const hush = () => {
    const current = speech
    speech = undefined
    current?.stop()
  }

  const say = (text, voice) => {
    hush()
    const mine = { stop() {} }
    speech = mine
    prepareVoice(voice)
      .then((generate) => {
        if (speech !== mine) return
        const playing = speak(text, { generate, open: openSpeaker })
        mine.stop = playing.stop
        return playing.done
      })
      .catch((error) => console.error("[opencode-voice] could not speak:", error.message))
      .finally(() => {
        if (speech === mine) speech = undefined
        touch()
      })
  }

  const end = (owner, event) => {
    if (recording?.owner === owner) recording = undefined
    broadcast({ ...event, owner })
    touch()
  }

  const start = (owner) => {
    const mine = { owner }
    hush()
    recording = mine
    broadcast({ type: "started", owner })
    prepare()
      .then((loaded) => {
        if (recording !== mine) return
        mine.session = createSession({
          recorder: openMic(config.device),
          vad: loaded.createVad(),
          transcribe: loaded.transcribe,
          silenceMs: config.silenceMs,
          minSilenceMs: MIN_SILENCE_MS,
          emit: (event) => (event.type === "partial" ? broadcast({ ...event, owner }) : end(owner, event)),
        })
        broadcast({ type: "listening", owner })
        return mine.session.start()
      })
      .catch((error) => {
        if (recording === mine) end(owner, { type: "error", message: error.message })
      })
  }

  const finish = (owner, how) => {
    if (recording?.owner !== owner) return false
    if (recording.session) recording.session[how]()
    else end(owner, { type: "cancelled" })
    return true
  }

  const snapshot = () => ({ ...config, status: shown(), models: listModels(), voices: listVoices(), devices: listDevices(), recording: Boolean(recording) })

  const update = (changes) => {
    if (recording) throw Object.assign(new Error("Settings cannot be changed during a recording."), { status: 409 })
    const next = { ...config }
    for (const [key, value] of Object.entries(changes)) next[key] = validate(key, value)
    const reload = [...RELOADS].some((key) => next[key] !== config[key])
    const changed = (key) => next[key] !== config[key]
    const wanted = next.speak ? Object.values(SPOKEN).filter(({ setting }) => changed(setting) || changed("speak")).map(({ setting }) => next[setting]) : []
    if (changed("threads")) voices.clear()
    Object.assign(config, next)
    persist(config)
    if (reload) {
      engine = undefined
      prepare().catch(() => {})
    }
    for (const voice of wanted) prepareVoice(voice).catch(() => {})
    if (!config.speak) hush()
    return snapshot()
  }

  const routes = {
    "GET /health": () => ({ ok: true, protocol: PROTOCOL }),
    "POST /shutdown": () => {
      setImmediate(onIdle)
      return { ok: true }
    },
    "GET /config": snapshot,
    "POST /config": update,
    "POST /prepare": () => {
      prepare().catch(() => {})
      return snapshot()
    },
    "POST /start": ({ owner }) => {
      if (!owner) throw Object.assign(new Error("owner is missing"), { status: 400 })
      if (recording) throw Object.assign(new Error("Another recording is running."), { status: 409 })
      start(owner)
      return { ok: true }
    },
    "POST /speak": ({ text, language }) => {
      if (typeof text !== "string" || !text.trim()) throw Object.assign(new Error("text is missing"), { status: 400 })
      if (!SPOKEN[language]) throw Object.assign(new Error(`language must be one of ${Object.keys(SPOKEN).join(", ")}`), { status: 400 })
      if (!config.speak) return { ok: false, reason: "Spoken replies are turned off." }
      if (recording) return { ok: false, reason: "A recording is running." }
      say(text.trim(), config[SPOKEN[language].setting])
      return { ok: true }
    },
    "POST /quiet": () => {
      hush()
      return { ok: true }
    },
    "POST /stop": ({ owner }) => ({ ok: finish(owner, "stop") }),
    "POST /cancel": ({ owner }) => ({ ok: finish(owner, "cancel") }),
  }

  const readBody = async (request) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString("utf8")
    return body ? JSON.parse(body) : {}
  }

  const handle = async (request, response) => {
    touch()
    const path = new URL(request.url, "http://localhost").pathname
    const send = (code, body) => {
      response.writeHead(code, { "content-type": "application/json" })
      response.end(JSON.stringify(body))
    }
    if (request.headers.origin) return send(403, { error: "forbidden" })
    if (path !== "/health" && token && request.headers["x-voice-token"] !== token) return send(401, { error: "unauthorized" })

    if (request.method === "GET" && path === "/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
      response.write(`data: ${JSON.stringify({ type: "status", status: shown() })}\n\n`)
      clients.add(response)
      const heartbeat = setInterval(() => response.write(": ping\n\n"), HEARTBEAT_MS)
      request.on("close", () => {
        clearInterval(heartbeat)
        clients.delete(response)
      })
      return
    }

    const route = routes[`${request.method} ${path}`]
    if (!route) return send(404, { error: "not found" })
    try {
      send(200, await route(await readBody(request)))
    } catch (error) {
      send(error.status ?? 400, { error: error.message })
    }
  }

  touch()
  return {
    handle,
    close() {
      clearTimeout(idleTimer)
      hush()
      if (recording) finish(recording.owner, "cancel")
      for (const client of clients) client.end()
    },
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = DEFAULT_PORT
  const daemon = createDaemon({ token: readToken(), onIdle: () => process.exit(0) })
  const server = createServer(daemon.handle)
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") process.exit(0)
    console.error(error)
    process.exit(1)
  })
  server.listen(port, "127.0.0.1", () => console.error(`[opencode-voice] listening on 127.0.0.1:${port}`))
}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const CACHE_DIR = process.env.OPENCODE_VOICE_CACHE ?? join(homedir(), ".cache", "opencode-voice")
export const CONFIG_FILE = process.env.OPENCODE_VOICE_CONFIG ?? join(homedir(), ".config", "opencode-voice", "config.json")
export const TOKEN_FILE = join(CACHE_DIR, "token")
export const DEFAULT_PORT = Number(process.env.OPENCODE_VOICE_PORT) || 7718
export const PROTOCOL = 2

export const MODELS = ["tiny", "base", "small", "medium", "large-v3", "turbo"]

export const SPOKEN = {
  tr: { name: "Turkish", setting: "voiceTr" },
  en: { name: "English", setting: "voiceEn" },
}

export const VOICES = {
  "tr_TR-dfki-medium": "tr",
  "tr_TR-fahrettin-medium": "tr",
  "tr_TR-fettah-medium": "tr",
  "en_US-lessac-medium": "en",
  "en_US-amy-medium": "en",
  "en_US-ryan-medium": "en",
  "en_GB-alba-medium": "en",
}

export const DEFAULTS = {
  model: "small",
  language: "auto",
  silenceMs: 2000,
  device: "default",
  threads: 4,
  speak: true,
  voiceTr: "tr_TR-dfki-medium",
  voiceEn: "en_US-lessac-medium",
}

const LIMITS = {
  silenceMs: [600, 15000],
  threads: [1, 64],
}

export function validate(key, value) {
  if (!(key in DEFAULTS)) throw new Error(`unknown setting "${key}"`)
  if (key === "model") {
    if (!MODELS.includes(value)) throw new Error(`model must be one of ${MODELS.join(", ")}`)
    return value
  }
  const spoken = Object.keys(SPOKEN).find((language) => SPOKEN[language].setting === key)
  if (spoken) {
    const voices = Object.keys(VOICES).filter((voice) => VOICES[voice] === spoken)
    if (!voices.includes(value)) throw new Error(`${key} must be one of ${voices.join(", ")}`)
    return value
  }
  if (key === "speak") {
    if (typeof value !== "boolean") throw new Error("speak must be true or false")
    return value
  }
  if (key in LIMITS) {
    const [min, max] = LIMITS[key]
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be a whole number from ${min} to ${max}`)
    return value
  }
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${key} must be text`)
  return key === "language" ? value.trim().toLowerCase() : value
}

export function load(file = CONFIG_FILE) {
  const config = { ...DEFAULTS }
  let stored
  try {
    stored = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return config
  }
  for (const key of Object.keys(DEFAULTS)) {
    if (stored[key] === undefined) continue
    try {
      config[key] = validate(key, stored[key])
    } catch {}
  }
  return config
}

export function save(config, file = CONFIG_FILE) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, JSON.stringify(config, null, 2) + "\n")
  renameSync(`${file}.tmp`, file)
}

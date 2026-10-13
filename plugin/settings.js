const LANGUAGES = {
  auto: "Detect automatically",
  af: "Afrikaans", am: "Amharic", ar: "Arabic", as: "Assamese", az: "Azerbaijani", ba: "Bashkir", be: "Belarusian", bg: "Bulgarian", bn: "Bengali", bo: "Tibetan",
  br: "Breton", bs: "Bosnian", ca: "Catalan", cs: "Czech", cy: "Welsh", da: "Danish", de: "German", el: "Greek", en: "English", es: "Spanish",
  et: "Estonian", eu: "Basque", fa: "Persian", fi: "Finnish", fo: "Faroese", fr: "French", gl: "Galician", gu: "Gujarati", ha: "Hausa", haw: "Hawaiian",
  he: "Hebrew", hi: "Hindi", hr: "Croatian", ht: "Haitian Creole", hu: "Hungarian", hy: "Armenian", id: "Indonesian", is: "Icelandic", it: "Italian", ja: "Japanese",
  jw: "Javanese", ka: "Georgian", kk: "Kazakh", km: "Khmer", kn: "Kannada", ko: "Korean", la: "Latin", lb: "Luxembourgish", ln: "Lingala", lo: "Lao",
  lt: "Lithuanian", lv: "Latvian", mg: "Malagasy", mi: "Maori", mk: "Macedonian", ml: "Malayalam", mn: "Mongolian", mr: "Marathi", ms: "Malay", mt: "Maltese",
  my: "Myanmar", ne: "Nepali", nl: "Dutch", nn: "Nynorsk", no: "Norwegian", oc: "Occitan", pa: "Punjabi", pl: "Polish", ps: "Pashto", pt: "Portuguese",
  ro: "Romanian", ru: "Russian", sa: "Sanskrit", sd: "Sindhi", si: "Sinhala", sk: "Slovak", sl: "Slovenian", sn: "Shona", so: "Somali", sq: "Albanian",
  sr: "Serbian", su: "Sundanese", sv: "Swedish", sw: "Swahili", ta: "Tamil", te: "Telugu", tg: "Tajik", th: "Thai", tk: "Turkmen", tl: "Tagalog",
  tr: "Turkish", tt: "Tatar", uk: "Ukrainian", ur: "Urdu", uz: "Uzbek", vi: "Vietnamese", yi: "Yiddish", yo: "Yoruba", zh: "Chinese",
}

const MODEL_NOTES = {
  tiny: "Fastest, many mistakes",
  base: "Fast, rough",
  small: "Balanced; live text keeps up on most processors",
  medium: "More accurate, noticeably slower",
  "large-v3": "Most accurate, slow without a strong processor",
  turbo: "Nearly as accurate as large-v3 and faster",
}

const NUMBERS = {
  silenceMs: { title: "Silence before sending (ms)", help: "How long you must be silent after speaking before the prompt is sent. 600 to 15000.", description: "Recording stops and the prompt is sent after this much silence" },
  threads: { title: "Processor threads", help: "How many threads the model may use. 1 to 64.", description: "More threads make the live text faster, up to the number of physical cores" },
}

const TEXTS = {
  key: { title: "Shortcut", help: 'The keys that start and end a recording, joined by "+". For example alt+r, ctrl+shift+r or f8.', description: "Starts a recording, and ends and sends it" },
}

export const isBusy =(status) => status?.state === "downloading" || status?.state === "loading"

export function statusLine(status) {
  if (!status) return "The daemon is not running"
  if (status.state === "downloading") return `Downloading ${status.model}: ${status.percent}%`
  if (status.state === "loading") return `Loading ${status.model}…`
  if (status.state === "error") return `Loading failed: ${status.message}`
  if (status.state === "ready") return `The ${status.model} model is ready`
  return "The model is loaded on the first recording"
}

const megabytes = (bytes) => `${Math.round(bytes / 1024 / 1024)} MB`
const size = (item) => `${megabytes(item.bytes)}, ${item.downloaded ? "downloaded" : "will be downloaded"}`

const SELECTS = {
  model: { title: "Model", category: "Recognition", description: "Larger models make fewer mistakes and take longer" },
  language: { title: "Language", category: "Recognition", description: "A fixed language is more reliable than detection for short sentences" },
  device: { title: "Microphone", category: "Recognition", description: "The input device recordings come from" },
  voiceTr: { title: "Turkish voice", category: "Spoken replies", description: "The voice for replies the model speaks in Turkish", spoken: "tr" },
  voiceEn: { title: "English voice", category: "Spoken replies", description: "The voice for replies the model speaks in English", spoken: "en" },
}

function choices(key, config) {
  if (key === "model") return config.models.map((model) => ({ value: model.id, title: model.id, description: `${MODEL_NOTES[model.id]}. ${size(model)}` }))
  if (key === "language") return Object.entries(LANGUAGES).map(([code, name]) => ({ value: code, title: code === "auto" ? name : `${name} (${code})` }))
  if (SELECTS[key].spoken) return config.voices.filter((voice) => voice.language === SELECTS[key].spoken).map((voice) => ({ value: voice.id, title: voice.id, description: size(voice) }))
  return ["default", ...config.devices].map((device) => ({ value: device, title: device === "default" ? "System default" : device }))
}

const label = (key, value) => (key === "language" ? (LANGUAGES[value] ?? value) : key === "device" && value === "default" ? "System default" : value)

async function pick(key, config, dialog) {
  if (SELECTS[key]) {
    const selection = dialog.select({ title: SELECTS[key].title, placeholder: "Search", options: choices(key, config), current: config[key] })
    dialog.set?.({ size: "large" })
    return selection
  }
  const item = TEXTS[key] ?? NUMBERS[key]
  const text = await dialog.prompt({ title: item.title, description: item.help, value: String(config[key]) })
  if (text === undefined || text.trim() === "") return undefined
  return TEXTS[key] ? text.trim().toLowerCase() : Number(text)
}

export async function openSettings({ dialog, toast, call, ready, watch, onChange = () => {} }) {
  const say = (variant, message) => toast.show({ variant, title: "Voice", message })
  let pending
  let showProgress = false

  try {
    await ready()
  } catch (error) {
    return say("error", error.message)
  }

  for (;;) {
    const config = await call("config").catch(() => undefined)
    if (!config) return say("error", "The voice daemon did not answer.")

    const busy = isBusy(config.status)
    if (pending && !busy) {
      if (config.status.state === "error") say("error", statusLine(config.status))
      else say("success", pending)
      pending = undefined
    }

    if (busy && showProgress) {
      showProgress = false
      await watch(config.status)
      continue
    }
    showProgress = false

    const loaded = config.status.state === "ready"
    const options = [
      { value: "status", title: statusLine(config.status), category: "Status", description: busy ? "Select to watch the progress" : loaded ? "Loaded and waiting for a recording" : "Select to load the model now" },
      ...Object.entries(TEXTS).map(([key, item]) => ({ value: key, title: `${item.title}: ${config[key]}`, category: "Recording", description: item.description })),
      ...Object.entries(SELECTS).filter(([, item]) => item.category === "Recognition").map(([key, item]) => ({ value: key, title: `${item.title}: ${label(key, config[key])}`, category: item.category, description: item.description })),
      ...Object.entries(NUMBERS).map(([key, item]) => ({ value: key, title: `${item.title}: ${config[key]}`, category: "Recognition", description: item.description })),
      {
        value: "speak",
        title: config.speak ? "Spoken replies: on" : "Spoken replies: off",
        category: "Spoken replies",
        description: config.speak ? "After a spoken prompt the model says a short reply aloud. Select to turn off." : "Replies are only written. Select to turn on.",
      },
      ...Object.entries(SELECTS).filter(([, item]) => item.spoken).map(([key, item]) => ({ value: key, title: `${item.title}: ${config[key]}`, category: item.category, description: item.description })),
    ]

    const selection = dialog.select({ title: "Voice", placeholder: "Search settings", options })
    dialog.set?.({ size: "large" })
    const key = await selection
    if (key === undefined) return

    if (key === "status") {
      if (loaded) continue
      if (!busy) await call("prepare", {}).catch(() => undefined)
      pending = "The model is ready."
      showProgress = true
      continue
    }

    const value = key === "speak" ? !config.speak : await pick(key, config, dialog)
    if (value === undefined || value === config[key]) continue
    const result = await call("config", { [key]: value }).catch((error) => ({ error: error.message }))
    if (result.error) {
      say("error", result.error)
      continue
    }
    onChange(result)
    const done = key === "speak" ? (value ? "Spoken replies are on." : "Spoken replies are off.") : `${(SELECTS[key] ?? NUMBERS[key] ?? TEXTS[key]).title} set to ${label(key, result[key])}.`
    if (isBusy(result.status)) {
      pending = done
      showProgress = true
    } else say(value === false ? "warning" : "success", done)
  }
}

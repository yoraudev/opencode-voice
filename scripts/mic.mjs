import { createRequire } from "node:module"
import { parseArgs } from "node:util"
import { load } from "../daemon/config.mjs"
import { ensure } from "../daemon/models.mjs"
import { MIN_SILENCE_MS, createEngine } from "../daemon/recognizer.mjs"
import { FRAME_LENGTH, SAMPLE_RATE, openRecorder } from "../daemon/recorder.mjs"
import { createSession } from "../daemon/session.mjs"

const require = createRequire(import.meta.url)
const { values } = parseArgs({ options: { wav: { type: "string" }, model: { type: "string" }, language: { type: "string" }, silence: { type: "string" } } })
const config = { ...load(), ...(values.model && { model: values.model }), ...(values.language && { language: values.language }), ...(values.silence && { silenceMs: Number(values.silence) }) }

function wavRecorder(file) {
  const wave = require("sherpa-onnx-node").readWave(file)
  if (wave.sampleRate !== SAMPLE_RATE) throw new Error(`${file} must be sampled at ${SAMPLE_RATE} Hz, not ${wave.sampleRate}`)
  let offset = 0
  return {
    start() {},
    stop() {},
    async read() {
      await new Promise((resolve) => setTimeout(resolve, (FRAME_LENGTH / SAMPLE_RATE) * 1000))
      const frame = new Int16Array(FRAME_LENGTH)
      for (let i = 0; i < FRAME_LENGTH && offset + i < wave.samples.length; i++) frame[i] = wave.samples[offset + i] * 32767
      offset += FRAME_LENGTH
      return frame
    },
  }
}

await ensure(config.model, { onProgress: ({ percent }) => process.stderr.write(`\rDownloading the ${config.model} model: ${percent}%`) }).then((downloaded) => downloaded && process.stderr.write("\n"))
console.error(`Loading the ${config.model} model…`)
const engine = await createEngine(config)
const started = Date.now()
const stamp = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s`

console.error(values.wav ? `Reading ${values.wav}` : `Listening (language: ${config.language}). Speak, then stay silent for ${config.silenceMs} ms.`)
await createSession({
  recorder: values.wav ? wavRecorder(values.wav) : openRecorder(config.device),
  vad: engine.createVad(),
  transcribe: engine.transcribe,
  silenceMs: config.silenceMs,
  minSilenceMs: MIN_SILENCE_MS,
  emit(event) {
    if (event.type === "partial") console.log(`${stamp()}  ${event.committed}${event.partial ? ` [${event.partial}]` : ""}`)
    else console.log(`${stamp()}  ${event.type.toUpperCase()}: ${event.text ?? event.message ?? ""}`)
  },
}).start()

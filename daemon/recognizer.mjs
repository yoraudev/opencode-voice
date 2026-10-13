import { createRequire } from "node:module"
import { paths } from "./models.mjs"
import { SAMPLE_RATE } from "./recorder.mjs"

const require = createRequire(import.meta.url)

export const MIN_SILENCE_MS = 500
const MAX_SEGMENT_SECONDS = 15
const VAD_BUFFER_SECONDS = 60

export const spokenOnly = (text) => text.replace(/\([^)]*\)|\[[^\]]*\]|\*[^*]*\*|[♪♫]/g, " ").replace(/\s+/g, " ").trim()

export async function createEngine({ model, language, threads }) {
  const sherpa = require("sherpa-onnx-node")
  const files = paths(model)
  const recognizer = await sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      whisper: { encoder: files.encoder, decoder: files.decoder, language: language === "auto" ? "" : language, task: "transcribe" },
      tokens: files.tokens,
      numThreads: threads,
      provider: "cpu",
      debug: 0,
    },
  })

  return {
    async transcribe(samples) {
      const stream = recognizer.createStream()
      stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE })
      const result = await recognizer.decodeAsync(stream)
      return spokenOnly(result.text)
    },
    createVad() {
      return new sherpa.Vad(
        {
          sileroVad: { model: files.vad, threshold: 0.5, minSilenceDuration: MIN_SILENCE_MS / 1000, minSpeechDuration: 0.25, windowSize: 512, maxSpeechDuration: MAX_SEGMENT_SECONDS },
          sampleRate: SAMPLE_RATE,
          numThreads: 1,
          debug: 0,
        },
        VAD_BUFFER_SECONDS,
      )
    },
  }
}

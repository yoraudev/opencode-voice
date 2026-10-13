import { createRequire } from "node:module"
import { voicePaths } from "./voices.mjs"

const require = createRequire(import.meta.url)

const BUFFER_SECONDS = 20
const POLL_MS = 40
const TAIL_MS = 250

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function sentences(text) {
  return (text.match(/[^.!?…\n]+[.!?…]*/g) ?? []).map((part) => part.trim()).filter(Boolean)
}

export function toPcm(samples) {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) pcm[i] = Math.max(-1, Math.min(1, samples[i])) * 32767
  return pcm
}

export function openSpeaker(sampleRate) {
  const { PvSpeaker } = require("@picovoice/pvspeaker-node")
  const speaker = new PvSpeaker(sampleRate, 16, { bufferSizeSecs: BUFFER_SECONDS })
  speaker.start()
  let open = true
  return {
    async write(pcm) {
      let offset = 0
      while (open && offset < pcm.length) {
        offset += speaker.write(pcm.buffer.slice(pcm.byteOffset + offset * 2, pcm.byteOffset + pcm.length * 2))
        if (offset < pcm.length) await sleep(POLL_MS)
      }
    },
    close() {
      if (!open) return
      open = false
      try {
        speaker.stop()
      } finally {
        speaker.release()
      }
    },
  }
}

export async function loadVoice({ voice, threads }) {
  const sherpa = require("sherpa-onnx-node")
  const files = voicePaths(voice)
  const tts = await sherpa.OfflineTts.createAsync({
    model: { vits: { model: files.model, tokens: files.tokens, dataDir: files.dataDir }, numThreads: threads, provider: "cpu", debug: 0 },
    maxNumSentences: 1,
  })
  return (text) => tts.generateAsync({ text, sid: 0, speed: 1.0, enableExternalBuffer: false })
}

export function speak(text, { generate, open = openSpeaker }) {
  let stopped = false
  let speaker
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    speaker?.close()
  }
  const run = async () => {
    let playedUntil = 0
    for (const sentence of sentences(text)) {
      if (stopped) return
      const audio = await generate(sentence)
      if (stopped) return
      speaker ??= open(audio.sampleRate)
      await speaker.write(toPcm(audio.samples))
      playedUntil = Math.max(playedUntil, Date.now()) + (audio.samples.length / audio.sampleRate) * 1000
    }
    while (!stopped && Date.now() < playedUntil + TAIL_MS) await sleep(POLL_MS)
  }
  const done = run().finally(close)
  return {
    done,
    stop() {
      stopped = true
      close()
      return done.catch(() => {})
    },
  }
}

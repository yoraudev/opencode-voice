import { SAMPLE_RATE } from "./recorder.mjs"

const PREROLL_SAMPLES = SAMPLE_RATE * 0.3
const PARTIAL_SAMPLES = SAMPLE_RATE * 0.5
const WAIT_SAMPLES = SAMPLE_RATE * 30
const MAX_SAMPLES = SAMPLE_RATE * 300

export function toFloat(frame) {
  const samples = new Float32Array(frame.length)
  for (let i = 0; i < frame.length; i++) samples[i] = frame[i] / 32768
  return samples
}

function concat(chunks) {
  const out = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

export function createSession({ recorder, vad, transcribe, silenceMs, minSilenceMs = 500, emit }) {
  const silenceSamples = (Math.max(0, silenceMs - minSilenceMs) * SAMPLE_RATE) / 1000
  const committed = []
  let current = []
  let preroll = []
  let prerollLength = 0
  let speaking = false
  let heard = false
  let silent = 0
  let sincePartial = 0
  let total = 0
  let segment = 0
  let decoding = false
  let queue = Promise.resolve()
  let running = false
  let cancelled = false
  let failure
  let done

  const text = () => committed.filter(Boolean).join(" ")

  const enqueue = (task) => {
    queue = queue.then(task).catch((error) => {
      failure ??= error
      running = false
    })
  }

  const finalize = (samples) => {
    const index = segment++
    heard = true
    silent = 0
    enqueue(async () => {
      committed[index] = await transcribe(samples)
      if (!cancelled) emit({ type: "partial", committed: text(), partial: "" })
    })
  }

  const preview = () => {
    const index = segment
    const samples = concat(current)
    decoding = true
    enqueue(async () => {
      try {
        if (!running || index !== segment) return
        const partial = await transcribe(samples)
        if (running && index === segment) emit({ type: "partial", committed: text(), partial })
      } finally {
        decoding = false
      }
    })
  }

  const drain = () => {
    while (!vad.isEmpty()) {
      const samples = vad.front(false).samples
      vad.pop()
      finalize(samples)
      current = []
      sincePartial = 0
    }
  }

  const feed = (frame) => {
    const samples = toFloat(frame)
    vad.acceptWaveform(samples)
    const detected = vad.isDetected()
    if (detected) {
      if (!speaking) {
        current = preroll
        preroll = []
        prerollLength = 0
        sincePartial = 0
      }
      current.push(samples)
      sincePartial += samples.length
    } else {
      preroll.push(samples)
      prerollLength += samples.length
      while (prerollLength - preroll[0].length >= PREROLL_SAMPLES) prerollLength -= preroll.shift().length
      if (heard) silent += samples.length
    }
    speaking = detected
    total += samples.length
    drain()
    if (detected && sincePartial >= PARTIAL_SAMPLES && !decoding) {
      sincePartial = 0
      preview()
    }
    if (heard && !detected && silent >= silenceSamples) running = false
    if (total >= (heard || detected ? MAX_SAMPLES : WAIT_SAMPLES)) running = false
  }

  const run = async () => {
    recorder.start()
    try {
      while (running) {
        const frame = await recorder.read()
        if (running) feed(frame)
      }
    } finally {
      recorder.stop()
    }
    if (cancelled) return emit({ type: "cancelled" })
    vad.flush()
    drain()
    await queue
    if (cancelled) return emit({ type: "cancelled" })
    if (failure) throw failure
    emit({ type: "final", text: text() })
  }

  return {
    start() {
      running = true
      done = run().catch((error) => {
        running = false
        emit({ type: "error", message: error.message })
      })
      return done
    },
    stop() {
      running = false
      return done
    },
    cancel() {
      cancelled = true
      running = false
      return done
    },
  }
}

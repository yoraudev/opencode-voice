import { FRAME_LENGTH } from "../daemon/recorder.mjs"

const frame = (value) => new Int16Array(FRAME_LENGTH).fill(value)

export const frames = (script) => [...script].map((char) => frame(char === "S" ? 16384 : 0))

export function fakeRecorder(list) {
  const state = { started: false, stopped: false, reads: 0 }
  return {
    state,
    start: () => (state.started = true),
    stop: () => (state.stopped = true),
    async read() {
      await new Promise((resolve) => setImmediate(resolve))
      return list[state.reads++] ?? frame(0)
    },
  }
}

export function fakeVad() {
  const segments = []
  let open
  const close = () => {
    if (open) segments.push({ samples: Float32Array.from(open) })
    open = undefined
  }
  return {
    acceptWaveform(samples) {
      if (samples[0] === 0) return close()
      open = [...(open ?? []), ...samples]
    },
    isDetected: () => Boolean(open),
    isEmpty: () => segments.length === 0,
    front: () => segments[0],
    pop: () => segments.shift(),
    flush: close,
  }
}

export function collector() {
  const events = []
  let finish
  const ended = new Promise((resolve) => (finish = resolve))
  return {
    events,
    ended,
    emit(event) {
      events.push(event)
      if (event.type !== "partial") finish(event)
    },
  }
}

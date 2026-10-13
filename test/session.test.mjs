import assert from "node:assert/strict"
import { test } from "node:test"
import { FRAME_LENGTH, SAMPLE_RATE } from "../daemon/recorder.mjs"
import { createSession } from "../daemon/session.mjs"
import { collector, fakeRecorder, fakeVad, frames } from "./fakes.mjs"

const FRAME_MS = (FRAME_LENGTH / SAMPLE_RATE) * 1000

const byLength = async (samples) => `speech${Math.round(samples.length / FRAME_LENGTH)}`

function run(script, options = {}) {
  const recorder = fakeRecorder(frames(script))
  const log = collector()
  const session = createSession({ recorder, vad: fakeVad(), transcribe: byLength, silenceMs: 320, minSilenceMs: 0, emit: log.emit, ...options })
  session.start()
  return { recorder, session, ...log }
}

test("ends by itself after the silence limit and joins the segments", async () => {
  const { ended, recorder } = run("..SSSS...SS")
  assert.deepEqual(await ended, { type: "final", text: "speech4 speech2" })
  assert.equal(recorder.state.stopped, true)
})

test("the silence limit counts from the end of speech, not from the start of the recording", async () => {
  const { ended, recorder } = run(".".repeat(40) + "SSS")
  assert.deepEqual(await ended, { type: "final", text: "speech3" })
  const silentFrames = recorder.state.reads - 43
  assert.ok(silentFrames >= 320 / FRAME_MS && silentFrames <= 320 / FRAME_MS + 2, `stopped after ${silentFrames} silent frames`)
})

test("shows the unfinished segment as partial text", async () => {
  const { ended, events } = run("S".repeat(40))
  await ended
  const partials = events.filter((event) => event.type === "partial" && event.partial)
  assert.ok(partials.length > 0)
  assert.match(partials[0].partial, /^speech\d+$/)
  assert.equal(partials[0].committed, "")
})

test("stop transcribes a segment that is still being spoken", async () => {
  const { ended, session, recorder } = run("S".repeat(100000))
  while (recorder.state.reads < 10) await new Promise((resolve) => setImmediate(resolve))
  await session.stop()
  const event = await ended
  assert.equal(event.type, "final")
  assert.match(event.text, /^speech\d+$/)
})

test("cancel discards the recording", async () => {
  const { ended, session, recorder } = run("S".repeat(100000))
  while (recorder.state.reads < 10) await new Promise((resolve) => setImmediate(resolve))
  await session.cancel()
  assert.deepEqual(await ended, { type: "cancelled" })
  assert.equal(recorder.state.stopped, true)
})

test("a recording nobody speaks into ends with empty text", async () => {
  const { ended, recorder } = run("")
  assert.deepEqual(await ended, { type: "final", text: "" })
  assert.equal(recorder.state.reads, Math.ceil((30 * SAMPLE_RATE) / FRAME_LENGTH))
})

test("a failing transcription ends the recording with an error and releases the microphone", async () => {
  const { ended, recorder } = run("SS..", {
    transcribe: async () => {
      throw new Error("model broke")
    },
  })
  assert.deepEqual(await ended, { type: "error", message: "model broke" })
  assert.equal(recorder.state.stopped, true)
})

import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

export const SAMPLE_RATE = 16000
export const FRAME_LENGTH = 512

const load = () => require("@picovoice/pvrecorder-node").PvRecorder

export function devices() {
  try {
    return load().getAvailableDevices()
  } catch {
    return []
  }
}

export function openRecorder(device = "default") {
  const PvRecorder = load()
  const index = device === "default" ? -1 : PvRecorder.getAvailableDevices().indexOf(device)
  const recorder = new PvRecorder(FRAME_LENGTH, index)
  return {
    start: () => recorder.start(),
    read: () => recorder.read(),
    stop: () => {
      try {
        recorder.stop()
      } finally {
        recorder.release()
      }
    },
  }
}

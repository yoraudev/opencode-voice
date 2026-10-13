import { createWriteStream, mkdirSync, renameSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { CACHE_DIR, MODELS } from "./config.mjs"

export const MODELS_DIR = join(CACHE_DIR, "models")

const VAD = { name: "silero_vad.onnx", url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx", size: 643854 }

const SIZES = {
  tiny: [12937772, 89855401],
  base: [29120534, 130672026],
  small: [112442483, 262226114],
  medium: [374196283, 571059257],
  "large-v3": [766671985, 1008265203],
  turbo: [674716297, 361080764],
}
const TOKENS_SIZE = 816730

function whisperFiles(model) {
  const base = `https://huggingface.co/csukuangfj/sherpa-onnx-whisper-${model}/resolve/main`
  const [encoder, decoder] = SIZES[model]
  return [
    { name: `${model}-encoder.int8.onnx`, size: encoder },
    { name: `${model}-decoder.int8.onnx`, size: decoder },
    { name: `${model}-tokens.txt`, size: TOKENS_SIZE },
  ].map((file) => ({ ...file, url: `${base}/${file.name}` }))
}

export function paths(model, dir = MODELS_DIR) {
  return {
    encoder: join(dir, `${model}-encoder.int8.onnx`),
    decoder: join(dir, `${model}-decoder.int8.onnx`),
    tokens: join(dir, `${model}-tokens.txt`),
    vad: join(dir, VAD.name),
  }
}

function present(file, dir) {
  try {
    return statSync(join(dir, file.name)).size === file.size
  } catch {
    return false
  }
}

export function catalog(dir = MODELS_DIR) {
  return MODELS.map((id) => {
    const files = whisperFiles(id)
    return { id, bytes: files.reduce((sum, file) => sum + file.size, 0), downloaded: files.every((file) => present(file, dir)) }
  })
}

async function fetchFile(file, dir, signal, onBytes) {
  const target = join(dir, file.name)
  const part = `${target}.part`
  const response = await fetch(file.url, { signal, redirect: "follow" })
  if (!response.ok || !response.body) throw new Error(`could not download ${file.name}: the server answered ${response.status}`)
  const out = createWriteStream(part)
  try {
    for await (const chunk of response.body) {
      if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve))
      onBytes(chunk.length)
    }
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())))
  } catch (error) {
    out.destroy()
    rmSync(part, { force: true })
    throw error
  }
  if (statSync(part).size !== file.size) {
    rmSync(part, { force: true })
    throw new Error(`${file.name} was downloaded incompletely`)
  }
  renameSync(part, target)
}

export async function ensure(model, { dir = MODELS_DIR, signal, onProgress = () => {} } = {}) {
  const missing = [...whisperFiles(model), VAD].filter((file) => !present(file, dir))
  if (missing.length === 0) return false
  mkdirSync(dir, { recursive: true })
  const total = missing.reduce((sum, file) => sum + file.size, 0)
  let done = 0
  let reported = -1
  for (const file of missing) {
    await fetchFile(file, dir, signal, (bytes) => {
      done += bytes
      const percent = Math.min(100, Math.floor((done / total) * 100))
      if (percent === reported) return
      reported = percent
      onProgress({ percent, done, total })
    })
  }
  return true
}

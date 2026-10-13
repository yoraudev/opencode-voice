import { createHash } from "node:crypto"
import { createWriteStream, mkdirSync, renameSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { CACHE_DIR, MODELS } from "./config.mjs"

export const MODELS_DIR = join(CACHE_DIR, "models")

const VAD = {
  name: "silero_vad.onnx",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
  size: 643854,
  sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
}

const TOKENS = { size: 816730, sha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126" }

const WHISPER = {
  tiny: {
    encoder: { size: 12937772, sha256: "d24fb083ae3b1041fc24e97971d60e280c9342201fbb67b0ab428a8b4a51a434" },
    decoder: { size: 89855401, sha256: "d2fece8dd42771f1df975c6c0445770d0c292bf7547c2cae04a6c0cc57540925" },
  },
  base: {
    encoder: { size: 29120534, sha256: "0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11" },
    decoder: { size: 130672026, sha256: "9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d" },
  },
  small: {
    encoder: { size: 112442483, sha256: "4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9" },
    decoder: { size: 262226114, sha256: "acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee" },
  },
  medium: {
    encoder: { size: 374196283, sha256: "1c54582b4d829de0089f6cb63bbbdb3bf7555398bacaf855fbecf1a84dfd193e" },
    decoder: { size: 571059257, sha256: "595d00a338a365a7bfa0ca7f296cabc639583bef770ab6130df90f49a6412747" },
  },
  "large-v3": {
    encoder: { size: 766671985, sha256: "d531cf17248acc43e8c09b472a0877055e770877857a5332fc1304b36534ec85" },
    decoder: { size: 1008265203, sha256: "ebc6bfd88e162a46cb3edee8a7e727e1dcbc65cabecb19e2573695e4d495e1af" },
  },
  turbo: {
    encoder: { size: 674716297, sha256: "b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b" },
    decoder: { size: 361080764, sha256: "20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547" },
  },
}

function whisperFiles(model) {
  const base = `https://huggingface.co/csukuangfj/sherpa-onnx-whisper-${model}/resolve/main`
  return [
    { name: `${model}-encoder.int8.onnx`, ...WHISPER[model].encoder },
    { name: `${model}-decoder.int8.onnx`, ...WHISPER[model].decoder },
    { name: `${model}-tokens.txt`, ...TOKENS },
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

export async function download(file, { dir, signal, onBytes = () => {}, request = fetch }) {
  const target = join(dir, file.name)
  const part = `${target}.part`
  const response = await request(file.url, { signal, redirect: "follow" })
  if (!response.ok || !response.body) throw new Error(`could not download ${file.name}: the server answered ${response.status}`)
  const out = createWriteStream(part)
  const hash = createHash("sha256")
  let size = 0
  try {
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > file.size) throw new Error(`${file.name} is larger than the ${file.size} bytes it should have`)
      hash.update(chunk)
      if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve))
      onBytes(chunk.length)
    }
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())))
    if (size !== file.size) throw new Error(`${file.name} was downloaded incompletely`)
    if (hash.digest("hex") !== file.sha256) throw new Error(`${file.name} does not match its checksum and was discarded`)
  } catch (error) {
    out.destroy()
    rmSync(part, { force: true })
    throw error
  }
  renameSync(part, target)
}

export async function ensure(model, { dir = MODELS_DIR, signal, onProgress = () => {}, request } = {}) {
  const missing = [...whisperFiles(model), VAD].filter((file) => !present(file, dir))
  if (missing.length === 0) return false
  mkdirSync(dir, { recursive: true })
  const total = missing.reduce((sum, file) => sum + file.size, 0)
  let done = 0
  let reported = -1
  for (const file of missing) {
    await download(file, {
      dir,
      signal,
      request,
      onBytes(bytes) {
        done += bytes
        const percent = Math.min(100, Math.floor((done / total) * 100))
        if (percent === reported) return
        reported = percent
        onProgress({ percent, done, total })
      },
    })
  }
  return true
}

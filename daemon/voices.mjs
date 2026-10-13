import { spawn } from "node:child_process"
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CACHE_DIR, VOICES } from "./config.mjs"

export const VOICES_DIR = join(CACHE_DIR, "voices")
const TYPICAL_BYTES = 67 * 1024 * 1024
const MARKER = ".complete"

const folder = (voice) => `vits-piper-${voice}`

export function voicePaths(voice, dir = VOICES_DIR) {
  const root = join(dir, folder(voice))
  return { root, model: join(root, `${voice}.onnx`), tokens: join(root, "tokens.txt"), dataDir: join(root, "espeak-ng-data") }
}

export function voiceCatalog(dir = VOICES_DIR) {
  return Object.entries(VOICES).map(([id, language]) => ({ id, language, bytes: TYPICAL_BYTES, downloaded: existsSync(join(dir, folder(id), MARKER)) }))
}

function unpack(archive, cwd) {
  return new Promise((resolve, reject) => {
    const tar = spawn("tar", ["-xjf", archive], { cwd, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] })
    let errors = ""
    tar.stderr.on("data", (chunk) => (errors += chunk))
    tar.on("error", (error) => reject(new Error(`could not run tar to unpack the voice: ${error.message}`)))
    tar.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar could not unpack the voice: ${errors.trim() || `exit code ${code}`}`))))
  })
}

export async function ensureVoice(voice, { dir = VOICES_DIR, signal, onProgress = () => {} } = {}) {
  const paths = voicePaths(voice, dir)
  if (existsSync(join(paths.root, MARKER))) return false
  mkdirSync(dir, { recursive: true })
  rmSync(paths.root, { recursive: true, force: true })
  const archive = `${folder(voice)}.tar.bz2`
  const response = await fetch(`https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${archive}`, { signal, redirect: "follow" })
  if (!response.ok || !response.body) throw new Error(`could not download the ${voice} voice: the server answered ${response.status}`)
  const total = Number(response.headers.get("content-length")) || TYPICAL_BYTES
  const out = createWriteStream(join(dir, archive))
  let done = 0
  let reported = -1
  try {
    for await (const chunk of response.body) {
      if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve))
      done += chunk.length
      const percent = Math.min(100, Math.floor((done / total) * 100))
      if (percent !== reported) onProgress({ percent: (reported = percent), done, total })
    }
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())))
    await unpack(archive, dir)
    writeFileSync(join(paths.root, MARKER), "")
  } catch (error) {
    out.destroy()
    rmSync(paths.root, { recursive: true, force: true })
    throw error
  } finally {
    rmSync(join(dir, archive), { force: true })
  }
  return true
}

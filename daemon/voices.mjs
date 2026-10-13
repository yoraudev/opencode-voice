import { spawn } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CACHE_DIR, VOICES } from "./config.mjs"
import { download } from "./models.mjs"

export const VOICES_DIR = join(CACHE_DIR, "voices")
const MARKER = ".complete"

const ARCHIVES = {
  "tr_TR-dfki-medium": { size: 67201221, sha256: "b63babaefcdd63202c7079aba25b72a2013825ad5895e2aeff03d1ae5a5b3bbf" },
  "tr_TR-fahrettin-medium": { size: 67212827, sha256: "2ee3c18b5dc0a5faf913f995b027163befa6e7a6ad2f5c6b8a2e99fe1aad8b6d" },
  "tr_TR-fettah-medium": { size: 67174342, sha256: "314a9910616fb17be882c77f0bcf76796a1914d4d606f3c984f9094cb9abf1e5" },
  "en_US-lessac-medium": { size: 67230653, sha256: "9e3febfacf0abf4270172d2958bcec246032b7e88efc2720840cc80c93de334e" },
  "en_US-amy-medium": { size: 67223746, sha256: "9a5d1fc497f85e8022b785bff5f8105203b1e33099ee6265203efc70b0cb0264" },
  "en_US-ryan-medium": { size: 67213100, sha256: "c546af78b6395b4e7c4ce1ed899438b64426a362f5d4ec5fecd090ded9ad7505" },
  "en_GB-alba-medium": { size: 67212349, sha256: "fcd45962906933eec4431d3688f7d74aaac8713c87c6717f91fd3b23463aa1a1" },
}

const folder = (voice) => `vits-piper-${voice}`

export function voicePaths(voice, dir = VOICES_DIR) {
  const root = join(dir, folder(voice))
  return { root, model: join(root, `${voice}.onnx`), tokens: join(root, "tokens.txt"), dataDir: join(root, "espeak-ng-data") }
}

export function voiceCatalog(dir = VOICES_DIR) {
  return Object.entries(VOICES).map(([id, language]) => ({ id, language, bytes: ARCHIVES[id].size, downloaded: existsSync(join(dir, folder(id), MARKER)) }))
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

export async function ensureVoice(voice, { dir = VOICES_DIR, signal, onProgress = () => {}, request, extract = unpack } = {}) {
  const paths = voicePaths(voice, dir)
  if (existsSync(join(paths.root, MARKER))) return false
  mkdirSync(dir, { recursive: true })
  rmSync(paths.root, { recursive: true, force: true })
  const archive = { name: `${folder(voice)}.tar.bz2`, ...ARCHIVES[voice] }
  archive.url = `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${archive.name}`
  let done = 0
  let reported = -1
  try {
    await download(archive, {
      dir,
      signal,
      request,
      onBytes(bytes) {
        done += bytes
        const percent = Math.min(100, Math.floor((done / archive.size) * 100))
        if (percent !== reported) onProgress({ percent: (reported = percent), done, total: archive.size })
      },
    })
    await extract(archive.name, dir)
    writeFileSync(join(paths.root, MARKER), "")
  } catch (error) {
    rmSync(paths.root, { recursive: true, force: true })
    throw error
  } finally {
    rmSync(join(dir, archive.name), { force: true })
  }
  return true
}

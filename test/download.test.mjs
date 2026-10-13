import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { VOICES } from "../daemon/config.mjs"
import { catalog, download, ensure } from "../daemon/models.mjs"
import { ensureVoice, voiceCatalog } from "../daemon/voices.mjs"

const folder = () => mkdtempSync(join(tmpdir(), "opencode-voice-"))
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")

function serving(bytes, status = 200) {
  const asked = []
  const request = async (url) => {
    asked.push(url)
    return new Response(status === 200 ? bytes : null, { status })
  }
  return { request, asked }
}

const content = Buffer.from("the bytes of a model")
const file = { name: "model.onnx", url: "https://example.test/model.onnx", size: content.length, sha256: sha256(content) }

test("a download with the right checksum is kept", async () => {
  const dir = folder()
  let bytes = 0
  await download(file, { dir, request: serving(content).request, onBytes: (count) => (bytes += count) })
  assert.deepEqual(readFileSync(join(dir, file.name)), content)
  assert.equal(bytes, content.length)
  assert.deepEqual(readdirSync(dir), [file.name])
})

test("a download with the right size and other content is discarded", async () => {
  const dir = folder()
  const forged = Buffer.from("THE BYTES OF A MODEL")
  await assert.rejects(download(file, { dir, request: serving(forged).request }), /does not match its checksum/)
  assert.deepEqual(readdirSync(dir), [])
})

test("a download that is too short or too long is discarded", async () => {
  const dir = folder()
  await assert.rejects(download(file, { dir, request: serving(content.subarray(0, 5)).request }), /incompletely/)
  await assert.rejects(download(file, { dir, request: serving(Buffer.concat([content, content])).request }), /is larger than/)
  assert.deepEqual(readdirSync(dir), [])
})

test("a refused download reports the server's answer", async () => {
  await assert.rejects(download(file, { dir: folder(), request: serving(null, 404).request }), /the server answered 404/)
})

test("a model whose files do not match their checksums is not installed", async () => {
  const dir = folder()
  const { request, asked } = serving(Buffer.from("not a model"))
  await assert.rejects(ensure("tiny", { dir, request }))
  assert.equal(asked.length, 1)
  assert.deepEqual(readdirSync(dir), [])
  assert.equal(catalog(dir).find((model) => model.id === "tiny").downloaded, false)
})

test("a voice archive that does not match its checksum is never unpacked", async () => {
  const dir = folder()
  let unpacked = false
  const extract = async () => (unpacked = true)
  await assert.rejects(ensureVoice("tr_TR-dfki-medium", { dir, request: serving(Buffer.from("not an archive")).request, extract }))
  assert.equal(unpacked, false)
  assert.deepEqual(readdirSync(dir), [])
  assert.equal(voiceCatalog(dir).find((voice) => voice.id === "tr_TR-dfki-medium").downloaded, false)
})

test("a voice folder left by an interrupted download is removed and fetched again", async () => {
  const dir = folder()
  mkdirSync(join(dir, "vits-piper-en_US-amy-medium"))
  const { request, asked } = serving(content)
  await assert.rejects(ensureVoice("en_US-amy-medium", { dir, request }))
  assert.equal(existsSync(join(dir, "vits-piper-en_US-amy-medium")), false)
  assert.equal(asked.length, 1)
})

test("every voice and every model has a size and a checksum", () => {
  for (const voice of voiceCatalog(folder())) assert.ok(voice.bytes > 60_000_000 && VOICES[voice.id], voice.id)
  assert.deepEqual(catalog(folder()).map((model) => model.id), ["tiny", "base", "small", "medium", "large-v3", "turbo"])
})

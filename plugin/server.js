import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"
import { CACHE_DIR, SPOKEN } from "../daemon/config.mjs"
import { createClient } from "./client.js"

export const TOOL = "speak"
const LANGUAGES = Object.keys(SPOKEN)
const NAMES = Object.entries(SPOKEN).map(([code, { name }]) => `"${code}" for ${name}`).join(", ")

export const INSTRUCTION = `<system-reminder>
The user spoke this message instead of typing it, and hears your reply through the \`${TOOL}\` tool.

Write your answer as usual. Then, as the very last thing you do in this turn, call \`${TOOL}\` exactly once with what you want to say aloud. It is separate from the written answer: one to three short sentences that tell the user the outcome, in plain spoken words, without code, file paths, markdown, lists or symbols. Set \`language\` to the language the spoken text is written in (${NAMES}); use the language the user spoke in when it is one of these. Write nothing after the call.
</system-reminder>`

export function remind(messages) {
  const index = messages.findLastIndex((message) => message.role === "user")
  if (index < 0) return
  const message = messages[index]
  const content = typeof message.content === "string" ? `${message.content}\n\n${INSTRUCTION}` : [...message.content, { type: "text", text: INSTRUCTION }]
  messages[index] = Object.assign(Object.create(Object.getPrototypeOf(message)), message, { content })
}

const speakTool = (say) => ({
  name: TOOL,
  description: "Says a short text aloud to the user through their speakers. Only available in a turn the user started by voice. Call it once, as the last action of the turn.",
  input: {
    type: "object",
    properties: {
      text: { type: "string", description: "What to say, in plain spoken sentences. No code, paths, markdown or symbols." },
      language: { type: "string", enum: LANGUAGES, description: `The language \`text\` is written in: ${NAMES}. It selects the voice.` },
    },
    required: ["text", "language"],
    additionalProperties: false,
  },
  options: { codemode: false },
  execute: async ({ text, language }) => {
    const answer = await say(text, language).catch((error) => ({ ok: false, reason: error.message }))
    return { content: answer.ok ? "Said aloud to the user." : `Not said aloud: ${answer.reason ?? answer.error}` }
  },
})

export function createVoice({ call, ready }) {
  const voiced = new Set()
  const enabled = () => call("config").then((config) => config.speak, () => false)

  return {
    tool: speakTool(async (text, language) => {
      await ready()
      return call("speak", { text, language })
    }),
    onPrompt(prompt) {
      if (prompt.metadata?.voice) voiced.add(prompt.sessionID)
      else voiced.delete(prompt.sessionID)
    },
    async onContext(context) {
      if (!voiced.has(context.sessionID) || !(await enabled())) {
        delete context.tools[TOOL]
        return
      }
      remind(context.messages)
    },
  }
}

export default Plugin.define({
  id: "opencode-voice",
  async setup(ctx) {
    const voice = createVoice(createClient(ctx.options))
    await ctx.tool.transform((editor) => editor.add(voice.tool))
    const debug = ctx.options.debug || process.env.OPENCODE_VOICE_DEBUG
    const note = (...parts) => debug && appendFileSync(join(CACHE_DIR, "plugin.log"), `${new Date().toISOString()} ${parts.join(" ")}\n`)
    await ctx.session.hook("prompt", (prompt) => {
      voice.onPrompt(prompt)
      note("prompt", prompt.sessionID, JSON.stringify(prompt.metadata))
    })
    await ctx.session.hook("context", async (context) => {
      await voice.onContext(context)
      note("context", context.sessionID, "messages", context.messages.length, "tools", Object.keys(context.tools).join(","))
    })
  },
})

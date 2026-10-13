import { Plugin } from "@opencode/plugin/tui"
import { Show, createSignal } from "solid-js"
import { createClient } from "./client.js"
import { isBusy, openSettings, statusLine } from "./settings.js"

const POLL_MS = 500
const KEPT_TEXT_TOAST_MS = 30000
const RED = "#e06c75"
const DIM = "#808080"

export default Plugin.define({
  id: "opencode-voice",
  setup(ctx) {
    const { call, ready, events } = createClient(ctx.options)
    const owner = `${process.pid}-${Math.random().toString(36).slice(2)}`
    const toggleKey = ctx.options.key ?? "alt+r"

    const [phase, setPhase] = createSignal("idle")
    const [status, setStatus] = createSignal()
    const [committed, setCommitted] = createSignal("")
    const [partial, setPartial] = createSignal("")
    let stream

    const say = (variant, message, duration) => ctx.ui.toast.show({ variant, title: "Voice", message, duration })

    const reset = () => {
      stream?.abort()
      stream = undefined
      setPhase("idle")
      setCommitted("")
      setPartial("")
    }

    const spoken = { voice: true }

    const submit = async (text) => {
      const route = ctx.ui.router.current()
      if (route.type === "session") return ctx.client.session.prompt({ sessionID: route.sessionID, text, metadata: spoken })
      const model = ctx.ui.model.current()
      const session = await ctx.client.session.create({
        location: ctx.location ?? ctx.data.location.default(),
        model: model && { id: model.modelID, providerID: model.providerID, variant: model.variant },
      })
      ctx.ui.router.navigate({ type: "session", sessionID: session.id })
      return ctx.client.session.prompt({ sessionID: session.id, text, metadata: spoken })
    }

    const onEvent = (event) => {
      if (event.type === "status") return setStatus(event.status)
      if (event.owner !== owner) return
      if (event.type === "listening") return setPhase("recording")
      if (event.type === "partial") {
        setCommitted(event.committed)
        setPartial(event.partial)
        return
      }
      if (event.type === "started") return
      reset()
      if (event.type === "error") return say("error", event.message)
      if (event.type !== "final") return
      if (!event.text) return say("info", "No speech was heard.")
      submit(event.text).catch((error) => say("error", `The prompt could not be sent: ${error.message}\n\n${event.text}`, KEPT_TEXT_TOAST_MS))
    }

    const begin = async () => {
      setPhase("starting")
      setStatus(undefined)
      const mine = new AbortController()
      stream = mine
      try {
        await ready()
        if (mine.signal.aborted) return
        await new Promise((resolve, reject) => {
          const stopped = (error) => {
            reject(error)
            if (stream !== mine) return
            reset()
            say("error", error.message)
          }
          events((event) => (resolve(), onEvent(event)), mine.signal).then(() => stopped(new Error("The voice daemon stopped.")), stopped)
        })
        await call("start", { owner })
      } catch (error) {
        if (stream !== mine) return
        reset()
        say("error", error.message)
      }
    }

    const toggle = () => {
      if (phase() === "idle") return void begin()
      call("stop", { owner }).catch(() => reset())
    }

    const cancel = () => {
      call("cancel", { owner }).catch(() => undefined)
      reset()
    }

    const watch = (initial) =>
      new Promise((resolve) => {
        const [shown, setShown] = createSignal(initial)
        const stop = () => {
          clearInterval(timer)
          resolve()
        }
        const timer = setInterval(async () => {
          const config = await call("config").catch(() => undefined)
          if (!config) return
          setShown(config.status)
          if (isBusy(config.status)) return
          stop()
          ctx.ui.dialog.clear()
        }, POLL_MS)
        ctx.ui.dialog.show(
          () => (
            <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
              <text>Voice</text>
              <text>{statusLine(shown())}</text>
              <text>Models and voices are downloaded once and then run on this computer. Press esc for the settings.</text>
            </box>
          ),
          stop,
        )
      })

    const shortcut = () => ctx.keymap.shortcuts("voice.toggle")[0] ?? toggleKey
    const hint = () => {
      if (phase() === "recording") return `● Listening. ${shortcut()} sends, esc cancels`
      return isBusy(status()) ? statusLine(status()) : "Starting the microphone…"
    }

    const click = (event) => {
      event.stopPropagation()
      toggle()
    }

    const Button = () => (
      <box onMouseDown={(event) => event.stopPropagation()} onMouseUp={click}>
        <text fg={phase() === "idle" ? undefined : RED}>{phase() === "idle" ? `🎙 voice ${shortcut()}` : phase() === "recording" ? "● REC" : "● …"}</text>
      </box>
    )

    const Transcript = () => (
      <Show when={phase() !== "idle"}>
        <box flexDirection="column" paddingLeft={2} paddingRight={2}>
          <text fg={RED}>{hint()}</text>
          <Show when={committed()}>
            <text>{committed()}</text>
          </Show>
          <Show when={partial()}>
            <text fg={DIM}>{partial()}</text>
          </Show>
        </box>
      </Show>
    )

    const slots = [
      ctx.ui.slot({ append: "prompt.footer.status", render: Button }),
      ctx.ui.slot({ append: "session.composer.top", render: Transcript }),
      ctx.ui.slot({ prepend: "home.footer", render: Transcript }),
    ]

    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "voice.toggle",
          title: "Voice: record a prompt",
          description: "Start recording; run again to stop and send what was said",
          group: "Voice",
          bind: toggleKey,
          palette: true,
          slash: { name: "voice" },
          run: toggle,
        },
        {
          id: "voice.cancel",
          title: "Voice: cancel the recording",
          group: "Voice",
          enabled: () => phase() !== "idle",
          bind: "escape",
          run: cancel,
        },
        {
          id: "voice.quiet",
          title: "Voice: stop speaking",
          description: "Cut off the reply that is being spoken",
          group: "Voice",
          bind: false,
          palette: true,
          slash: { name: "voice-quiet" },
          run: () => void call("quiet", {}).catch(() => undefined),
        },
        {
          id: "voice.settings",
          title: "Voice settings",
          description: "Change the model, language, microphone, spoken replies and their voices",
          group: "Voice",
          bind: false,
          palette: true,
          slash: { name: "voice-settings" },
          run: () => void openSettings({ dialog: ctx.ui.dialog, toast: ctx.ui.toast, call, ready, watch }),
        },
      ],
    }))

    return () => {
      if (phase() !== "idle") cancel()
      slots.forEach((release) => release())
    }
  },
})

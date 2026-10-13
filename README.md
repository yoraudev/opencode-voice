# OpenCode Voice

Speak your prompts in OpenCode 2 and hear the answer. A record button and a shortcut start the microphone, the text appears above the prompt while you speak, and when you stop speaking it is sent to the model. After a spoken prompt the model also says a short reply aloud, in Turkish or English.

Speech is recognized with Whisper and spoken with Piper voices, both on your own computer. Works on Windows, Linux and macOS.

| | Languages |
| --- | --- |
| Speaking a prompt | Whisper's 99 languages |
| Spoken replies | Turkish and English only |

> [!WARNING]
> **What the microphone hears is sent to your agent as a prompt, without you reading it first.** Read this before installing.
>
> A recording ends by itself once you have been silent for two seconds, and the recognized text goes straight to the model. The agent then acts on it with whatever permissions you have given it.
>
> What can go wrong:
>
> - **Misheard prompts.** The recognizer makes mistakes, more of them with the smaller models, with short sentences, with technical terms and when languages are mixed. A wrong word can change what you asked for, and you cannot edit the text before it is sent.
> - **Other voices and sounds.** Anything near the microphone is recognized: another person talking, a video, a call. It becomes part of your prompt, or a prompt of its own if a recording is running.
> - **Text that leaves your machine.** The audio stays on your computer, but the recognized text is a normal prompt and goes to your model's provider like anything you type.
> - **Replies that others hear.** Spoken replies are played on your speakers. The model chooses what to say and may mention what it worked on.
> - **A model that skips the spoken reply.** Whether the model calls the tool that speaks is up to the model. Weaker models sometimes do not, and then the turn is silent.
> - **Anything local can call the daemon.** It listens only on your own machine and refuses requests from web pages, but any program running under your user account can start a recording, speak a text or change the settings.
>
> How to lower the risk:
>
> - Keep your agent's permission prompts on, so that a misheard prompt cannot do damage on its own.
> - Watch the live text while you speak and press `esc` when it is wrong; that discards the recording.
> - Set your language in the settings instead of leaving it on automatic detection.
> - Use a larger model if the text is often wrong, and a headset in a room where others talk.
> - Turn spoken replies off where others should not hear them.
>
> You use this at your own risk; see [LICENSE](LICENSE).

## Install

Requires OpenCode 2 and Node.js 18 or later on the `PATH`. Runs on Windows x64, Linux x64 and arm64, and macOS x64 and arm64.

Download the package from the latest release and unpack it, or clone the repository. Then:

```bash
npm install
```

Add the `plugin` directory to `opencode.jsonc`, with its full path:

```jsonc
{
  "plugins": ["/full/path/to/opencode-voice/plugin"]
}
```

Restart OpenCode. The footer of the prompt shows `🎙 voice alt+r`.

The first recording downloads the `small` recognition model (358 MB), and the first spoken reply in a language downloads its voice (about 67 MB). Both show their progress and are kept in `~/.cache/opencode-voice`.

## Use

| Action | How |
| --- | --- |
| Start recording | `alt+r`, click `🎙 voice` in the prompt footer, or `/voice` |
| Send | Stop speaking for two seconds, or press `alt+r` or click `● REC` |
| Cancel without sending | `esc` |
| Stop the spoken reply | Start a recording, or `/voice-quiet` |
| Settings | `/voice-settings`, or "Voice settings" in the command palette |

The text you have said so far is shown above the prompt. The part still being spoken is gray and may change until you pause.

On the home screen the prompt starts a new session with the model selected there.

Sounds that are not speech, which Whisper writes as `(music)` or `[applause]`, are left out. A recording that contains nothing else sends nothing.

## Spoken replies

When a prompt was spoken, the model gets a `speak` tool for that turn and is asked to call it once at the end with what it wants to say aloud. This is separate from the written answer: the model chooses a few plain sentences for the ear, without code or paths. Typed prompts are answered in writing only.

**Spoken replies support only Turkish and English.** Recognition understands all of Whisper's 99 languages, but there are voices for these two alone. With each call the model names the language of the spoken text, `tr` or `en`, and the voice set for that language is used. If you speak in another language, your prompt is still recognized and answered in writing, and the spoken reply comes in Turkish or English.

## Settings

`/voice-settings` opens a menu. The values are stored in `~/.config/opencode-voice/config.json`.

| Setting | Default | Meaning |
| --- | --- | --- |
| Model | `small` | `tiny`, `base`, `small`, `medium`, `large-v3` or `turbo`. Larger models make fewer mistakes and take longer. A model is downloaded the first time it is selected. |
| Language | Detect automatically | One of Whisper's 99 languages. Speech is written in the language it is spoken in, never translated. |
| Microphone | System default | The input device. |
| Silence before sending (ms) | `2000` | How long you must be silent after speaking before the prompt is sent. |
| Processor threads | `4` | Threads the model may use. |
| Spoken replies | on | Whether the model answers a spoken prompt aloud. Turkish and English only. |
| Turkish voice | `tr_TR-dfki-medium` | Also `tr_TR-fahrettin-medium`, `tr_TR-fettah-medium`. |
| English voice | `en_US-lessac-medium` | Also `en_US-amy-medium`, `en_US-ryan-medium`, `en_GB-alba-medium`. |

| Model | Download |
| --- | --- |
| `tiny` | 99 MB |
| `base` | 153 MB |
| `small` | 358 MB |
| `medium` | 902 MB |
| `large-v3` | 1.7 GB |
| `turbo` | 989 MB |

The plugin itself takes options in `opencode.jsonc`:

```jsonc
{
  "plugins": [{ "package": "/full/path/to/opencode-voice/plugin", "options": { "key": "ctrl+shift+r" } }]
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `key` | `alt+r` | The shortcut that starts and ends a recording. |
| `port` | `7718` | The daemon's port. The environment variable `OPENCODE_VOICE_PORT` sets it too. |
| `node` | `node` | The Node.js executable that runs the daemon. |
| `debug` | off | Appends what the plugin saw of each prompt, without its text, to `~/.cache/opencode-voice/plugin.log`. |

## Good to know

- The models run on the processor. On a 6-core desktop processor `small` updates the live text about once a second; `medium` and larger fall behind the speaker and suit short prompts better.
- The live text is shown above the prompt, not in it, and cannot be edited before it is sent.
- A recording that hears no speech for 30 seconds ends without sending anything, and any recording ends after 5 minutes.
- Models and voices are downloaded from Hugging Face and from the sherpa-onnx releases on GitHub. Each download is checked against a SHA-256 checksum that is part of this project, and a file that does not match is discarded.
- The plugin starts a small daemon that owns the microphone and the models. It exits after 10 minutes without use, and its log is `~/.cache/opencode-voice/daemon.log`.
- macOS asks for microphone access for the terminal on the first recording. Linux needs ALSA (`libasound2`) and `tar` with bzip2.
- Developed and tested on Windows 11. The audio and recognition libraries ship binaries for Linux and macOS and the project has no platform-specific code, but it has not been run there yet.
- If nothing is heard, run `npm run mic` in this directory. It listens without OpenCode and prints the text.

## Development

```bash
npm test
npm run mic -- --wav speech.wav --language en
```

The second command reads a 16 kHz mono WAV file instead of the microphone. How the pieces fit together is described in [docs/architecture.md](docs/architecture.md). Every push to `main` publishes a new release.

## License

Free to use, modify and redistribute, as long as the original author stays credited and the project is not presented as someone else's own. See [LICENSE](LICENSE).

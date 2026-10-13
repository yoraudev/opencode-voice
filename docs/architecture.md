# Architecture

OpenCode Voice has two runtime parts: a plugin that OpenCode loads, and a daemon the plugin starts.

```
OpenCode terminal UI ──HTTP + event stream 127.0.0.1:7718──> daemon ──> microphone, speakers, Whisper, Piper
OpenCode server      ──HTTP 127.0.0.1:7718──────────────────> daemon
```

| Directory | Runs in | Role |
| --- | --- | --- |
| `plugin/` | OpenCode (terminal UI process and server process) | The record button, the live text, the shortcuts, the settings menu, the `speak` tool and the hooks that offer it |
| `daemon/` | Node.js | Owns the microphone, the speakers, the recognition model and the voices |

OpenCode runs plugins inside its own executable, which cannot load native libraries. Everything that needs one is therefore in the daemon, a separate Node.js process.

## Daemon

`daemon/server.mjs` exports `createDaemon`, which holds the state and handles the requests, and starts an HTTP server on `127.0.0.1` when it is run directly. Everything that touches the machine (the microphone, the speakers, the model, the voices, the downloads and the settings file) is passed to `createDaemon` as an argument, so the tests run it without any of them.

The daemon exits after 10 minutes in which it received no request and neither recorded, spoke nor loaded a model. If its port is already in use it exits at once, because another daemon is serving the requests.

| Endpoint | What it does |
| --- | --- |
| `GET /health` | Answers `{ ok, protocol }` without a token |
| `GET /events` | A server-sent event stream. The first event is the current `status` |
| `GET /config` | The settings, the status, the lists of models, voices and microphones, and whether a recording is running |
| `POST /config` | Changes settings. Refused during a recording |
| `POST /prepare` | Downloads and loads the recognition model now |
| `POST /start` | Starts a recording for `owner`. Answers 409 when one is running |
| `POST /stop` | Ends the owner's recording and transcribes what was said |
| `POST /cancel` | Ends the owner's recording and discards it |
| `POST /speak` | Speaks `text` with the voice set for `language` |
| `POST /quiet` | Cuts off the reply that is being spoken |
| `POST /shutdown` | Exits the daemon |

A request with an `Origin` header is refused, and every endpoint except `/health` needs the token in the `x-voice-token` header. A browser always sends `Origin` on a cross-site request and cannot set the header without a preflight, so a web page can reach neither the microphone nor the event stream. The daemon creates the token on its first start and keeps it in `~/.cache/opencode-voice/token`, readable only by the user where the file system supports it.

Request bodies are joined as bytes before they are decoded, because a character of a spoken reply may be split between two chunks.

### Events

| Event | Sent when |
| --- | --- |
| `status` | The state of the recognition model or of a voice changes: `idle`, `downloading` with a percentage, `loading`, `ready` or `error` |
| `started` | A recording was accepted and the model is being prepared |
| `listening` | The microphone is open |
| `partial` | The text changed. `committed` is final, `partial` is the sentence still being spoken |
| `final` | The recording ended. `text` is what was said and may be empty |
| `cancelled` | The recording was discarded |
| `error` | The recording failed |

Every event of a recording carries the `owner` given to `/start`. A window ignores events of other owners.

While a voice is downloaded or loaded, `status` describes the voice instead of the recognition model, and returns to the model's state when the voice is ready.

### Settings

`daemon/config.mjs` reads and writes `~/.config/opencode-voice/config.json`. A stored value that is unknown or fails validation falls back to its default. The file is written to a temporary name and renamed.

`PROTOCOL` in the same file is raised when the daemon's API changes. A client that finds a running daemon reporting another number asks it to shut down and starts the current one, so an update takes effect without the user stopping anything.

`OPENCODE_VOICE_PORT` sets the port for both the daemon and the plugin, `OPENCODE_VOICE_CACHE` the cache directory and `OPENCODE_VOICE_CONFIG` the settings file.

### Models

`daemon/models.mjs` lists the Whisper models with the exact size and the SHA-256 checksum of each file. A model consists of an encoder, a decoder and a token list from `huggingface.co/csukuangfj/sherpa-onnx-whisper-<model>`, plus the Silero VAD model from the sherpa-onnx releases, all stored in `~/.cache/opencode-voice/models`.

`download` in the same file is the only way a file enters the cache. It writes to a `.part` file while it hashes the bytes, stops as soon as more bytes arrive than the file should have, and renames the file only when both its size and its checksum match. Anything else is deleted and reported as an error, which the settings menu and the recording show.

`daemon/voices.mjs` lists the Piper voices with the size and checksum of each archive. A voice is a `.tar.bz2` archive from the sherpa-onnx releases. It is downloaded with the same `download`, so an archive that does not match its checksum is never unpacked. A matching archive is unpacked into `~/.cache/opencode-voice/voices` with the system's `tar`, which Windows 10, macOS and Linux include. `tar` is given the archive's name relative to its working directory, because GNU tar reads a path like `C:\…` as a host name. A `.complete` file is written after a voice was unpacked, so an interrupted download is not mistaken for a voice.

The checksums were taken from Hugging Face's file metadata and from the digests GitHub publishes for release assets. They pin the files as they were when the checksums were recorded: if a file is replaced upstream, its download fails until the checksum here is updated.

A model file that is already in the cache counts as present when it has the listed size, and a voice when its `.complete` file exists. Checksums are checked on download, not each time a file is loaded.

### Recording

`daemon/session.mjs` is one recording. It reads frames of 512 samples at 16 kHz from the microphone, the window Silero VAD works on, and passes them to the speech detector.

Whisper does not stream. While the detector reports speech, the session transcribes the unfinished segment again every half second for the `partial` text, and once more when the detector closes the segment, for the committed text. The audio for a live transcription includes the 0.3 seconds before the detector reported speech, so the first syllable is not missing. A segment is at most 15 seconds long, since Whisper takes 30 seconds at once and shorter segments keep the live text responsive.

Transcriptions run one at a time and in order. A live transcription is skipped when one is still running, and dropped when its segment closed while it waited. The first transcription that fails ends the recording with an `error`.

The recording ends by itself when the speaker has been silent for `silenceMs` after saying something. The detector itself waits half a second before it closes a segment, and that time counts toward the limit. Silence is counted in samples, not on the clock, so a slow transcription does not shorten it. A recording that hears no speech ends after 30 seconds with empty text, and any recording ends after 5 minutes, so that the microphone is not left open.

`stop` flushes the detector, so a segment that is still being spoken is transcribed too. `cancel` discards everything. In every case the microphone is released.

Whisper describes sounds that are not speech, such as `(music)`, `[applause]` or `*sighs*`, and does so for background noise. `spokenOnly` in `daemon/recognizer.mjs` removes text in round brackets, square brackets and asterisks and musical notes from every transcription, so that a prompt contains only what was said.

Only one recording runs at a time.

### Speaking

`daemon/speaker.mjs` splits a text into sentences and generates them one after another, so that the first is heard while the rest is still being generated. Samples are written to the output device in the amount its buffer takes, with a short wait in between. The library's blocking `flush` is not used, because the daemon could not be asked to stop while it blocks.

A voice is loaded on its first use and kept. A new text replaces the one being spoken. Starting a recording cuts speech off, because the microphone would hear it, and `/speak` is refused while a recording runs.

Selecting a voice in the settings, or turning spoken replies on, downloads the voice right away, which keeps the download out of the first spoken reply.

## Plugin

OpenCode loads the plugin from one directory. It finds the directory through `server.js`; a directory with only `tui.jsx` is skipped without a message.

`plugin/client.js` calls the daemon for both halves. `ready` starts the daemon as a detached Node.js process when `/health` does not answer, at most once every 15 seconds, and waits up to 20 seconds for it. The daemon's output goes to `~/.cache/opencode-voice/daemon.log`, which is moved to `daemon.log.1` when it passes 5 MB. A call that is answered with 401 reads the token file again, because the daemon may have written it after the client was created.

### Terminal UI plugin

`plugin/tui.jsx` is the only file with JSX. OpenCode compiles it when it loads the plugin and supplies `solid-js` and the OpenTUI elements, so the project has no build step.

It claims three places in OpenCode's slot tree:

| Slot | Content |
| --- | --- |
| `prompt.footer.status` | The button: `🎙 voice` with the shortcut, `● …` while the daemon and the model get ready, `● REC` while recording |
| `session.composer.top` | The live text above the prompt in a session |
| `home.footer` | The live text on the home screen |

The prompt and its footer are also shown on the home screen, so one button serves both.

The button acts when the mouse button is released. Its label changes width when a recording starts; acting on the press would let the release land on the footer's working directory menu.

A window moves from `idle` to `starting` to `recording` and back. On a toggle it makes sure the daemon runs, opens the event stream, waits for the daemon's first `status` event and only then posts `/start`, so that no event of the recording is missed. The stream is closed when the recording ends.

On `final` with text the window sends the prompt with `client.session.prompt` and the metadata `{ voice: true }`. On the home screen it first creates a session with the model selected there and navigates to it. If sending fails, the text is shown in a toast so that it is not lost. The plugin API has no way to put text into the prompt box, which is why the live text is shown above it and cannot be edited.

The commands are registered in the `global` keymap mode: `voice.toggle` (`alt+r`, `/voice`), `voice.cancel` (`escape`, only while a recording runs), `voice.quiet` (`/voice-quiet`) and `voice.settings` (`/voice-settings`).

`plugin/settings.js` is the settings menu. It is plain logic over the host's dialogs and has no OpenCode imports. It shows every setting with its current value, asks for the new value with a second select dialog or a text prompt, posts it to `/config` and reports the result in a toast, then shows the list again until it is closed. While a model or a voice is downloaded or loaded it shows the `watch` dialog from `tui.jsx`, which polls `/config` twice a second and updates one line in place.

### Server plugin

`plugin/server.js` adds the `speak` tool and two session hooks.

| Hook | What it does |
| --- | --- |
| `session` `prompt` | Remembers the session as spoken when the prompt carries `{ voice: true }`, and forgets it on a typed prompt |
| `session` `context` | For a spoken session with spoken replies turned on, appends the instruction to the last user message of the request. Otherwise removes `speak` from the request's tools |

The instruction is added to the request to the model, not to the stored session. It asks the model to write its answer as usual and then call `speak` once, as the last action of the turn, with one to three plain sentences and the language they are written in. A separate system part with the same text was ignored by the model it was tried with; next to the user's message it was followed.

`speak` takes `text` and `language`, which is `tr` or `en`. It is registered with `codemode: false`, so the model calls it directly and not through OpenCode's code tool. It posts to `/speak` and tells the model whether the text was said aloud; it does not wait for the playback.

With the `debug` option or `OPENCODE_VOICE_DEBUG` set, the hooks append the session, the prompt's metadata and the names of the offered tools to `~/.cache/opencode-voice/plugin.log`. Prompt text is not written.

## Releases

Every push to `main` runs `.github/workflows/release.yml`. It runs the tests, takes the major and minor version from `package.json`, sets the patch to one more than the highest existing tag of that line, packs the files listed in `package.json` with `npm pack` and publishes the archive as a GitHub release.

## Tests

`npm test` runs the files in `test/` with `node:test`. `test/fakes.mjs` replaces the microphone with a list of frames and the speech detector with one that treats every non-silent frame as speech, so a recording is written as a string such as `..SSSS...SS`. The daemon tests start `createDaemon` on a free port with every device and model replaced, and the client and settings tests run the plugin's `client.js`, `settings.js` and `server.js` against it.

`test/download.test.mjs` serves bytes in place of the network and checks that only a file with the right size and checksum is kept, and that a voice archive that does not match is never unpacked.

`npm run mic` runs the real recognition without OpenCode, from the microphone or, with `--wav`, from a 16 kHz mono WAV file played at real-time speed. `--model`, `--language` and `--silence` override the saved settings for that run.

The terminal UI has no automated test.

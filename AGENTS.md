# OpenCode Voice

## Tech Stack

- **Language:** JavaScript (ES modules)
- **Runtime:** Node.js (daemon), OpenCode's plugin runtime (plugin)
- **Layout:** `daemon/` (local service), `plugin/` (the OpenCode 2 plugin: `server.js`, `tui.jsx` and what they share), `scripts/`, `test/`, `docs/`
- **Speech recognition:** Whisper (multilingual, int8 ONNX) and Silero VAD through `sherpa-onnx-node`, on CPU
- **Speech output:** Piper voices (VITS) through `sherpa-onnx-node`, Turkish and English
- **Audio devices:** `@picovoice/pvrecorder-node` (microphone), `@picovoice/pvspeaker-node` (speakers)
- **Daemon ↔ plugin transport:** HTTP with JSON bodies and a server-sent event stream on `127.0.0.1`
- **OpenCode plugin:** `@opencode/plugin` 2.x (Promise plugin API for the `speak` tool and the session hooks, terminal UI plugin API with Solid JSX for the button, the live text and the settings command)
- **Tests:** `node:test` with the microphone, the speakers, the speech detector and the models replaced
- **CI / releases:** GitHub Actions

## Project Rules

- Every file in the repository is written in English: code, identifiers, user-facing strings, documentation and commit messages. The only exception is sample sentences in other languages inside `test/`, which exist to test multilingual text.
- Commit messages follow Conventional Commits: `type(scope): description`, with types such as `feat`, `fix`, `chore`, `docs`, `refactor`, `test` and `ci`. Mark breaking changes with `!` after the type. Keep the subject line short and make it the best single description of the change; put the details in the commit body, written out in full.
- Commits, pull requests and anything else published to the repository carry only the repository owner's name and email. Never add AI or tool attribution: no `Co-Authored-By` trailers, no "Generated with" lines, no assistant names as author or committer.
- Do not write comments. Every hand-written file (anything that is not auto-generated) stays free of code comments, including config files such as YAML and `.gitattributes`.
- Whenever something is added to, changed in, or removed from the project, every `.md` file that references it must be updated in the same change.

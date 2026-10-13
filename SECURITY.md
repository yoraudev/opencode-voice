# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately, not in a public issue.

Open the repository's **Security** tab on GitHub and click **Report a vulnerability**. This sends a private report that only the maintainer can see.

Include what you can of the following:

- what the vulnerability allows an attacker to do
- the steps or a proof of concept to reproduce it
- the release version, the OpenCode version, the recognition model and the operating system you tested with

You will get a reply once the report has been reviewed. Please give the maintainer a reasonable amount of time to release a fix before disclosing the issue publicly.

## Supported versions

Only the latest release receives security fixes.

## What counts as a vulnerability

Examples of issues that should be reported:

- a web page or another origin reaching the daemon's HTTP endpoints from a browser, for example to turn on the microphone or to read the event stream
- bypassing the token check or the `Origin` check on the daemon
- the daemon listening on anything other than `127.0.0.1`
- the microphone staying open after a recording has ended, was cancelled or failed
- audio or recognized text being written to disk or sent anywhere other than to the OpenCode window that started the recording
- a model file or a voice archive being accepted although its checksum does not match the one in `daemon/models.mjs` or `daemon/voices.mjs`
- a downloaded model or voice archive writing files outside `~/.cache/opencode-voice`
- the `speak` tool being offered to the model in a turn the user did not start by voice

## What does not

The following are known properties of the tool, described in the [README](README.md), and are not treated as vulnerabilities:

- the recognizer mishearing speech, or writing down voices and sounds that were not meant as a prompt
- a prompt being sent without review once the speaker has been silent for the configured time
- a model acting on a misheard prompt, or not calling the `speak` tool
- spoken replies being audible to people near the speakers
- a file that is already in `~/.cache/opencode-voice` being changed by other software running under the same user account; checksums are checked when a file is downloaded, not each time it is loaded
- other software running under the same user account calling the local daemon, including to start a recording, speak a text or change the settings

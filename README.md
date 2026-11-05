# Wispr Flow Voice Input for DeepSeek Harness

Adds a microphone between the model selector and Send in the DeepSeek Harness
Web UI. Recording happens in the browser; the Host sends the WAV to your own
Wispr Flow account and inserts the formatted transcript into the message draft
for review.

This is a native Harness plugin: it registers a cloud `SpeechProvider` with the
Host speech-to-text registry, so no browser automation, clipboard paste or
keyboard injection is involved.

> Unofficial community integration. Not affiliated with, endorsed by, or
> supported by Wispr Flow.

## Requirements

- Wispr Flow desktop app installed and logged in
  (`~/.config/Wispr Flow/session.json`). The app must have been opened at least
  once; if the token expires, open Wispr Flow once and try again.
- The Harness Web UI on loopback (`127.0.0.1`) or HTTPS, so the browser allows
  microphone capture.
- Network access to `https://api.wisprflow.ai`.

## Install

This repository is a DeepSeek Harness profile bundle.

```bash
git clone https://github.com/ssalentin/dsh-wispr-flow.git
```

Install the checkout directory with Harness's plugin manager: call
`install_bundle` with the absolute path (for example
`/home/you/code/dsh-wispr-flow`), or use the Plugins UI if your build supports
installing a local bundle directory.

The bundle inserts the speech service, this provider, the speech Remote and the
browser microphone UI. After installation the microphone appears in the
composer; choose the recognition language in the plugin details (default:
automatic).

## How it works

1. The browser records the microphone and produces canonical 16 kHz mono PCM16
   WAV.
2. The speech Remote validates it and calls `ctx.speechToText.transcribe`.
3. This package sends `POST /llm/api` with the audio, the selected language and
   your personal dictionary, authenticated by the desktop app session.
4. The formatted `text` is returned and inserted into the composer draft.

## Configuration

Row `speech-to-text-wispr-flow`:

| Key | Default | Meaning |
| --- | --- | --- |
| `providerId` | `wispr-flow` | Registry id; keep in sync with `speech-to-text.defaultProvider` |
| `providerName` | `Wispr Flow` | Label shown in plugin settings |
| `baseUrl` | `https://api.wisprflow.ai` | API origin |
| `timeoutMs` | `60000` | Request deadline |
| `includeDictionary` | `true` | Use the desktop app's personal dictionary and user name |
| `appType` | `other` | Writing context: `other`, `ai` or `email` |

Language selection is owned by the `speech-to-text` row (`language: auto` by
default, i.e. server-side detection). Provider and language can also be changed
from the plugin details in the Web UI.

## Privacy

The access token is read on the Host for each request and never reaches the
browser. Audio is sent only to the configured Wispr Flow origin, is not stored
by this plugin, and only the transcript is returned. The personal dictionary is
read locally and cached in memory for five minutes.

## Limitations

- Uses an undocumented Wispr Flow endpoint, the same one the desktop client
  falls back to; a service change can break it.
- Complete recordings only, no streaming partials. The speech Remote limits a
  recording to 4 MB / 120 seconds.
- macOS and Windows session paths are detected, but only Linux was exercised.
- The access token comes from the desktop app; this plugin cannot refresh it.

## Files

| Path | Purpose |
| --- | --- |
| `index.js` | Host `SpeechProvider`: session token, request, dictionary, WAV duration |
| `cordis.patch.yml` | Composes the speech service, provider, Remote and browser UI |
| `locale/` | Plugin Manager title and description |
| `icon.svg` | Bundle artwork |

/**
 * Host half of Wispr Flow voice input.
 *
 * Registers one cloud recognizer with `ctx.speechToText`. The browser half
 * records the microphone and hands a canonical 16 kHz mono PCM16 WAV to the
 * Host; this module sends that recording to the Wispr Flow backend through the
 * same REST endpoint the desktop client uses as its fallback path, and returns
 * the formatted transcript.
 *
 * Authentication reuses the session the Wispr Flow desktop app already wrote:
 * the SDK never creates or refreshes a login. The access token stays in this
 * process and is never logged or sent to the browser.
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_PROVIDER_ID = 'wispr-flow';
const DEFAULT_PROVIDER_NAME = 'Wispr Flow';
const DEFAULT_BASE_URL = 'https://api.wisprflow.ai';
const DEFAULT_TIMEOUT_MS = 60_000;
const DICTIONARY_CACHE_MS = 5 * 60_000;
const DICTIONARY_LIMIT = 200;

/** Writing contexts accepted by the transcription endpoint. */
const APP_TYPES = new Set(['ai', 'email', 'other']);

/** Language hints forwarded to Wispr Flow; `auto` lets the service detect it. */
export const LANGUAGES = [
  'auto',
  'en', 'engb', 'enca', 'zh', 'zhcn', 'de', 'dech', 'es', 'ru', 'ko', 'fr', 'ja', 'pt', 'tr',
  'pl', 'ca', 'nl', 'ar', 'sv', 'it', 'id', 'hi', 'hien', 'fi', 'vi', 'he', 'uk', 'el', 'ms',
  'cs', 'ro', 'da', 'hu', 'ta', 'no', 'th', 'ur', 'hr', 'bg', 'lt', 'la', 'mi', 'ml', 'cy',
  'sk', 'te', 'fa', 'lv', 'bn', 'sr', 'az', 'sl', 'kn', 'et', 'mk', 'br', 'eu', 'is', 'hy',
  'ne', 'mn', 'bs', 'kk', 'sq', 'sw', 'gl', 'mr', 'pa', 'si', 'km', 'sn', 'yo', 'so', 'af',
  'oc', 'ka', 'be', 'tg', 'sd', 'gu', 'am', 'yi', 'lo', 'uz', 'fo', 'ht', 'ps', 'tk', 'nn',
  'mt', 'sa', 'lb', 'my', 'bo', 'tl', 'mg', 'as', 'tt', 'haw', 'ln', 'ha', 'ba', 'jv', 'su',
  'yue',
];

export const name = 'wispr-flow';
export const inject = ['speechToText'];

/** Directory holding session.json, config.json and flow.sqlite for this platform. */
function configDirectory() {
  if (process.env.WISPR_FLOW_CONFIG_DIR) return process.env.WISPR_FLOW_CONFIG_DIR;
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Wispr Flow');
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Wispr Flow');
  }
  return join(homedir(), '.config', 'Wispr Flow');
}

function parseJson(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Decode a JWT expiry without verifying the signature. */
function tokenExpiry(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof claims.exp === 'number' ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read every usable access token from the desktop app session, newest first.
 * WorkOS tokens take precedence over the legacy Supabase session.
 */
export async function readAccessTokens(directory = configDirectory()) {
  let session;
  try {
    session = JSON.parse(await readFile(join(directory, 'session.json'), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        'Wispr Flow is not signed in on this machine. Open Wispr Flow and log in once, then try again.',
      );
    }
    throw new Error(`Unable to read the Wispr Flow session: ${error?.message ?? String(error)}`);
  }

  const candidates = [];
  const workos = parseJson(session.workosSession);
  if (typeof workos?.accessToken === 'string' && workos.accessToken) {
    candidates.push({ token: workos.accessToken, source: 'workos' });
  }
  for (const [key, value] of Object.entries(session)) {
    if (!key.endsWith('-auth-token')) continue;
    const auth = parseJson(value);
    if (typeof auth?.access_token === 'string' && auth.access_token) {
      candidates.push({ token: auth.access_token, source: 'supabase' });
      break;
    }
  }
  if (candidates.length === 0) {
    throw new Error(
      'No Wispr Flow access token was found in session.json. Open Wispr Flow and log in again.',
    );
  }

  const now = Date.now();
  return candidates
    .map((candidate) => ({ ...candidate, expiresAt: tokenExpiry(candidate.token) }))
    .sort((a, b) => Number(b.expiresAt ?? 0) - Number(a.expiresAt ?? 0))
    .map((candidate) => ({ ...candidate, expired: candidate.expiresAt !== undefined && candidate.expiresAt <= now }));
}

/** Seconds of audio in a canonical PCM16 WAV; 0 when the header is unreadable. */
export function wavSeconds(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes?.buffer ?? bytes, bytes?.byteOffset ?? 0, bytes?.byteLength);
  if (buffer.length < 44) return 0;
  try {
    let offset = 12;
    let sampleRate = 0;
    let channels = 0;
    let bits = 0;
    let dataBytes = 0;
    while (offset + 8 <= buffer.length) {
      const id = buffer.toString('ascii', offset, offset + 4);
      const size = buffer.readUInt32LE(offset + 4);
      const body = offset + 8;
      if (id === 'fmt ' && size >= 16) {
        channels = buffer.readUInt16LE(body + 2);
        sampleRate = buffer.readUInt32LE(body + 4);
        bits = buffer.readUInt16LE(body + 14);
      } else if (id === 'data') {
        dataBytes = Math.min(size, Math.max(0, buffer.length - body));
        break;
      }
      offset = body + size + (size % 2);
    }
    const bytesPerFrame = channels * (bits / 8);
    if (!sampleRate || !bytesPerFrame || !dataBytes) return 0;
    return dataBytes / (sampleRate * bytesPerFrame);
  } catch {
    return 0;
  }
}

let dictionaryCache = { at: 0, directory: undefined, values: [] };

/** Personal vocabulary from the desktop app; a missing or locked database is not an error. */
async function personalDictionary(directory, limit) {
  const now = Date.now();
  if (dictionaryCache.directory === directory && now - dictionaryCache.at < DICTIONARY_CACHE_MS) {
    return dictionaryCache.values;
  }
  const values = [];
  try {
    const config = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'));
    const user = config?.prefs?.user ?? config?.user ?? {};
    for (const value of [user.firstName, user.lastName, user.email]) {
      if (typeof value === 'string' && value.trim()) values.push(value.trim());
    }
  } catch {
    // Personalization is optional.
  }
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(join(directory, 'flow.sqlite'), { readOnly: true });
    try {
      const rows = database
        .prepare(
          "SELECT phrase FROM Dictionary WHERE isDeleted = 0 AND phrase IS NOT NULL AND phrase != '' ORDER BY frequencyUsed DESC LIMIT ?",
        )
        .all(limit);
      for (const row of rows) {
        if (typeof row.phrase === 'string' && row.phrase.trim()) values.push(row.phrase.trim());
      }
    } finally {
      database.close();
    }
  } catch {
    // The app may not be installed here, or the WAL files may be unavailable.
  }
  const unique = [...new Set(values)].slice(0, limit);
  dictionaryCache = { at: now, directory, values: unique };
  return unique;
}

function summarizeError(payload, fallback) {
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.detail)) {
      const messages = payload.detail
        .map((item) => (typeof item?.msg === 'string' ? item.msg : typeof item === 'string' ? item : ''))
        .filter(Boolean);
      if (messages.length > 0) return messages.join('; ').slice(0, 300);
    }
    for (const key of ['detail', 'message', 'error']) {
      const value = payload[key];
      if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 300);
      if (value && typeof value === 'object' && typeof value.message === 'string') {
        return value.message.trim().slice(0, 300);
      }
    }
  }
  if (typeof payload === 'string' && payload.trim()) return payload.trim().slice(0, 300);
  return fallback;
}

function normalizeOptions(config = {}) {
  return {
    providerId: typeof config.providerId === 'string' && config.providerId ? config.providerId : DEFAULT_PROVIDER_ID,
    providerName:
      typeof config.providerName === 'string' && config.providerName ? config.providerName : DEFAULT_PROVIDER_NAME,
    baseUrl:
      typeof config.baseUrl === 'string' && config.baseUrl ? config.baseUrl.replace(/\/+$/, '') : DEFAULT_BASE_URL,
    timeoutMs:
      Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS,
    includeDictionary: config.includeDictionary !== false,
    language: typeof config.language === 'string' ? config.language : 'auto',
  };
}

/**
 * Transcribe one canonical recording with the signed-in Wispr Flow account.
 *
 * @param input - `audio` holds WAV bytes; `language` is a Wispr hint or `auto`.
 * @param signal - caller cancellation.
 * @param config - optional deployment overrides.
 * @returns the formatted transcript and measured durations.
 */
export async function transcribeAudio(input, signal, config = {}) {
  const options = normalizeOptions(config);
  signal?.throwIfAborted();
  const bytes = Buffer.isBuffer(input?.audio) ? input.audio : Buffer.from(input?.audio ?? []);
  if (bytes.length < 44) throw new Error('The recording is empty. Hold the microphone a little longer.');

  const directory = configDirectory();
  const tokens = await readAccessTokens(directory);
  const fresh = tokens.filter((token) => !token.expired);
  const usable = fresh.length > 0 ? fresh : tokens;

  const language = input.language && input.language !== 'auto' ? input.language : '';
  const dictionary = options.includeDictionary
    ? await personalDictionary(directory, Number.isFinite(config.dictionaryLimit) ? config.dictionaryLimit : DICTIONARY_LIMIT)
    : [];

  const payload = {
    audio: bytes.toString('base64'),
    properties: {
      app_type: APP_TYPES.has(config.appType) ? config.appType : 'other',
      language,
      before_text: '',
      after_text: '',
      selected_text: '',
      dictionary,
    },
    transcript_id: randomUUID(),
  };

  const timeout = AbortSignal.timeout(options.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const startedAt = Date.now();
  let lastAuthFailure;

  for (const candidate of usable) {
    combined.throwIfAborted();
    let response;
    try {
      response = await fetch(`${options.baseUrl}/llm/api`, {
        method: 'POST',
        headers: {
          Authorization: candidate.token,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'Wispr Flow/1.6.1337',
        },
        body: JSON.stringify(payload),
        signal: combined,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (timeout.aborted) {
        throw new Error(`Wispr Flow did not answer within ${Math.round(options.timeoutMs / 1000)} seconds.`);
      }
      throw new Error(`Could not reach Wispr Flow: ${error?.cause?.code ?? error?.message ?? String(error)}`);
    }

    if (response.status === 401 || response.status === 403) {
      lastAuthFailure = response.status;
      continue;
    }

    const raw = await response.text();
    let parsed;
    try {
      parsed = raw ? JSON.parse(raw) : undefined;
    } catch {
      parsed = raw;
    }

    if (!response.ok) {
      throw new Error(
        `Wispr Flow transcription failed (HTTP ${response.status}): ${summarizeError(parsed, response.statusText || 'request rejected')}`,
      );
    }

    const text =
      typeof parsed?.text === 'string'
        ? parsed.text
        : typeof parsed?.content === 'string'
          ? parsed.content
          : typeof parsed?.formatted_text === 'string'
            ? parsed.formatted_text
            : '';
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error('Wispr Flow returned no text. Try speaking a little longer or closer to the microphone.');
    }
    return {
      text: trimmed,
      audioSeconds: wavSeconds(bytes),
      inferenceSeconds: (Date.now() - startedAt) / 1000,
    };
  }

  if (lastAuthFailure === 401 || lastAuthFailure === 403) {
    throw new Error(
      'Wispr Flow rejected the saved session. Open Wispr Flow once so it can refresh the login, then try again.',
    );
  }
  throw new Error('No usable Wispr Flow session was found. Open Wispr Flow and log in once, then try again.');
}

/**
 * Mount the recognizer. The registry reports this cloud provider as ready
 * because it has no local preparation step.
 *
 * @param ctx - Host context with the speech registry.
 * @param config - row configuration.
 */
export function apply(ctx, config = {}) {
  const options = normalizeOptions(config);
  ctx.effect(() => {
    const dispose = ctx.speechToText.register({
      info: {
        id: options.providerId,
        name: options.providerName,
        location: 'cloud',
        languages: Array.isArray(config.languages) && config.languages.length > 0 ? config.languages : LANGUAGES,
      },
      transcribe: (input, signal) => transcribeAudio(input, signal, { ...options, ...config }),
    });
    return async () => {
      await dispose();
    };
  });
}

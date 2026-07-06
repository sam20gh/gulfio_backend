/**
 * Azure Speech (neural TTS) client — REST based, no SDK dependency.
 *
 * Authenticates the synthesis call directly with the subscription key
 * (Ocp-Apim-Subscription-Key). This is more robust than the token-exchange
 * flow for custom-domain / Azure AI Foundry resources, whose region STS
 * endpoint often rejects the generic issueToken request.
 *
 * Env:
 *   AZURE_SPEECH_KEY      - subscription key (Key 1 from the resource)
 *   AZURE_SPEECH_REGION   - region short code, e.g. "uaenorth", "swedencentral"
 *   AZURE_SPEECH_ENDPOINT - (optional) full TTS host override, e.g.
 *                           "https://<region>.tts.speech.microsoft.com".
 *                           Defaults to the region-based host.
 */

const axios = require('axios');

const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION;
const AZURE_SPEECH_ENDPOINT = process.env.AZURE_SPEECH_ENDPOINT;

// Azure caps a single synthesis request at 10 minutes of audio. Keep SSML text
// chunks well below that; ~3000 chars is far under the limit for any language.
const MAX_CHARS_PER_REQUEST = 3000;

// MP3 at 24kHz/48kbps mono — good speech quality, small files (~0.36 MB/min).
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

function assertConfigured() {
  if (!AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION) {
    throw new Error('Azure Speech not configured (AZURE_SPEECH_KEY / AZURE_SPEECH_REGION)');
  }
}

// Region-based TTS host unless an explicit endpoint override is provided.
function getTtsUrl() {
  const base = (AZURE_SPEECH_ENDPOINT || `https://${AZURE_SPEECH_REGION}.tts.speech.microsoft.com`)
    .replace(/\/+$/, '');
  return `${base}/cognitiveservices/v1`;
}

// XML-escape text before embedding in SSML.
function escapeSsml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSsml({ text, voice, locale, rate }) {
  const prosody =
    rate && rate !== 1
      ? `<prosody rate="${Math.round((rate - 1) * 100)}%">${escapeSsml(text)}</prosody>`
      : escapeSsml(text);
  return (
    `<speak version="1.0" xml:lang="${locale}">` +
    `<voice name="${voice}">${prosody}</voice>` +
    `</speak>`
  );
}

async function synthesizeChunk({ text, voice, locale, rate }) {
  assertConfigured();
  const ssml = buildSsml({ text, voice, locale, rate });
  const res = await axios.post(getTtsUrl(), ssml, {
    headers: {
      'Ocp-Apim-Subscription-Key': AZURE_SPEECH_KEY,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': OUTPUT_FORMAT,
      'User-Agent': 'gulfio-tts',
    },
    responseType: 'arraybuffer',
    timeout: 30_000,
  });
  return Buffer.from(res.data);
}

/**
 * Split text at sentence boundaries (incl. Arabic ؟ / Urdu ۔) into chunks under
 * the per-request limit. Exposed for testing.
 */
function chunkText(text, limit = MAX_CHARS_PER_REQUEST) {
  const sentences = text.match(/[^.!?؟۔…]+[.!?؟۔…]*\s*/g) || [text];
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    if (sentence.length > limit) {
      if (current.trim()) {
        chunks.push(current.trim());
        current = '';
      }
      for (let i = 0; i < sentence.length; i += limit) {
        const piece = sentence.slice(i, i + limit).trim();
        if (piece) chunks.push(piece);
      }
      continue;
    }
    if (current.length + sentence.length > limit) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/**
 * Synthesize full text to a single MP3 buffer, chunking transparently.
 * MP3 frames are concatenable — players read the joined stream as one track.
 */
async function synthesize({ text, voice, locale, rate = 1 }) {
  assertConfigured();
  const chunks = chunkText(text);
  const buffers = [];
  for (const chunk of chunks) {
    buffers.push(await synthesizeChunk({ text: chunk, voice, locale, rate }));
  }
  return Buffer.concat(buffers);
}

function isConfigured() {
  return Boolean(AZURE_SPEECH_KEY && AZURE_SPEECH_REGION);
}

module.exports = {
  synthesize,
  chunkText,
  buildSsml,
  escapeSsml,
  isConfigured,
  getTtsUrl,
  MAX_CHARS_PER_REQUEST,
  OUTPUT_FORMAT,
};

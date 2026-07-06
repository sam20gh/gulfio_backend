/**
 * TTS audio orchestration: article -> cleaned text -> Azure neural MP3 -> R2.
 *
 * Cost control (Track 2, phase 1): audio is generated ON DEMAND and only for
 * NEW articles (publishedAt >= TTS_AUDIO_ENABLED_FROM). Old back-catalog
 * articles are never generated — the app falls back to on-device TTS for them.
 *
 * Env:
 *   TTS_AUDIO_ENABLED_FROM - ISO date; articles published before this are skipped.
 *                            Defaults to the process start time (i.e. "from now on").
 *   TTS_MONTHLY_CHAR_CAP   - optional hard cap on billed chars/month (safety valve).
 *   AWS_S3_BUCKET / AWS_S3_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
 *
 * Storage is AWS S3 (bucket `blipsbucket`, me-central-1) — the same client the
 * current thumbnail/video paths use (services/ThumbnailGenerator.js). Audio is
 * served publicly via a bucket policy on the `audio/tts/*` prefix, mirroring the
 * public `thumbnails/*` prefix (no per-object ACL, no signed-URL refresh needed).
 */

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const azureTTS = require('./azureTTS');

const AWS_S3_REGION = process.env.AWS_S3_REGION || 'me-central-1';
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET || 'blipsbucket';

// Default cutoff: the moment the server started. Anything scraped/published
// from now on is eligible; the historical catalog is not.
const ENABLED_FROM = process.env.TTS_AUDIO_ENABLED_FROM
  ? new Date(process.env.TTS_AUDIO_ENABLED_FROM)
  : new Date();

const MONTHLY_CHAR_CAP = process.env.TTS_MONTHLY_CHAR_CAP
  ? parseInt(process.env.TTS_MONTHLY_CHAR_CAP, 10)
  : null;

// language (as stored on Article.language) -> Azure neural voice + locale.
// Gulf-dialect Arabic; fa/ur have no on-device fallback so they matter most.
const VOICE_MAP = {
  english: { voice: 'en-GB-RyanNeural', locale: 'en-GB', rate: 1 },
  arabic: { voice: 'ar-AE-FatimaNeural', locale: 'ar-AE', rate: 1 },
  farsi: { voice: 'fa-IR-DilaraNeural', locale: 'fa-IR', rate: 1 },
  persian: { voice: 'fa-IR-DilaraNeural', locale: 'fa-IR', rate: 1 },
  urdu: { voice: 'ur-PK-UzmaNeural', locale: 'ur-PK', rate: 1 },
};

function getVoiceSettings(language) {
  return VOICE_MAP[(language || 'english').toLowerCase()] || VOICE_MAP.english;
}

let _s3 = null;
function getS3() {
  if (!_s3) {
    _s3 = new S3Client({
      region: AWS_S3_REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return _s3;
}

// Strip markdown / embeds / URLs so the synthesizer reads clean prose.
// Mirror of the app-side cleanTextForSpeech (context/TTSPlayerContext.tsx).
function cleanTextForSpeech(text) {
  if (!text) return '';
  let cleaned = text;
  cleaned = cleaned.replace(/^#{1,6}\s+/gm, '');
  cleaned = cleaned.replace(/(\*\*|__)(.*?)\1/g, '$2');
  cleaned = cleaned.replace(/(\*|_)(.*?)\1/g, '$2');
  cleaned = cleaned.replace(/\[([^\]]+)]\([^)]+\)/g, '$1');
  cleaned = cleaned.replace(/https?:\/\/[^\s]+/g, '');
  cleaned = cleaned.replace(/www\.[^\s]+/g, '');
  cleaned = cleaned.replace(/!\[([^\]]*)\]\([^)]+\)/g, '');
  cleaned = cleaned.replace(/<[^>]+>/g, '');
  cleaned = cleaned.replace(/```[\s\S]*?```/g, '');
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');
  // Social embed markers emitted by the scraper
  cleaned = cleaned.replace(/\[(INSTAGRAM_EMBED|TWITTER_EMBED)\][^\n]*/g, '');
  cleaned = cleaned.replace(/^[*\-+]\s+/gm, '');
  cleaned = cleaned.replace(/^>\s+/gm, '');
  cleaned = cleaned.replace(/^[-*]{3,}$/gm, '');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  cleaned = cleaned.replace(/\s{2,}/g, ' ');
  cleaned = cleaned.replace(/[#*[\]()]/g, '');
  cleaned = cleaned.replace(/;\s*$/gm, '.');
  return cleaned.trim();
}

function buildSpeechText(article) {
  const title = cleanTextForSpeech(article.title || '');
  const content = cleanTextForSpeech(article.content || '');
  if (title && content) return `${title}. ${content}`;
  return content || title || '';
}

// ~150 wpm baseline, adjusted for rate; Arabic/Farsi read a touch slower but
// this is only a display estimate, refined client-side against real playback.
function estimateDuration(text, rate = 1) {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.round((words / 150) * 60 / (rate || 1));
}

function isEligible(article) {
  if (!article.publishedAt) return false;
  return new Date(article.publishedAt).getTime() >= ENABLED_FROM.getTime();
}

async function uploadMp3(key, buffer) {
  await getS3().send(
    new PutObjectCommand({
      Bucket: AWS_S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: 'audio/mpeg',
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );
  // Virtual-hosted-style public URL (matches ThumbnailGenerator). Requires the
  // `audio/tts/*` prefix to be public in the bucket policy.
  return `https://${AWS_S3_BUCKET}.s3.${AWS_S3_REGION}.amazonaws.com/${key}`;
}

// Rolling monthly billed-char counter (in-memory; resets on deploy — a soft
// guard, not accounting). Prevents a runaway from generating unbounded spend.
let monthKey = null;
let monthChars = 0;
function trackAndCheckCap(chars) {
  const now = new Date();
  const key = `${now.getUTCFullYear()}-${now.getUTCMonth()}`;
  if (key !== monthKey) {
    monthKey = key;
    monthChars = 0;
  }
  if (MONTHLY_CHAR_CAP && monthChars + chars > MONTHLY_CHAR_CAP) {
    return false;
  }
  monthChars += chars;
  return true;
}

// Dedupe concurrent requests for the same article so we synthesize once.
const inFlight = new Map();

/**
 * Return cached audio, or generate it on demand for an eligible article.
 *
 * @returns {Promise<{ status, audio? }>}
 *   status: 'ready'        -> audio present (cached or freshly generated)
 *           'not_eligible' -> old article; app should use on-device TTS
 *           'empty'        -> no readable text
 *           'disabled'     -> Azure not configured / monthly cap hit
 */
async function getOrCreateArticleAudio(article, { save = true } = {}) {
  if (article.audio && article.audio.url) {
    return { status: 'ready', audio: article.audio };
  }
  if (!isEligible(article)) {
    return { status: 'not_eligible' };
  }
  if (!azureTTS.isConfigured()) {
    return { status: 'disabled' };
  }

  const id = String(article._id);
  if (inFlight.has(id)) return inFlight.get(id);

  const work = (async () => {
    const text = buildSpeechText(article);
    if (!text) return { status: 'empty' };

    if (!trackAndCheckCap(text.length)) {
      console.warn('⚠️ TTS monthly char cap reached — skipping generation for', id);
      return { status: 'disabled' };
    }

    const { voice, locale, rate } = getVoiceSettings(article.language);
    const mp3 = await azureTTS.synthesize({ text, voice, locale, rate });
    const key = `audio/tts/${id}.mp3`;
    const url = await uploadMp3(key, mp3);

    const audio = {
      url,
      duration: estimateDuration(text, rate),
      voice,
      charCount: text.length,
      generatedAt: new Date(),
    };

    if (save) {
      // Persist without touching the rest of the doc.
      article.audio = audio;
      await article.save();
    }
    console.log(
      `🔊 Generated TTS audio for ${id} (${text.length} chars, ${voice}) -> ${url}`
    );
    return { status: 'ready', audio };
  })();

  inFlight.set(id, work);
  try {
    return await work;
  } finally {
    inFlight.delete(id);
  }
}

module.exports = {
  getOrCreateArticleAudio,
  cleanTextForSpeech,
  buildSpeechText,
  estimateDuration,
  getVoiceSettings,
  isEligible,
  VOICE_MAP,
  ENABLED_FROM,
  // test seam
  _internals: { trackAndCheckCap },
};

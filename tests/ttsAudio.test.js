/**
 * TTS audio unit tests (pure logic — no Azure, no Mongo, no network).
 * Run: node tests/ttsAudio.test.js
 */

// Ensure a deterministic cutoff for eligibility tests.
process.env.TTS_AUDIO_ENABLED_FROM = '2026-01-01T00:00:00.000Z';

const azureTTS = require('../utils/azureTTS');
const ttsAudio = require('../utils/ttsAudio');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log('  ✓', msg);
  } else {
    failed++;
    console.error('  ✗', msg);
  }
}

console.log('cleanTextForSpeech');
{
  const out = ttsAudio.cleanTextForSpeech(
    '# Title\n**bold** and [link](http://x.com) and ![img](http://y.com/a.png)\n[INSTAGRAM_EMBED] https://instagram.com/p/abc\nBody text.'
  );
  assert(!out.includes('http'), 'strips URLs');
  assert(!out.includes('INSTAGRAM_EMBED'), 'strips embed markers');
  assert(!out.includes('**') && !out.includes('#'), 'strips markdown syntax');
  assert(out.includes('Body text.'), 'keeps prose');
}

console.log('buildSpeechText');
{
  assert(
    ttsAudio.buildSpeechText({ title: 'T', content: 'C' }) === 'T. C',
    'joins title and content'
  );
  assert(ttsAudio.buildSpeechText({ title: '', content: '' }) === '', 'empty when no text');
}

console.log('getVoiceSettings');
{
  assert(ttsAudio.getVoiceSettings('arabic').locale === 'ar-AE', 'arabic -> ar-AE (Gulf)');
  assert(ttsAudio.getVoiceSettings('farsi').locale === 'fa-IR', 'farsi -> fa-IR');
  assert(ttsAudio.getVoiceSettings('persian').locale === 'fa-IR', 'persian -> fa-IR');
  assert(ttsAudio.getVoiceSettings('urdu').locale === 'ur-PK', 'urdu -> ur-PK');
  assert(ttsAudio.getVoiceSettings('klingon').locale === 'en-GB', 'unknown -> english');
}

console.log('isEligible (cutoff = 2026-01-01)');
{
  assert(ttsAudio.isEligible({ publishedAt: '2026-06-01' }) === true, 'new article eligible');
  assert(ttsAudio.isEligible({ publishedAt: '2025-06-01' }) === false, 'old article not eligible');
  assert(ttsAudio.isEligible({}) === false, 'no publishedAt -> not eligible');
}

console.log('estimateDuration');
{
  const words = Array(150).fill('word').join(' ');
  assert(ttsAudio.estimateDuration(words, 1) === 60, '150 words @ rate 1 ≈ 60s');
  assert(ttsAudio.estimateDuration('', 1) === 0, 'empty -> 0');
}

console.log('azureTTS.chunkText');
{
  assert(azureTTS.chunkText('One. Two. Three.').length === 1, 'short text -> single chunk');
  const long = Array(400).fill('This is a fairly long sentence for testing.').join(' ');
  const chunks = azureTTS.chunkText(long);
  assert(chunks.length > 1, 'long text -> multiple chunks');
  assert(
    chunks.every((c) => c.length <= azureTTS.MAX_CHARS_PER_REQUEST),
    'every chunk under per-request limit'
  );
  const runOn = 'word '.repeat(2000);
  assert(
    azureTTS.chunkText(runOn).every((c) => c.length <= azureTTS.MAX_CHARS_PER_REQUEST),
    'run-on sentence hard-split under limit'
  );
}

console.log('azureTTS SSML');
{
  assert(
    azureTTS.escapeSsml('a & b < c > "d" \'e\'') === 'a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos;',
    'escapes XML entities'
  );
  const ssml = azureTTS.buildSsml({ text: 'Hi', voice: 'ar-AE-FatimaNeural', locale: 'ar-AE', rate: 1 });
  assert(ssml.includes('ar-AE-FatimaNeural') && ssml.includes('xml:lang="ar-AE"'), 'SSML has voice + locale');
}

console.log('getOrCreateArticleAudio guards (no network)');
(async () => {
  // Cached audio returns immediately without generating.
  const cached = await ttsAudio.getOrCreateArticleAudio({
    _id: '1',
    audio: { url: 'https://cdn/x.mp3', duration: 30 },
  });
  assert(cached.status === 'ready' && cached.audio.url === 'https://cdn/x.mp3', 'returns cached audio');

  // Old article: not eligible, no generation attempted.
  const old = await ttsAudio.getOrCreateArticleAudio({ _id: '2', publishedAt: '2020-01-01' });
  assert(old.status === 'not_eligible', 'old article -> not_eligible (no generation)');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

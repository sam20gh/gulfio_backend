/**
 * Azure Speech live smoke test — validates the real credentials, region, and
 * our four neural voice names by synthesizing a short phrase in each.
 *
 * Usage:
 *   1. Put AZURE_SPEECH_KEY and AZURE_SPEECH_REGION in backend/.env
 *      (REGION is the short code, e.g. "uaenorth" — NOT the full endpoint URL).
 *   2. node tests/azureTTS.smoke.js
 *
 * Writes each sample to backend/tmp/tts-smoke-<lang>.mp3 so you can listen and
 * judge voice quality/dialect before deploying.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const azureTTS = require('../utils/azureTTS');
const { getVoiceSettings } = require('../utils/ttsAudio');

const SAMPLES = {
  english: 'This is a Gulfio news update, read by a neural voice.',
  arabic: 'هذا تحديث إخباري من جلفيو، بصوت اصطناعي عصبي.',
  farsi: 'این یک خبر کوتاه از گلفیو است که با صدای مصنوعی خوانده می‌شود.',
  urdu: 'یہ گلفیو کی ایک مختصر خبر ہے جو مصنوعی آواز میں پڑھی جا رہی ہے۔',
};

(async () => {
  if (!azureTTS.isConfigured()) {
    console.error('❌ AZURE_SPEECH_KEY / AZURE_SPEECH_REGION not set in backend/.env');
    process.exit(1);
  }
  console.log('Region:', process.env.AZURE_SPEECH_REGION);

  const outDir = path.join(__dirname, '..', 'tmp');
  fs.mkdirSync(outDir, { recursive: true });

  let ok = 0;
  let fail = 0;
  for (const [lang, text] of Object.entries(SAMPLES)) {
    const { voice, locale, rate } = getVoiceSettings(lang);
    try {
      const buf = await azureTTS.synthesize({ text, voice, locale, rate });
      const file = path.join(outDir, `tts-smoke-${lang}.mp3`);
      fs.writeFileSync(file, buf);
      console.log(`  ✓ ${lang.padEnd(8)} ${voice.padEnd(22)} ${buf.length} bytes -> ${file}`);
      ok++;
    } catch (e) {
      const status = e.response?.status;
      const body = e.response?.data ? Buffer.from(e.response.data).toString().slice(0, 200) : '';
      console.error(`  ✗ ${lang.padEnd(8)} ${voice.padEnd(22)} ${status || ''} ${e.message} ${body}`);
      fail++;
    }
  }

  console.log(`\n${ok} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

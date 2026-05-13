const axios = require('axios');
const sharp = require('sharp');
const { encode } = require('blurhash');

async function generateBlurhash(imageUrl) {
    if (!imageUrl) return null;
    try {
        const { data } = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            timeout: 8000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        const { data: pixels, info } = await sharp(Buffer.from(data))
            .resize(32, 32, { fit: 'inside' })
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

        return encode(new Uint8ClampedArray(pixels), info.width, info.height, 4, 3);
    } catch (err) {
        console.warn(`⚠️ Blurhash generation failed for ${imageUrl}:`, err.message);
        return null;
    }
}

module.exports = { generateBlurhash };

// Very quick test with a shorter video (the 40-second one we saw)
require('dotenv').config();
const mongoose = require('mongoose');
const { youtube } = require('btch-downloader');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { https } = require('follow-redirects');

const s3 = new S3Client({
    region: process.env.AWS_S3_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

async function quickS3Test() {
    console.log('⚡ Ultra-quick S3 test with short video...\n');
    
    // Use the short video we saw in the logs (40 seconds)
    const shortVideoId = 'nLINrlaH-oc'; // The ~40 second video
    const youtubeUrl = `https://youtube.com/watch?v=${shortVideoId}`;
    
    try {
        console.log(`🎬 Testing with short video: ${youtubeUrl}`);
        
        // Extract download URL
        console.log('⬇️ Extracting download URL...');
        const result = await youtube(youtubeUrl);
        const rawUrl = result.mp4;
        
        if (!rawUrl) {
            console.error('❌ No download URL found');
            return;
        }
        
        console.log('✅ Download URL extracted');
        console.log(`📊 URL length: ${rawUrl.length} characters`);
        
        // Download and upload to S3
        console.log('☁️ Testing S3 upload...');
        
        const filename = `test-quick-${Date.now()}.mp4`;
        
        const downloadPromise = new Promise((resolve, reject) => {
            https.get(rawUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                },
                maxRedirects: 5,
            }, async (res) => {
                if (res.statusCode !== 200) {
                    return reject(new Error(`Download failed: ${res.statusCode}`));
                }

                const chunks = [];
                let totalBytes = 0;
                
                res.on('data', (chunk) => {
                    chunks.push(chunk);
                    totalBytes += chunk.length;
                });
                
                res.on('end', async () => {
                    console.log(`📦 Downloaded ${totalBytes} bytes`);
                    
                    const buffer = Buffer.concat(chunks);
                    const command = new PutObjectCommand({
                        Bucket: process.env.AWS_S3_BUCKET,
                        Key: filename,
                        Body: buffer,
                        ContentType: 'video/mp4',
                        // No ACL specified
                    });

                    try {
                        await s3.send(command);
                        const url = `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_S3_REGION}.amazonaws.com/${filename}`;
                        console.log('✅ S3 upload successful!');
                        console.log(`🔗 S3 URL: ${url}`);
                        resolve(url);
                    } catch (uploadErr) {
                        console.error('❌ S3 upload failed:', uploadErr.message);
                        reject(uploadErr);
                    }
                });
            }).on('error', reject);
        });
        
        await downloadPromise;
        console.log('\n🎉 SUCCESS! The RSS-based scraper with S3 upload is working!');
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
    }
}

quickS3Test();

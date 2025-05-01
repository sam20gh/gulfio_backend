// utils/sendExpoNotification.js
const { Expo } = require('expo-server-sdk');

// Create a single Expo SDK client
const expo = new Expo();

/**
 * Send push notifications via Expo Push API
 * @param {string} title
 * @param {string} body
 * @param {string[]} tokens  Array of Expo push tokens
 */
async function sendExpoNotification(title, body, tokens = []) {
    // Build valid messages
    const messages = tokens
        .filter(t => Expo.isExpoPushToken(t))
        .map(token => ({
            to: token,
            sound: 'default',
            title,
            body,
            data: { title, body },
        }));

    // Chunk into batches (max 100 per request)
    const chunks = expo.chunkPushNotifications(messages);

    for (const chunk of chunks) {
        try {
            const receipts = await expo.sendPushNotificationsAsync(chunk);
            console.log('Expo notification receipts:', receipts);
        } catch (err) {
            console.error('Error sending Expo notifications:', err);
        }
    }
}

module.exports = sendExpoNotification;

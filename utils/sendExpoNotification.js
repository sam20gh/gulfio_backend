// utils/sendExpoNotification.js
const { Expo } = require('expo-server-sdk');

// Create a single Expo SDK client
const expo = new Expo();

/**
 * Send push notifications via Expo Push API
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {string[]} tokens - Array of Expo push tokens
 * @param {Object} data - Additional data to include in the notification
 * @param {Array} actions - Action buttons for the notification
 */
async function sendExpoNotification(title, body, tokens = [], data = {}, actions = []) {
    // Build valid messages
    const messages = tokens
        .filter(t => Expo.isExpoPushToken(t))
        .map(token => {
            const message = {
                to: token,
                sound: 'default',
                title,
                body,
                data: {
                    title,
                    body,
                    ...data
                },
            };

            // Add image if provided
            if (data.imageUrl) {
                message.image = data.imageUrl;
            }

            // Add category identifier for actions (iOS)
            if (actions && actions.length > 0) {
                message.categoryId = 'article_notification';
            }

            return message;
        });

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

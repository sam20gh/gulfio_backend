// utils/sendExpoNotification.js
const { Expo } = require('expo-server-sdk');
const User = require('../models/User');

// Create a single Expo SDK client
const expo = new Expo();

/**
 * Remove a stale/invalid push token from all users in the DB.
 * Called when Expo returns DeviceNotRegistered for a token.
 */
async function removeInvalidToken(token) {
    try {
        await User.updateMany(
            { $or: [{ pushToken: token }, { 'pushTokens.token': token }] },
            {
                $unset: { pushToken: '' },
                $pull: { pushTokens: { token } },
            }
        );
        console.log(`🗑️ Removed invalid push token: ${token.slice(0, 30)}...`);
    } catch (err) {
        console.error('Error removing invalid token:', err.message);
    }
}

/**
 * Send push notifications via Expo Push API
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {string[]} tokens - Array of Expo push tokens
 * @param {Object} data - Additional data to include in the notification
 * @param {Array} actions - Action buttons for the notification
 * @returns {string[]} Array of receipt IDs (for deferred receipt checking)
 */
async function sendExpoNotification(title, body, tokens = [], data = {}, actions = []) {
    const validTokens = tokens.filter(t => Expo.isExpoPushToken(t));

    if (validTokens.length === 0) {
        console.warn('⚠️ sendExpoNotification: no valid Expo push tokens provided');
        return [];
    }

    const messages = validTokens.map(token => {
        const message = {
            to: token,
            sound: 'default',
            title,
            body,
            data: { title, body, ...data },
        };

        if (data.imageUrl) {
            message.image = data.imageUrl;
        }

        if (actions && actions.length > 0) {
            message.categoryId = 'article_notification';
        }

        return message;
    });

    const chunks = expo.chunkPushNotifications(messages);
    const ticketIds = [];

    for (const chunk of chunks) {
        try {
            const tickets = await expo.sendPushNotificationsAsync(chunk);

            for (let i = 0; i < tickets.length; i++) {
                const ticket = tickets[i];
                const token = chunk[i].to;

                if (ticket.status === 'error') {
                    console.error(`❌ Push ticket error for token ${token.slice(0, 30)}...:`, ticket.message, ticket.details);

                    if (ticket.details?.error === 'DeviceNotRegistered') {
                        // Token is invalid — remove it from the DB immediately
                        removeInvalidToken(token);
                    }
                } else if (ticket.id) {
                    ticketIds.push(ticket.id);
                }
            }
        } catch (err) {
            console.error('Error sending Expo notifications:', err);
        }
    }

    return ticketIds;
}

module.exports = sendExpoNotification;

# Notification System Documentation

## Overview
This notification system respects user notification settings and sends push notifications via Expo based on user preferences.

## User Notification Settings

Each user has the following notification settings that can be individually toggled:

```javascript
{
    newsNotifications: true,      // General news notifications
    userNotifications: true,      // User interactions (likes, replies, etc.)
    breakingNews: true,          // Breaking news alerts
    weeklyDigest: false,         // Weekly digest notifications
    followedSources: true,       // Notifications from followed sources
    articleLikes: true,          // When someone likes user's article
    newFollowers: true,          // When someone follows the user
    mentions: true               // When user is mentioned in comments/replies
}
```

## API Endpoints

### User Notification Settings

#### Get current notification settings
```
GET /api/users/notification-settings
Authorization: Bearer <token>
```

#### Update notification settings
```
PATCH /api/users/notification-settings
Authorization: Bearer <token>
Content-Type: application/json

{
    "notificationSettings": {
        "newsNotifications": true,
        "userNotifications": false,
        "breakingNews": true,
        "weeklyDigest": false,
        "followedSources": true,
        "articleLikes": true,
        "newFollowers": true,
        "mentions": true
    }
}
```

### Admin Notification Endpoints

#### Send breaking news notification
```
POST /api/users/admin/send-breaking-news
Authorization: Bearer <admin-token>
Content-Type: application/json

{
    "title": "Breaking News",
    "body": "Important news update",
    "articleId": "article_id_here",
    "targetUsers": ["user1", "user2"] // Optional, sends to all users if not specified
}
```

#### Send followed source notification
```
POST /api/users/admin/send-followed-source-notification
Authorization: Bearer <admin-token>
Content-Type: application/json

{
    "sourceName": "BBC News",
    "title": "New article from BBC News",
    "articleId": "article_id_here"
}
```

#### Send weekly digest
```
POST /api/users/admin/send-weekly-digest
Authorization: Bearer <admin-token>
Content-Type: application/json

{
    "title": "Weekly Digest",
    "body": "Your weekly news summary",
    "data": {
        "weekOf": "2025-01-13",
        "topArticles": ["article1", "article2"]
    },
    "targetUsers": ["user1", "user2"] // Optional
}
```

## Automatic Notifications

The system automatically sends notifications for the following events:

### 1. New Follower
- **Triggered**: When someone follows a user
- **Setting**: `newFollowers`
- **Endpoint**: `POST /api/userActions/{targetSupabaseId}/action` with `action: "follow"`

### 2. Article Like
- **Triggered**: When someone likes a user's article
- **Setting**: `articleLikes`
- **Endpoint**: `POST /api/userActions/article/{id}/like` with `action: "like"`

### 3. Comment Like
- **Triggered**: When someone likes a user's comment
- **Setting**: `userNotifications`
- **Endpoint**: `POST /api/comments/{id}/react` with `action: "like"`

### 4. Comment Reply
- **Triggered**: When someone replies to a user's comment
- **Setting**: `userNotifications`
- **Endpoint**: `POST /api/comments/{id}/reply`

### 5. Mentions
- **Triggered**: When a user is mentioned in a comment or reply using @username
- **Setting**: `mentions`
- **Endpoints**: 
  - `POST /api/comments/` (new comment)
  - `POST /api/comments/{id}/reply` (reply to comment)

## Notification Types and Data Structure

### New Follower
```javascript
{
    type: 'new_follower',
    followerId: 'user_id',
    followerName: 'John Doe',
    link: 'gulfio://profile/user_id'
}
```

### Article Like
```javascript
{
    type: 'article_like',
    likerId: 'user_id',
    likerName: 'John Doe',
    articleId: 'article_id',
    articleTitle: 'Article Title',
    link: 'gulfio://article/article_id'
}
```

### Comment Like
```javascript
{
    type: 'comment_like',
    likerId: 'user_id',
    likerName: 'John Doe',
    commentId: 'comment_id',
    articleId: 'article_id',
    link: 'gulfio://article/article_id?comment=comment_id'
}
```

### Comment Reply
```javascript
{
    type: 'comment_reply',
    replierId: 'user_id',
    replierName: 'John Doe',
    replyText: 'Reply text...',
    commentId: 'comment_id',
    articleId: 'article_id',
    link: 'gulfio://article/article_id?comment=comment_id'
}
```

### Mention
```javascript
{
    type: 'mention',
    mentionerId: 'user_id',
    mentionerName: 'John Doe',
    context: 'comment', // or 'reply'
    contextId: 'comment_id',
    articleId: 'article_id',
    link: 'gulfio://article/article_id?comment=comment_id'
}
```

### Breaking News
```javascript
{
    type: 'breaking_news',
    articleId: 'article_id',
    link: 'gulfio://article/article_id'
}
```

### Followed Source
```javascript
{
    type: 'followed_source',
    sourceName: 'BBC News',
    articleId: 'article_id',
    link: 'gulfio://article/article_id'
}
```

## Important Notes

1. **Notification Preferences**: All notifications respect user preferences. If a user has disabled a notification type, they won't receive those notifications.

2. **Self-Notifications**: The system prevents users from receiving notifications for their own actions (e.g., liking their own comment).

3. **Error Handling**: If a notification fails to send, it won't affect the main operation (e.g., creating a comment still works even if the notification fails).

4. **Push Tokens**: Users must have a valid push token registered to receive notifications.

5. **Mention Detection**: The system automatically detects @username mentions in comments and replies and sends notifications to mentioned users.

## Usage Examples

### Frontend Integration

```javascript
// Update notification settings
const updateNotificationSettings = async (settings) => {
    const response = await fetch('/api/users/notification-settings', {
        method: 'PATCH',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ notificationSettings: settings })
    });
    return response.json();
};

// Get current settings
const getNotificationSettings = async () => {
    const response = await fetch('/api/users/notification-settings', {
        headers: {
            'Authorization': `Bearer ${token}`
        }
    });
    return response.json();
};
```

### Backend Usage

```javascript
// Send custom notification
const NotificationService = require('./utils/notificationService');

// Send article like notification
await NotificationService.sendArticleLikeNotification(
    'article_author_id',
    'liker_id',
    'John Doe',
    'article_id',
    'Article Title'
);

// Send bulk breaking news
await NotificationService.sendBulkNotification(
    ['user1', 'user2', 'user3'],
    'breakingNews',
    'Breaking News',
    'Important update',
    { articleId: 'article_id' }
);
```

## Testing

You can test the notification system by:

1. Creating test users with different notification settings
2. Performing actions that trigger notifications (likes, follows, comments)
3. Checking that notifications are only sent to users with the appropriate settings enabled
4. Verifying that the notification data structure is correct

## Security Considerations

- Admin notification endpoints should be protected with proper authentication and authorization
- User notification settings should only be modifiable by the user themselves
- Push tokens should be handled securely and not exposed in API responses

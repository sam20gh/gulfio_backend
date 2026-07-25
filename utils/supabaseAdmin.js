const { createClient } = require('@supabase/supabase-js');

// Service-role client for server-side use only (matches routes/auth.js's
// pattern). Used to broadcast realtime events — channel.send() falls back to
// a stateless REST POST when the channel hasn't been joined/subscribed, so
// this never holds an open websocket on the backend.
const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = supabaseAdmin;

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client for backend use
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * POST /api/auth/login
 * Login with email and password via Supabase
 */
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ 
                success: false, 
                message: 'Email and password are required' 
            });
        }

        // Use Supabase auth from backend
        const { data, error } = await supabase.auth.signInWithPassword({
            email,
            password
        });

        if (error) {
            console.error('Login error:', error);
            return res.status(401).json({ 
                success: false, 
                message: error.message 
            });
        }

        if (!data.user || !data.session) {
            return res.status(401).json({ 
                success: false, 
                message: 'Login failed - no user or session returned' 
            });
        }

        // Return the session data to frontend
        res.json({
            success: true,
            user: data.user,
            session: data.session
        });

    } catch (error) {
        console.error('Auth login error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Internal server error during login' 
        });
    }
});

/**
 * POST /api/auth/signup
 * Sign up with email and password via Supabase
 */
router.post('/signup', async (req, res) => {
    try {
        const { email, password, name } = req.body;

        if (!email || !password) {
            return res.status(400).json({ 
                success: false, 
                message: 'Email and password are required' 
            });
        }

        // Use Supabase auth from backend
        const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: {
                data: {
                    name: name || email.split('@')[0]
                }
            }
        });

        if (error) {
            console.error('Signup error:', error);
            return res.status(400).json({ 
                success: false, 
                message: error.message 
            });
        }

        // Return the session data to frontend
        res.json({
            success: true,
            user: data.user,
            session: data.session,
            message: data.user?.email_confirmed_at ? 'Account created successfully' : 'Please check your email to confirm your account'
        });

    } catch (error) {
        console.error('Auth signup error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Internal server error during signup' 
        });
    }
});

/**
 * POST /api/auth/forgot-password
 * Send password reset email via Supabase
 */
router.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ 
                success: false, 
                message: 'Email is required' 
            });
        }

        // Use Supabase auth from backend
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: `${process.env.FRONTEND_URL}/reset-password`
        });

        if (error) {
            console.error('Reset password error:', error);
            return res.status(400).json({ 
                success: false, 
                message: error.message 
            });
        }

        res.json({
            success: true,
            message: 'Password reset email sent successfully'
        });

    } catch (error) {
        console.error('Auth forgot-password error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Internal server error during password reset' 
        });
    }
});

/**
 * POST /api/auth/reset-password
 * Reset password with token via Supabase
 */
router.post('/reset-password', async (req, res) => {
    try {
        const { access_token, refresh_token, password } = req.body;

        if (!access_token || !refresh_token || !password) {
            return res.status(400).json({ 
                success: false, 
                message: 'Access token, refresh token, and new password are required' 
            });
        }

        // Set session with the tokens
        const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
            access_token,
            refresh_token
        });

        if (sessionError) {
            console.error('Session error:', sessionError);
            return res.status(400).json({ 
                success: false, 
                message: sessionError.message 
            });
        }

        // Update password
        const { data, error } = await supabase.auth.updateUser({
            password: password
        });

        if (error) {
            console.error('Password update error:', error);
            return res.status(400).json({ 
                success: false, 
                message: error.message 
            });
        }

        res.json({
            success: true,
            user: data.user,
            message: 'Password updated successfully'
        });

    } catch (error) {
        console.error('Auth reset-password error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Internal server error during password reset' 
        });
    }
});

/**
 * POST /api/auth/refresh
 * Refresh session token via Supabase
 */
router.post('/refresh', async (req, res) => {
    try {
        const { refresh_token } = req.body;

        if (!refresh_token) {
            return res.status(400).json({ 
                success: false, 
                message: 'Refresh token is required' 
            });
        }

        // Use Supabase auth from backend
        const { data, error } = await supabase.auth.refreshSession({
            refresh_token
        });

        if (error) {
            console.error('Refresh error:', error);
            return res.status(401).json({ 
                success: false, 
                message: error.message 
            });
        }

        res.json({
            success: true,
            user: data.user,
            session: data.session
        });

    } catch (error) {
        console.error('Auth refresh error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Internal server error during token refresh' 
        });
    }
});

/**
 * POST /api/auth/logout
 * Logout and invalidate session via Supabase
 */
router.post('/logout', async (req, res) => {
    try {
        const { access_token } = req.body;

        if (access_token) {
            // Set session first then sign out
            await supabase.auth.setSession({
                access_token,
                refresh_token: req.body.refresh_token || ''
            });
        }

        const { error } = await supabase.auth.signOut();

        if (error) {
            console.error('Logout error:', error);
            // Don't return error for logout - just log it
        }

        res.json({
            success: true,
            message: 'Logged out successfully'
        });

    } catch (error) {
        console.error('Auth logout error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Internal server error during logout' 
        });
    }
});

module.exports = router;

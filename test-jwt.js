#!/usr/bin/env node

// Test JWT token handling for debugging authentication issues
const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const SUPABASE_ISSUER = process.env.SUPABASE_JWT_ISSUER;

console.log('🔍 Testing JWT configuration...');
console.log('JWT_SECRET exists:', !!JWT_SECRET);
console.log('SUPABASE_ISSUER:', SUPABASE_ISSUER);

// Test with a sample JWT token (you would get this from the frontend)
const sampleToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNzM3NjUzMjI2LCJpYXQiOjE3Mzc2NDk2MjYsImlzcyI6Imh0dHBzOi8vdXdieGh4c3Fpc3Bscm52cmx0enYuc3VwYWJhc2UuY28vYXV0aC92MSIsInN1YiI6IjFkOTg2MWUwLWRiMDctNDM3Yi04ZGU5LThiOGYxYzhkOGU2ZCIsImVtYWlsIjoic2FtMjBnaEBnbWFpbC5jb20iLCJwaG9uZSI6IiIsImFwcF9tZXRhZGF0YSI6eyJwcm92aWRlciI6ImVtYWlsIiwicHJvdmlkZXJzIjpbImVtYWlsIl19LCJ1c2VyX21ldGFkYXRhIjp7fSwicm9sZSI6ImF1dGhlbnRpY2F0ZWQiLCJhYWwiOiJhYWwxIiwiYW1yIjpbeyJtZXRob2QiOiJwYXNzd29yZCIsInRpbWVzdGFtcCI6MTczNzY0OTYyNn1dLCJzZXNzaW9uX2lkIjoiOGUxZDE2YTItM2M0ZC00NjU3LTllOWUtYWEwZWU4YzgxNGYzIn0.example";

console.log('\n🧪 Testing JWT verification...');

try {
    // Test verification
    const verified = jwt.verify(sampleToken, JWT_SECRET, {
        algorithms: ['HS256'],
        issuer: SUPABASE_ISSUER,
    });
    console.log('✅ JWT verification successful!');
    console.log('User ID:', verified.sub);
    console.log('Email:', verified.email);
} catch (verifyError) {
    console.log('❌ JWT verification failed:', verifyError.message);
    
    // Try decode without verification
    try {
        const decoded = jwt.decode(sampleToken);
        console.log('⚠️ Unverified decode successful:');
        console.log('User ID:', decoded?.sub);
        console.log('Email:', decoded?.email);
        console.log('Issuer:', decoded?.iss);
        console.log('Expected Issuer:', SUPABASE_ISSUER);
        console.log('Issuer matches:', decoded?.iss === SUPABASE_ISSUER);
    } catch (decodeError) {
        console.log('❌ JWT decode also failed:', decodeError.message);
    }
}

console.log('\n📋 Note: Replace the sampleToken with a real token from your app for actual testing.');

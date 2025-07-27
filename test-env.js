require('dotenv').config();

// Test environment variables loading
console.log('🔬 Environment Variables Debug:');
console.log('ADMIN_API_KEY exists:', !!process.env.ADMIN_API_KEY);
console.log('ADMIN_API_KEY length:', process.env.ADMIN_API_KEY ? process.env.ADMIN_API_KEY.length : 'N/A');
console.log('ADMIN_API_KEY value:', process.env.ADMIN_API_KEY ? process.env.ADMIN_API_KEY.substring(0, 20) + '...' : 'NOT SET');
console.log('');
console.log('SUPABASE_JWT_SECRET exists:', !!process.env.SUPABASE_JWT_SECRET);
console.log('SUPABASE_JWT_ISSUER exists:', !!process.env.SUPABASE_JWT_ISSUER);
console.log('SUPABASE_JWT_ISSUER value:', process.env.SUPABASE_JWT_ISSUER);
console.log('');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('All env keys:', Object.keys(process.env).filter(key => key.includes('ADMIN') || key.includes('SUPABASE')));

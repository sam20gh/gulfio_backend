require('dotenv').config();
const redis = require('../utils/redis');
const t = () => Date.now();
(async () => {
  console.log('REDIS_URL set:', !!process.env.REDIS_URL, process.env.REDIS_URL ? '(host: ' + (process.env.REDIS_URL.match(/@([^:]+)/)?.[1] || '?') + ')' : '');
  // give it a moment to connect
  await new Promise(r => setTimeout(r, 1500));
  console.log('isConnected:', redis.isConnected());
  const ops = [
    ['get(test)', () => redis.get('___latency_test___')],
    ['set(test)', () => redis.set('___latency_test___', '1', 'EX', 30)],
    ['get(test) #2', () => redis.get('___latency_test___')],
    ['smembers', () => redis.smembers('___latency_set___')],
    ['sadd', () => redis.sadd('___latency_set___', 'a', 'b')],
    ['expire', () => redis.expire('___latency_set___', 30)],
    ['get vector_search_status', () => redis.get('vector_search_status')],
  ];
  let total = 0;
  for (const [label, fn] of ops) {
    const s = t(); await fn(); const d = t() - s; total += d;
    console.log(`  ${label}: ${d}ms`);
  }
  console.log(`\nTOTAL for ${ops.length} sequential ops: ${total}ms  (this runs on EVERY /personalized request)`);
  process.exit(0);
})();

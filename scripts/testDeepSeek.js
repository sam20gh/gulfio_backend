const { getDeepSeekEmbedding } = require('../utils/deepseek');

(async () => {
    try {
        const result = await getDeepSeekEmbedding("This is a DeepSeek test for Gulfio.");
        console.log("Embedding received:", result);
    } catch (err) {
        console.error("Error getting embedding:", err);
    }
})();
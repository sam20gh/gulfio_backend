const { getOpenAIEmbedding } = require('../utils/deepseek');

(async () => {
    try {
        const result = await getOpenAIEmbedding("This is a DeepSeek test for Gulfio.");
        console.log("Embedding received:", result);
    } catch (err) {
        console.error("Error getting embedding:", err);
    }
})();
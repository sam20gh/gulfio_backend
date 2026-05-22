/**
 * aiArticleService — Brief + Fact-check generation for articles.
 *
 * Engines:
 *   - 'llm_only' (v1, default): pure LLM call, no external grounding.
 *   - 'gulfio_rag' (v2, stub):  retrieves supporting/refuting Gulfio articles via
 *                               vector search and grounds the verdict in them.
 *                               See docs/AI_FACTCHECK_V2_ROADMAP.md
 *
 * The output schemas below are PUBLIC API contracts. Do not change field names
 * without a version bump — publisher integrations will depend on them.
 */

const crypto = require('crypto');
const { chatCompletionJSON } = require('./openaiClient');

const BRIEF_MODEL = 'gpt-4o-mini';
const FACTCHECK_MODEL = 'gpt-4o-mini';
const MAX_INPUT_CHARS = 6000;     // truncate long articles before sending
const BRIEF_MAX_TOKENS = 220;
const FACTCHECK_MAX_TOKENS = 900;

const API_VERSION = '1';
const FACTCHECK_DISCLAIMER =
    'AI-generated fact-check. v1 uses general model knowledge only and does not consult external sources. Always verify independently.';

// ─── helpers ──────────────────────────────────────────────────────────────────

function contentHash({ title, content, language }) {
    return crypto
        .createHash('sha1')
        .update(`${title || ''}\n${content || ''}\n${language || ''}`)
        .digest('hex');
}

function truncate(text, max = MAX_INPUT_CHARS) {
    if (!text) return '';
    if (text.length <= max) return text;
    return text.slice(0, max) + '\n[...truncated]';
}

function safeParseJSON(text) {
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        // Tolerate models that wrap JSON in prose/```json blocks
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
            try {
                return JSON.parse(match[0]);
            } catch {
                return null;
            }
        }
        return null;
    }
}

function languageInstruction(language) {
    const lang = (language || 'english').toLowerCase();
    if (lang === 'arabic') return 'Respond in Arabic (العربية).';
    if (lang === 'farsi') return 'Respond in Farsi (فارسی).';
    if (lang === 'urdu') return 'Respond in Urdu (اردو).';
    return 'Respond in English.';
}

// ─── BRIEF ────────────────────────────────────────────────────────────────────

const BRIEF_SYSTEM = `You are a concise news editor for Gulfio, a Gulf/MENA news app.
Produce a sharp summary of the article the user pastes.

Rules:
- Output STRICT JSON only. Schema: { "brief": "<one short paragraph, 50-80 words>" }.
- No preamble, no markdown, no "this article says".
- Keep it factual, neutral, and concrete (names, numbers, places).
- Match the requested response language exactly.`;

async function generateBrief({ title, content, language }) {
    const started = Date.now();
    const safeContent = truncate(content);

    const messages = [
        { role: 'system', content: BRIEF_SYSTEM },
        {
            role: 'user',
            content: `${languageInstruction(language)}

TITLE: ${title || '(no title)'}

ARTICLE:
${safeContent}`,
        },
    ];

    const { content: raw, usage, model } = await chatCompletionJSON({
        messages,
        model: BRIEF_MODEL,
        max_tokens: BRIEF_MAX_TOKENS,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        timeout: 20000,
    });

    const parsed = safeParseJSON(raw);
    const briefText = (parsed && typeof parsed.brief === 'string' && parsed.brief.trim()) || '';

    if (!briefText) {
        throw new Error('Brief generation returned empty content');
    }

    return {
        api_version: API_VERSION,
        brief: briefText,
        engine: 'llm_only',
        model,
        language: language || 'english',
        generated_at: new Date().toISOString(),
        latency_ms: Date.now() - started,
        usage: usage || null,
    };
}

// ─── FACT-CHECK ───────────────────────────────────────────────────────────────

const FACTCHECK_SYSTEM = `You are a careful fact-check assistant for Gulfio.
You will receive a news article. Identify the most important verifiable factual claims
and assess each one based on your general knowledge and internal consistency of the text.

You do NOT have live web access. For anything that requires current data, recent events,
or specific local knowledge you cannot confirm, mark the claim "unverifiable" — do NOT guess.

Output STRICT JSON only, no prose, matching this schema EXACTLY:
{
  "verdict": "supported" | "mixed" | "unsupported" | "unverifiable",
  "confidence": 0.0,
  "summary": "<2-3 sentence overall judgement>",
  "claims": [
    {
      "claim": "<the specific factual statement extracted from the article>",
      "status": "supported" | "disputed" | "unsupported" | "unverifiable",
      "note": "<one sentence explaining your reasoning>"
    }
  ]
}

Rules:
- Maximum 5 claims, ordered by importance.
- "confidence" is a float between 0 and 1 reflecting your overall certainty.
- Be conservative: when in doubt, prefer "unverifiable" over "supported".
- Match the response language exactly to what the user requests.
- Do NOT add fields beyond the schema. Do NOT wrap in markdown.`;

function normaliseFactCheck(parsed) {
    const allowedVerdicts = new Set(['supported', 'mixed', 'unsupported', 'unverifiable']);
    const allowedStatuses = new Set(['supported', 'disputed', 'unsupported', 'unverifiable']);

    const verdict = allowedVerdicts.has(parsed?.verdict) ? parsed.verdict : 'unverifiable';
    let confidence = Number(parsed?.confidence);
    if (!Number.isFinite(confidence)) confidence = 0;
    confidence = Math.min(1, Math.max(0, confidence));

    const summary = typeof parsed?.summary === 'string' ? parsed.summary.trim() : '';

    const rawClaims = Array.isArray(parsed?.claims) ? parsed.claims : [];
    const claims = rawClaims.slice(0, 5).map((c) => ({
        claim: String(c?.claim || '').trim(),
        status: allowedStatuses.has(c?.status) ? c.status : 'unverifiable',
        note: String(c?.note || '').trim(),
        evidence: [], // empty in v1; populated by gulfio_rag in v2
    })).filter((c) => c.claim.length > 0);

    return { verdict, confidence, summary, claims };
}

async function factCheckLLMOnly({ title, content, language }) {
    const started = Date.now();
    const safeContent = truncate(content);

    const messages = [
        { role: 'system', content: FACTCHECK_SYSTEM },
        {
            role: 'user',
            content: `${languageInstruction(language)}

TITLE: ${title || '(no title)'}

ARTICLE:
${safeContent}`,
        },
    ];

    const { content: raw, usage, model } = await chatCompletionJSON({
        messages,
        model: FACTCHECK_MODEL,
        max_tokens: FACTCHECK_MAX_TOKENS,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        timeout: 30000,
    });

    const parsed = safeParseJSON(raw);
    if (!parsed) {
        throw new Error('Fact-check returned unparseable response');
    }

    const normalised = normaliseFactCheck(parsed);

    return {
        api_version: API_VERSION,
        ...normalised,
        engine: 'llm_only',
        model,
        language: language || 'english',
        sources_considered: 0,
        generated_at: new Date().toISOString(),
        latency_ms: Date.now() - started,
        usage: usage || null,
        disclaimer: FACTCHECK_DISCLAIMER,
    };
}

async function factCheckGulfioRAG(/* { article } */) {
    // v2 stub. See docs/AI_FACTCHECK_V2_ROADMAP.md
    throw new Error('factCheckGulfioRAG not implemented in v1');
}

/**
 * Public dispatcher. Pick engine via flag/env so we can flip without redeploying clients.
 */
async function factCheck(article, { engine } = {}) {
    const chosen = engine || process.env.FACTCHECK_ENGINE || 'llm_only';
    if (chosen === 'gulfio_rag') return factCheckGulfioRAG(article);
    return factCheckLLMOnly(article);
}

module.exports = {
    generateBrief,
    factCheck,
    factCheckLLMOnly,
    factCheckGulfioRAG,
    contentHash,
    API_VERSION,
    FACTCHECK_DISCLAIMER,
};

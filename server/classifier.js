import Anthropic from '@anthropic-ai/sdk';

const AI_CATEGORIES = [
  'MCP Servers',
  'Claude Tools',
  'AI Frameworks',
  'LLM Tooling',
  'Dev Tools',
  'Automation',
  'Agents',
  'Prompting',
];

/**
 * Classify a batch of Instagram posts.
 * Returns array of { post, isAiRelated, category, skillName, confidence, reason }.
 */
export async function classifyPosts(posts, { apiKey, model = 'claude-sonnet-4-6', activeCategories = AI_CATEGORIES } = {}) {
  const client = new Anthropic({ apiKey });
  const results = [];

  // Process in batches of 10 to avoid huge prompts
  const BATCH = 10;
  for (let i = 0; i < posts.length; i += BATCH) {
    const batch = posts.slice(i, i + BATCH);
    const batchResults = await classifyBatch(client, batch, model, activeCategories);
    results.push(...batchResults);
  }

  return results;
}

async function classifyBatch(client, posts, model, activeCategories) {
  const postsJson = posts.map((p, idx) => ({
    index: idx,
    caption: p.caption?.slice(0, 500) || '',
    hashtags: p.hashtags?.slice(0, 20) || [],
    url: p.postUrl,
  }));

  const prompt = `You are classifying Instagram saved posts to find ones related to AI tools, skills, and MCP (Model Context Protocol) servers that someone would want to install in Claude.

Categories to look for: ${activeCategories.join(', ')}.

For each post below, determine:
1. Is it related to AI tools, MCP servers, Claude integrations, LLM frameworks, dev tools powered by AI, or AI skills/prompting?
2. If yes: which category fits best, what is the tool/skill name, and your confidence (0-1)?

Posts:
${JSON.stringify(postsJson, null, 2)}

Respond with a JSON array, one object per post, in this exact format:
[
  {
    "index": 0,
    "isAiRelated": true,
    "category": "MCP Servers",
    "skillName": "Playwright MCP",
    "confidence": 0.95,
    "reason": "Post describes installing Playwright as an MCP server for browser automation in Claude"
  },
  ...
]

Only mark isAiRelated=true if you are reasonably confident. Return valid JSON only.`;

  try {
    const message = await client.messages.create({
      model,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0]?.text || '[]';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    const classifications = JSON.parse(jsonMatch?.[0] || '[]');

    return posts.map((post, idx) => {
      const cls = classifications.find(c => c.index === idx) || {};
      return {
        post,
        isAiRelated: cls.isAiRelated || false,
        category: cls.category || null,
        skillName: cls.skillName || null,
        confidence: cls.confidence || 0,
        reason: cls.reason || null,
      };
    });
  } catch (err) {
    // On error, return posts as unclassified
    return posts.map(post => ({
      post,
      isAiRelated: false,
      category: null,
      skillName: null,
      confidence: 0,
      reason: null,
    }));
  }
}

/**
 * Verify an Anthropic API key with a minimal request.
 */
export async function verifyAnthropicKey(apiKey) {
  const client = new Anthropic({ apiKey });
  try {
    await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

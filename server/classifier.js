// ── Ollama helper (on-device, no API key needed) ──────────────────────────────
async function ollamaChat(model, prompt) {
  const res = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.message?.content || '';
}

// ── OpenRouter helper (free cloud API, OpenAI-compatible) ─────────────────────
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const OPENROUTER_HEADERS = { 'HTTP-Referer': 'https://instamcp.app', 'X-Title': 'InstaMCP' };

async function openRouterChat(apiKey, model, prompt) {
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      ...OPENROUTER_HEADERS,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0]?.message?.content || '';
}

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

const OLLAMA_MODELS = ['llama3.2', 'llama3', 'llama2', 'mistral', 'phi3', 'gemma'];

function isOllamaModel(model) {
  return OLLAMA_MODELS.some(m => model?.startsWith(m)) || model === 'ollama';
}

const CLASSIFICATION_PROMPT = (postsJson, activeCategories) =>
  `You are classifying Instagram saved posts to find ones related to AI tools, skills, and MCP servers.
Categories: ${activeCategories.join(', ')}.
Type: "MCP" (MCP servers for Claude), "Skills" (other AI tools), "Agents" (AI agents/frameworks), "Tips" (prompting/tutorials), "News" (announcements/research).

For each post determine if it's AI-related. Extract pros (benefits) and cons (downsides/limitations) from the caption AND comments. Use community comments as real-world feedback about the tool. Respond ONLY with a JSON array, no explanation:
[{"index":0,"isAiRelated":true,"category":"MCP Servers","type":"MCP","skillName":"Playwright MCP","confidence":0.95,"reason":"...","pros":["Easy browser automation","Works with Claude Desktop"],"cons":["Requires Node.js","Can be slow on large pages"]}]

Posts:
${JSON.stringify(postsJson)}`;

function parseClassifications(text, posts) {
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  const classifications = JSON.parse(jsonMatch?.[0] || '[]');
  return posts.map((post, idx) => {
    const cls = classifications.find(c => c.index === idx) || {};
    return {
      post,
      isAiRelated: cls.isAiRelated || false,
      category: cls.category || null,
      type: cls.type || null,
      skillName: cls.skillName || null,
      confidence: cls.confidence || 0,
      reason: cls.reason || null,
      pros: cls.pros || [],
      cons: cls.cons || [],
    };
  });
}

function emptyResults(posts) {
  return posts.map(post => ({ post, isAiRelated: false, category: null, type: null, skillName: null, confidence: 0, reason: null, pros: [], cons: [] }));
}

/**
 * Classify a batch of Instagram posts using OpenRouter or Ollama.
 * Returns array of { post, isAiRelated, category, type, skillName, confidence, reason }.
 */
export async function classifyPosts(posts, { openRouterKey, model = 'meta-llama/llama-3.3-70b-instruct:free', activeCategories = AI_CATEGORIES } = {}) {
  const useOllama = isOllamaModel(model);
  const results = [];

  const BATCH = 10;
  for (let i = 0; i < posts.length; i += BATCH) {
    const batch = posts.slice(i, i + BATCH);
    const postsJson = batch.map((p, idx) => ({
      index: idx,
      caption: p.caption?.slice(0, 500) || '',
      hashtags: p.hashtags?.slice(0, 20) || [],
      comments: p.comments?.slice(0, 8) || [],
      url: p.postUrl,
    }));
    const prompt = CLASSIFICATION_PROMPT(postsJson, activeCategories);

    try {
      const text = useOllama
        ? await ollamaChat(model === 'ollama' ? 'llama3.2' : model, prompt)
        : await openRouterChat(openRouterKey, model, prompt);
      results.push(...parseClassifications(text, batch));
    } catch {
      results.push(...emptyResults(batch));
    }
  }

  return results;
}

/**
 * Verify an OpenRouter API key.
 */
export async function verifyOpenRouterKey(openRouterKey) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/auth/key', {
      headers: { 'Authorization': `Bearer ${openRouterKey}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: body?.error?.message || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

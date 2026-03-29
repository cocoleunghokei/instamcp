import Anthropic from '@anthropic-ai/sdk';

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

// ── Generic OpenAI-compatible helper (Groq, OpenRouter, etc.) ────────────────
async function openAICompatChat(baseUrl, apiKey, model, prompt, extraHeaders = {}) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    }),
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0]?.message?.content || '';
}

const GROQ_BASE = 'https://api.groq.com/openai/v1';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const OPENROUTER_HEADERS = { 'HTTP-Referer': 'https://instamcp.app', 'X-Title': 'InstaMCP' };

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

// Top-level content types shown in the library
// Skills  = tools/MCPs to install
// Agents  = autonomous AI agents or multi-agent frameworks
// Tips    = prompting techniques, tutorials, workflows
// News    = announcements, research, product releases
const CONTENT_TYPES = ['Skills', 'Agents', 'Tips', 'News'];

/**
 * Classify a batch of Instagram posts.
 * Returns array of { post, isAiRelated, category, skillName, confidence, reason }.
 */
const OLLAMA_MODELS = ['llama3.2', 'llama3', 'llama2', 'mistral', 'phi3', 'gemma'];
const GROQ_MODELS = ['llama-3.3-70b-versatile', 'llama3-8b-8192', 'llama3-70b-8192', 'mixtral-8x7b-32768', 'gemma2-9b-it'];
const OPENROUTER_MODELS = ['meta-llama/llama-3.1-8b-instruct:free', 'meta-llama/llama-3.3-70b-instruct:free', 'mistralai/mistral-7b-instruct:free', 'google/gemma-3-4b-it:free'];

function isOllamaModel(model) {
  return OLLAMA_MODELS.some(m => model?.startsWith(m)) || model === 'ollama';
}
function isGroqModel(model) { return GROQ_MODELS.includes(model); }
function isOpenRouterModel(model) { return OPENROUTER_MODELS.includes(model) || model?.includes('/'); }

export async function classifyPosts(posts, { apiKey, groqKey, openRouterKey, model = 'meta-llama/llama-3.3-70b-instruct:free', activeCategories = AI_CATEGORIES } = {}) {
  const useOllama = isOllamaModel(model);
  const useGroq = isGroqModel(model);
  const useOpenRouter = isOpenRouterModel(model);
  const client = (useOllama || useGroq || useOpenRouter) ? null : new Anthropic({ apiKey });
  const results = [];

  const BATCH = 10;
  for (let i = 0; i < posts.length; i += BATCH) {
    const batch = posts.slice(i, i + BATCH);
    let batchResults;
    if (useOllama) {
      batchResults = await classifyBatchOllama(batch, model === 'ollama' ? 'llama3.2' : model, activeCategories);
    } else if (useGroq) {
      batchResults = await classifyBatchOpenAICompat(batch, model, GROQ_BASE, groqKey, {}, activeCategories);
    } else if (useOpenRouter) {
      batchResults = await classifyBatchOpenAICompat(batch, model, OPENROUTER_BASE, openRouterKey, OPENROUTER_HEADERS, activeCategories);
    } else {
      batchResults = await classifyBatch(client, batch, model, activeCategories);
    }
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
2. If yes: which category fits best, what is the tool/skill name, your confidence (0-1), and the content type.

Content type rules:
- "MCP"     = MCP servers specifically (Model Context Protocol tools for Claude)
- "Skills"  = other installable tools, Claude integrations, dev tools powered by AI
- "Agents"  = AI agents, autonomous systems, multi-agent frameworks (CrewAI, AutoGen, etc.)
- "Tips"    = prompting techniques, tutorials, workflows, how-to guides
- "News"    = AI announcements, research papers, product releases, industry news

Posts:
${JSON.stringify(postsJson, null, 2)}

Respond with a JSON array, one object per post, in this exact format:
[
  {
    "index": 0,
    "isAiRelated": true,
    "category": "MCP Servers",
    "type": "Skills",
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
        type: cls.type || null,
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
      type: null,
      skillName: null,
      confidence: 0,
      reason: null,
    }));
  }
}

async function classifyBatchOllama(posts, model, activeCategories) {
  const postsJson = posts.map((p, idx) => ({
    index: idx,
    caption: p.caption?.slice(0, 500) || '',
    hashtags: p.hashtags?.slice(0, 20) || [],
    url: p.postUrl,
  }));

  const prompt = `You are classifying Instagram saved posts to find ones related to AI tools, skills, and MCP servers.
Categories: ${activeCategories.join(', ')}.
Type: "MCP" (MCP servers for Claude), "Skills" (other AI tools), "Agents" (AI agents/frameworks), "Tips" (prompting/tutorials), "News" (announcements/research).

For each post determine if it's AI-related. Respond ONLY with a JSON array, no explanation:
[{"index":0,"isAiRelated":true,"category":"MCP Servers","type":"MCP","skillName":"Playwright MCP","confidence":0.95,"reason":"..."}]

Posts:
${JSON.stringify(postsJson)}`;

  try {
    const text = await ollamaChat(model, prompt);
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
      };
    });
  } catch {
    return posts.map(post => ({ post, isAiRelated: false, category: null, type: null, skillName: null, confidence: 0, reason: null }));
  }
}

async function classifyBatchOpenAICompat(posts, model, baseUrl, apiKey, extraHeaders, activeCategories) {
  const postsJson = posts.map((p, idx) => ({
    index: idx,
    caption: p.caption?.slice(0, 500) || '',
    hashtags: p.hashtags?.slice(0, 20) || [],
    url: p.postUrl,
  }));

  const prompt = `You are classifying Instagram saved posts to find ones related to AI tools, skills, and MCP servers.
Categories: ${activeCategories.join(', ')}.
Type: "MCP" (MCP servers for Claude), "Skills" (other AI tools), "Agents" (AI agents/frameworks), "Tips" (prompting/tutorials), "News" (announcements/research).

For each post determine if it's AI-related. Respond ONLY with a JSON array, no explanation:
[{"index":0,"isAiRelated":true,"category":"MCP Servers","type":"MCP","skillName":"Playwright MCP","confidence":0.95,"reason":"..."}]

Posts:
${JSON.stringify(postsJson)}`;

  try {
    const text = await openAICompatChat(baseUrl, apiKey, model, prompt, extraHeaders);
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
      };
    });
  } catch {
    return posts.map(post => ({ post, isAiRelated: false, category: null, type: null, skillName: null, confidence: 0, reason: null }));
  }
}

export async function verifyGroqKey(groqKey) {
  try {
    await openAICompatChat(GROQ_BASE, groqKey, 'llama3-8b-8192', 'hi');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

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

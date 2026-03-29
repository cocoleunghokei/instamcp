import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { loginInstagram, fetchSavedPosts } from './instagram.js';
import { classifyPosts, verifyAnthropicKey, verifyGroqKey, verifyOpenRouterKey } from './classifier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = 3000;
const DATA_DIR = process.env.NODE_ENV === 'production'
  ? path.join(__dirname, 'data')
  : path.resolve('.');
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');

// Ensure data directory exists
await fs.mkdir(DATA_DIR, { recursive: true });

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Optional password protection ──────────────────────────────
// Set APP_PASSWORD env var to require HTTP Basic Auth on all routes.
const APP_PASSWORD = process.env.APP_PASSWORD;
if (APP_PASSWORD) {
  app.use((req, res, next) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Basic ')) {
      const [, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
      if (pass === APP_PASSWORD) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="InstaMCP"');
    res.status(401).send('Unauthorized');
  });
}

// Serve the web UI
app.use(express.static(path.join(__dirname, '../web')));

// ── Health check ─────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: '1.0.0' });
});

// ── Test Instagram credentials ────────────────────────────────
app.post('/api/test-instagram', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Username and password required.' });
  }
  const result = await loginInstagram(username, password);
  res.json(result);
});

// ── Test Anthropic API key ────────────────────────────────────
app.post('/api/test-anthropic', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ ok: false, error: 'API key required.' });
  const result = await verifyAnthropicKey(apiKey);
  res.json(result);
});

// ── Test Groq API key ─────────────────────────────────────────
app.post('/api/test-groq', async (req, res) => {
  const { groqKey } = req.body;
  if (!groqKey) return res.status(400).json({ ok: false, error: 'Groq API key required.' });
  const result = await verifyGroqKey(groqKey);
  res.json(result);
});

// ── Test OpenRouter API key ───────────────────────────────────
app.post('/api/test-openrouter', async (req, res) => {
  const { openRouterKey } = req.body;
  if (!openRouterKey) return res.status(400).json({ ok: false, error: 'OpenRouter API key required.' });
  const result = await verifyOpenRouterKey(openRouterKey);
  res.json(result);
});

// ── Start a crawl ─────────────────────────────────────────────
// Streams progress via Server-Sent Events so the frontend can update live.
app.get('/api/crawl', async (req, res) => {
  const { apiKey, groqKey, openRouterKey, model, batchSize = 100, includeReels = true, activeCategories, maxResults = 500, dateStart, dateEnd } = req.query;

  const ollamaModels = ['llama3.2', 'llama3', 'llama2', 'mistral', 'phi3', 'gemma'];
  const groqModels = ['llama-3.3-70b-versatile', 'llama3-8b-8192', 'llama3-70b-8192', 'mixtral-8x7b-32768', 'gemma2-9b-it'];
  const isOllama = ollamaModels.some(m => model?.startsWith(m));
  const isGroq = groqModels.includes(model);
  const isOpenRouter = model?.includes('/');
  if (!apiKey && !isOllama && !(isGroq && groqKey) && !(isOpenRouter && openRouterKey)) {
    return res.status(400).json({ ok: false, error: 'API key required. Add an OpenRouter or Groq key in Settings, or select an Ollama model to run locally.' });
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    send('status', { message: 'Launching browser...', progress: 5 });

    // Fetch posts
    send('status', { message: 'Fetching Instagram saved posts...', progress: 15 });
    const posts = await fetchSavedPosts({
      limit: parseInt(batchSize),
      includeReels: includeReels === 'true',
    });

    if (posts.length === 0) {
      send('error', { message: 'No saved posts found. Make sure you are logged in via Settings.' });
      return res.end();
    }

    // Filter by date range if specified
    let filteredPosts = posts;
    if (dateStart || dateEnd) {
      const start = dateStart ? new Date(dateStart) : null;
      const end = dateEnd ? new Date(dateEnd + 'T23:59:59') : null;
      filteredPosts = posts.filter(p => {
        if (!p.timestamp) return true; // keep posts with no timestamp
        const t = new Date(p.timestamp);
        if (start && t < start) return false;
        if (end && t > end) return false;
        return true;
      });
      send('status', { message: `${filteredPosts.length} posts in date range (${posts.length} total fetched)`, progress: 38 });
    }

    send('status', { message: `Found ${filteredPosts.length} posts to classify...`, progress: 40, total: filteredPosts.length });

    // Classify in chunks, sending progress updates
    const categories = activeCategories ? JSON.parse(activeCategories) : undefined;
    const CHUNK = 10;
    const results = [];

    for (let i = 0; i < filteredPosts.length; i += CHUNK) {
      const chunk = filteredPosts.slice(i, i + CHUNK);
      const classified = await classifyPosts(chunk, { apiKey, groqKey, openRouterKey, model, activeCategories: categories });
      results.push(...classified);

      const progress = 40 + Math.floor((i / filteredPosts.length) * 50);
      send('status', {
        message: `Classified ${Math.min(i + CHUNK, filteredPosts.length)} / ${filteredPosts.length} posts...`,
        progress,
        classified: results.filter(r => r.isAiRelated).length,
      });
    }

    const aiResults = results.filter(r => r.isAiRelated);

    const newSkills = aiResults.map(r => ({
      name: r.skillName || r.post.postUrl,
      category: r.category,
      type: r.type || 'Skills',
      confidence: r.confidence,
      reason: r.reason,
      postUrl: r.post.postUrl,
      caption: r.post.caption?.slice(0, 200),
      hashtags: r.post.hashtags,
    }));

    // Merge with existing results — deduplicate by postUrl, new crawl wins on conflicts
    let existingSkills = [];
    let existingTotalSeen = 0;
    try {
      const existing = JSON.parse(await fs.readFile(RESULTS_FILE, 'utf8'));
      existingSkills = existing.skills || [];
      existingTotalSeen = existing.totalSeen || existing.total || 0;
    } catch { /* first crawl */ }

    const skillMap = new Map(existingSkills.map(s => [s.postUrl, s]));
    for (const s of newSkills) skillMap.set(s.postUrl, s);
    let mergedSkills = Array.from(skillMap.values());

    // Enforce max results cap — trim by lowest confidence first
    const cap = parseInt(maxResults);
    if (cap > 0 && mergedSkills.length > cap) {
      mergedSkills = mergedSkills
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
        .slice(0, cap);
    }

    // Track unique posts seen across all crawls (union by postUrl)
    const seenUrlsOld = new Set(existingSkills.map(s => s.postUrl));
    const newUniqueCount = posts.filter(p => !seenUrlsOld.has(p.postUrl)).length;
    const totalSeen = existingTotalSeen + newUniqueCount;

    const output = {
      timestamp: new Date().toISOString(),
      total: filteredPosts.length, // posts classified this crawl session
      totalSeen,                   // cumulative unique posts ever fetched
      aiCount: mergedSkills.length,
      relevance: totalSeen > 0 ? Math.round((mergedSkills.length / totalSeen) * 100) : 0,
      skills: mergedSkills,
    };

    await fs.writeFile(RESULTS_FILE, JSON.stringify(output, null, 2));

    send('complete', output);
    res.end();
  } catch (err) {
    send('error', { message: err.message });
    res.end();
  }
});

// ── Get latest crawl results ──────────────────────────────────
app.get('/api/results', async (req, res) => {
  try {
    const data = await fs.readFile(RESULTS_FILE, 'utf8');
    res.json(JSON.parse(data));
  } catch {
    res.json(null);
  }
});

// ── MCP endpoint: list AI skills ──────────────────────────────
app.get('/api/mcp/list-skills', async (req, res) => {
  try {
    const data = JSON.parse(await fs.readFile(RESULTS_FILE, 'utf8'));
    res.json({ skills: data.skills || [], total: data.aiCount || 0 });
  } catch {
    res.json({ skills: [], total: 0 });
  }
});

app.listen(PORT, () => {
  console.log(`\nInstaMCP server running at http://localhost:${PORT}`);
  console.log(`Web UI: http://localhost:${PORT}/index.html`);
  console.log(`API:    http://localhost:${PORT}/api/health\n`);
});

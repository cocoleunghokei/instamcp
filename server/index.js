import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { loginInstagram, fetchSavedPosts } from './instagram.js';
import { classifyPosts, verifyAnthropicKey } from './classifier.js';

const app = express();
const PORT = 3000;
const RESULTS_FILE = path.resolve('./results.json');

app.use(cors({ origin: '*' }));
app.use(express.json());

// Serve the web UI
app.use(express.static(path.resolve('../web')));

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

// ── Start a crawl ─────────────────────────────────────────────
// Streams progress via Server-Sent Events so the frontend can update live.
app.get('/api/crawl', async (req, res) => {
  const { apiKey, model, batchSize = 100, includeReels = true, activeCategories } = req.query;

  if (!apiKey) {
    return res.status(400).json({ ok: false, error: 'Anthropic API key required. Set it in Settings.' });
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

    send('status', { message: `Found ${posts.length} saved posts. Classifying...`, progress: 40, total: posts.length });

    // Classify in chunks, sending progress updates
    const categories = activeCategories ? JSON.parse(activeCategories) : undefined;
    const CHUNK = 10;
    const results = [];

    for (let i = 0; i < posts.length; i += CHUNK) {
      const chunk = posts.slice(i, i + CHUNK);
      const classified = await classifyPosts(chunk, { apiKey, model, activeCategories: categories });
      results.push(...classified);

      const progress = 40 + Math.floor((i / posts.length) * 50);
      send('status', {
        message: `Classified ${Math.min(i + CHUNK, posts.length)} / ${posts.length} posts...`,
        progress,
        classified: results.filter(r => r.isAiRelated).length,
      });
    }

    const aiResults = results.filter(r => r.isAiRelated);

    // Persist results
    const output = {
      timestamp: new Date().toISOString(),
      total: posts.length,
      aiCount: aiResults.length,
      relevance: posts.length > 0 ? Math.round((aiResults.length / posts.length) * 100) : 0,
      skills: aiResults.map(r => ({
        name: r.skillName || r.post.postUrl,
        category: r.category,
        confidence: r.confidence,
        reason: r.reason,
        postUrl: r.post.postUrl,
        caption: r.post.caption?.slice(0, 200),
        hashtags: r.post.hashtags,
      })),
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

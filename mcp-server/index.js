#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import path from 'path';

const RESULTS_FILE = path.resolve('../server/results.json');
const BACKEND_URL = 'http://localhost:3000';

const server = new Server(
  { name: 'instamcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// ── Tool definitions ──────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_saved_ai_tools',
      description: 'Returns AI tools, MCP servers, and skills found in your Instagram saved posts. Use this to discover what to install in Claude.',
      inputSchema: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description: 'Filter by category: "MCP Servers", "Claude Tools", "AI Frameworks", "LLM Tooling", "Dev Tools", "Automation", "Agents", "Prompting". Omit for all.',
          },
          minConfidence: {
            type: 'number',
            description: 'Minimum confidence score (0-1). Default 0.7.',
          },
        },
      },
    },
    {
      name: 'search_saved_posts',
      description: 'Search your Instagram saved posts for a specific tool, keyword, or topic.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search term — tool name, framework, keyword, etc.',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_crawl_summary',
      description: 'Get a summary of the last crawl: how many posts were scanned, how many AI tools were found, and when it ran.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

// ── Tool handlers ─────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  let data;
  try {
    data = JSON.parse(await fs.readFile(RESULTS_FILE, 'utf8'));
  } catch {
    return {
      content: [{
        type: 'text',
        text: 'No crawl results found. Open the InstaMCP web app and run a crawl first.',
      }],
    };
  }

  if (name === 'list_saved_ai_tools') {
    let skills = data.skills || [];

    if (args?.category) {
      skills = skills.filter(s => s.category?.toLowerCase() === args.category.toLowerCase());
    }

    const minConf = args?.minConfidence ?? 0.7;
    skills = skills.filter(s => (s.confidence || 0) >= minConf);

    if (skills.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No AI tools found${args?.category ? ` in category "${args.category}"` : ''} with confidence ≥ ${minConf}.`,
        }],
      };
    }

    const lines = skills.map((s, i) =>
      `${i + 1}. **${s.name}** (${s.category}) — confidence ${Math.round((s.confidence || 0) * 100)}%\n   ${s.reason || ''}\n   Source: ${s.postUrl}`
    );

    return {
      content: [{
        type: 'text',
        text: `Found ${skills.length} AI tools/skills in your Instagram saves:\n\n${lines.join('\n\n')}`,
      }],
    };
  }

  if (name === 'search_saved_posts') {
    const query = args?.query?.toLowerCase() || '';
    const skills = (data.skills || []).filter(s =>
      s.name?.toLowerCase().includes(query) ||
      s.reason?.toLowerCase().includes(query) ||
      s.caption?.toLowerCase().includes(query) ||
      s.category?.toLowerCase().includes(query) ||
      s.hashtags?.some(h => h.includes(query))
    );

    if (skills.length === 0) {
      return {
        content: [{ type: 'text', text: `No saved posts found matching "${args.query}".` }],
      };
    }

    const lines = skills.map((s, i) =>
      `${i + 1}. **${s.name}** (${s.category})\n   ${s.reason || s.caption?.slice(0, 150) || ''}\n   ${s.postUrl}`
    );

    return {
      content: [{
        type: 'text',
        text: `${skills.length} result(s) for "${args.query}":\n\n${lines.join('\n\n')}`,
      }],
    };
  }

  if (name === 'get_crawl_summary') {
    const ts = data.timestamp ? new Date(data.timestamp).toLocaleString() : 'unknown';
    return {
      content: [{
        type: 'text',
        text: `Last crawl: ${ts}\nTotal posts scanned: ${data.total || 0}\nAI tools identified: ${data.aiCount || 0}\nRelevance score: ${data.relevance || 0}%\n\nTop categories: ${
          Object.entries(
            (data.skills || []).reduce((acc, s) => {
              acc[s.category] = (acc[s.category] || 0) + 1;
              return acc;
            }, {})
          ).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} (${v})`).join(', ')
        }`,
      }],
    };
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
});

// ── Start ─────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);

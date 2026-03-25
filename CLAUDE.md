# Insta Saved List AI Crawler

## Project Overview

A web app that connects to Instagram, fetches all saved posts, and uses AI to filter and surface posts related to AI tools, skills, and Claude MCP integrations — so you always know what to install next in Claude without manually scrolling through saved posts.

## Goals

- Authenticate with Instagram and fetch all saved posts (captions, links, media, hashtags)
- Use AI classification to filter posts relevant to: MCP servers, Claude tools, AI skills, dev tools
- Present results in a clean web UI with links and install instructions where available
- Expose data via an MCP server so Claude can query your saved AI tools directly

## Architecture

```
Instagram API / scraper
        ↓
  Data fetcher / poller
        ↓
  AI classifier (Claude API)
        ↓
  Filtered results store
        ↓
  Web UI  +  MCP server
```

## Tech Stack

- **Frontend**: TBD (likely Next.js or plain React)
- **Backend**: Node.js or Python
- **Instagram data**: Instagram Basic Display API or session-based scraper
- **AI classification**: Claude API (claude-sonnet-4-6)
- **MCP server**: custom MCP server exposing filtered posts as tools/resources
- **Storage**: SQLite or JSON flat file for simplicity

## Key Features

1. **Instagram Sync** — fetch saved posts on demand or on a schedule
2. **AI Filter** — classify posts by relevance to AI/MCP/Claude tooling
3. **Web Dashboard** — browse filtered results, view post details, open originals
4. **MCP Integration** — Claude can ask "what AI tools have I saved?" and get live results

## MCP Server Design

The MCP server should expose:
- `list_saved_ai_tools` — returns all filtered posts tagged as AI/MCP related
- `search_saved_posts(query)` — semantic search over saved posts
- `get_post_details(id)` — full metadata for a specific saved post

## Instagram Access Notes

- Instagram's official API (Basic Display API) only supports posts you own, not saved posts — may need to use session-based approaches or browser automation
- Consider: Playwright/Puppeteer to scrape saved posts from an authenticated session
- Store session cookies securely, never commit to git

## Classification Prompt Strategy

When filtering posts, classify by:
- MCP servers or tools mentioned
- Claude integrations or plugins
- AI frameworks (LangChain, CrewAI, AutoGen, etc.)
- Developer tools powered by AI
- Tutorials or skills for AI/LLM usage

## File Structure (Planned)

```
/
├── CLAUDE.md
├── scraper/          # Instagram data fetching
├── classifier/       # AI classification logic
├── mcp-server/       # MCP server implementation
├── web/              # Frontend dashboard
├── data/             # Local data storage
└── .env.example      # Required env vars (no secrets committed)
```

## Environment Variables Needed

```
INSTAGRAM_USERNAME=
INSTAGRAM_PASSWORD=       # or session cookie
ANTHROPIC_API_KEY=
```

## Development Notes

- Never commit credentials or session cookies
- Keep Instagram scraping respectful — add delays, don't hammer requests
- MCP server should be runnable locally and pointable from Claude Desktop config

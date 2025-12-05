# TwitterAPI.io MCP Server

## Project Status: PUBLISHED v1.0.0

- **npm**: https://www.npmjs.com/package/twitterapi-docs-mcp
- **GitHub**: https://github.com/dorukardahan/twitterapi-docs-mcp
- **Install**: `npx -y twitterapi-docs-mcp`

## What This Is

MCP server providing offline access to TwitterAPI.io documentation for Claude and other AI assistants. Created by an independent developer (not affiliated with TwitterAPI.io).

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Main MCP server (ES Module, no build step) |
| `data/docs.json` | Scraped documentation (52 endpoints, 10 pages) |
| `scrape-all.cjs` | Documentation scraper (not in npm package) |
| `test/index.test.js` | 48 unit tests |

## Commands

```bash
npm test          # Run 48 tests
npm start         # Start MCP server locally
node scrape-all.cjs  # Re-scrape documentation
npm publish       # Publish new version (requires version bump)
```

## Architecture

- **Runtime**: Node.js 18.18.0+
- **Protocol**: MCP via stdio
- **Caching**: Hybrid (memory + disk) with 24-hour TTL
- **Search**: Advanced tokenization with n-gram fuzzy matching

## Version Bumping

Before publishing a new version:
1. Update version in `package.json`
2. Update VERSION constant in `index.js` (lines ~881 and ~1754)
3. Update `CHANGELOG.md`
4. Run `npm test`
5. Commit and push
6. Run `npm publish`
7. Create git tag: `git tag vX.Y.Z && git push origin vX.Y.Z`

## Files NOT in npm package

- `test/` - Tests
- `scrape-*.cjs` - Scrapers
- `MCP-*.md` - Development notes (gitignored)
- `cache/` - Local cache (gitignored)

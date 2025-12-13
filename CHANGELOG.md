# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.6] - 2025-12-13

### Added
- Internal link crawling in `scrape-all.cjs` to capture non-sitemap pages (e.g., `terms`, `acceptable_use`, `dashboard`)
- URL conveniences in `get_twitterapi_url`: accepts page keys (e.g., `qps_limits`) and bare paths (e.g., `pricing`)
- Offline aliases for common docs redirects (`https://docs.twitterapi.io/`, `/api-reference`)

### Changed
- Improved HTML extraction in the scraper to handle nested tags more reliably
- Updated bundled snapshot (`data/docs.json`) to include more site pages and blog posts

### Fixed
- Scraper now fails fast on HTTP 4xx/5xx instead of saving error pages

---

## [1.0.5] - 2025-12-13

### Added
- `context7.json` for Context7 library ownership claim
- `get_twitterapi_url` tool to fetch any `twitterapi.io` / `docs.twitterapi.io` URL (snapshot-first, optional live fetch)
- Expanded snapshot coverage via `sitemap.xml` + blog index crawl (site pages + more blog posts)
- Additional resource aliases (`twitterapi://endpoints/list`, `twitterapi://status/freshness`)
- MCP protocol integration test to prevent `outputSchema` regressions

### Fixed
- MCP SDK compatibility: tools now return `structuredContent` when `outputSchema` is declared
- Scraper redirect handling for relative `Location` headers

### Changed
- `get_twitterapi_guide` now validates against dynamic page keys from `data/docs.json`

---

## [1.0.4] - 2025-12-05

### Added
- Dockerfile for container deployments (Glama.ai, Docker Hub)
- `.dockerignore` for optimized Docker builds
- MCP `completions` capability for mcp-proxy compatibility
- `build` script in package.json for CI/CD compatibility

### Fixed
- Glama.ai deployment compatibility (completions handler, build script)

---

## [1.0.3] - 2025-12-05

### Added
- `mcpName` field in package.json for MCP Registry compatibility
- MCP Registry support (`io.github.dorukardahan/twitterapi-docs-mcp`)

---

## [1.0.2] - 2025-12-05

### Added
- GitHub Actions workflow for automated npm publishing
- npm Trusted Publishing (OIDC) - token-free secure publishing
- Provenance attestation for supply chain security

### Changed
- Upgraded workflow to Node.js 24 (npm 11.6.0+ required for OIDC)
- Fixed test command for CI compatibility
- Cleaned up version strings in startup logs

---

## [1.0.0] - 2025-12-05

### Added

First public release. Previously developed internally as v3.3.0.

#### Tools (6 total)
- `search_twitterapi_docs` - Full-text search across all documentation with configurable `max_results` (1-10)
- `get_twitterapi_endpoint` - Get detailed info for a specific API endpoint
- `list_twitterapi_endpoints` - List all endpoints with optional category filter
- `get_twitterapi_guide` - Get guide pages (pricing, qps_limits, tweet_filter_rules, changelog, introduction, authentication, readme)
- `get_twitterapi_pricing` - Quick access to pricing information
- `get_twitterapi_auth` - Quick access to authentication guide

#### Resources (9 total)
- `twitterapi://guides/pricing` - Pricing guide
- `twitterapi://guides/qps-limits` - QPS limits guide
- `twitterapi://guides/filter-rules` - Tweet filter rules guide
- `twitterapi://guides/changelog` - API changelog
- `twitterapi://guides/introduction` - Introduction guide
- `twitterapi://guides/authentication` - Authentication guide
- `twitterapi://guides/readme` - README guide
- `twitterapi://endpoints/list` - Full endpoint listing
- `twitterapi://status/freshness` - Data freshness status

#### Features
- Advanced tokenization with camelCase/PascalCase support
- N-gram fuzzy matching for search
- Hybrid caching (memory + disk) with 24-hour TTL
- SLO latency tracking (<50ms target)
- Data freshness monitoring
- Structured logging with metrics
- Input validation with helpful error messages
- 48 unit tests

#### Documentation Coverage
- 52 API endpoints
- 8 guide pages
- 5 blog articles
- Offline-first design (no network required)

### Technical Details
- Pure ES Modules (no build step required)
- Node.js 18.18.0+ required
- Single dependency: @modelcontextprotocol/sdk

---

## Pre-1.0 Development History

Internal development versions (v1.0.0 - v3.3.0) included iterative improvements:

- **Phase 1**: Basic tools, search functionality, caching
- **Phase 2**: MCP Resources, advanced search, SLO tracking, data freshness monitoring

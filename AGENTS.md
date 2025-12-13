# Repository Guidelines

## Project Structure

- `index.js`: Main MCP server (ESM) and CLI entrypoint (`twitterapi-docs-mcp`).
- `data/docs.json`: Bundled documentation snapshot used at runtime.
- `scrape-all.cjs`, `scrape-docs.cjs`: Dev-only scrapers to refresh `data/docs.json` (not shipped to npm).
- `test/index.test.js`: Node.js built-in test runner suite.
- `.github/workflows/`: CI/release automation.
- `cache/`: Local runtime cache (gitignored; don’t commit generated content).

## Build, Test, and Development Commands

Prereq: Node.js `>=18.18.0`.

```bash
npm install          # install deps
npm start            # run MCP server locally (stdio)
npm test             # run unit tests (node --test)
npm run scrape       # refresh docs snapshot (updates data/docs.json)
npm run build        # no-op (package is pure ESM)
```

If you change the docs snapshot, commit `data/docs.json` and ensure `npm test` passes.

## Coding Style & Naming Conventions

- JavaScript ESM (`"type": "module"`); prefer `import`/`export` and `const`.
- Match existing formatting in `index.js`/`test/index.test.js` (2-space indent, minimal diffs).
- Keep tool/resource identifiers stable and descriptive (e.g., `search_twitterapi_docs`, `twitterapi://guides/pricing`).
- If you add/rename tools or resources, update the tables in `README.md`.

## Testing Guidelines

- Tests run with Node’s test runner; keep them deterministic and offline (no network calls).
- Add new coverage alongside existing suites in `test/index.test.js` unless a new file is clearly warranted.
- Prefer `node:assert` and small, focused cases (input validation, search behavior, data shape).

## Commit & Pull Request Guidelines

- Commit messages are short and imperative (e.g., “Add …”, “Fix …”).
- Release/version commits typically use `vX.Y.Z - …`; include `CHANGELOG.md` and `package.json` updates when applicable.
- PRs should include: a clear description, how to test (`npm test`), and any data/doc changes (e.g., regenerated `data/docs.json`).

## Security & Configuration Notes

- Don’t commit secrets; `.env` is ignored.
- Verify runtime-required files are included in `package.json#files` before publishing.

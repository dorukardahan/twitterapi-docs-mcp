/**
 * Unit tests for TwitterAPI.io MCP Server
 * Tests: Input validation, Search functions, Cache operations
 */

import assert from 'node:assert';
import { describe, it, before } from 'node:test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_PATH = path.join(__dirname, '..', 'data', 'docs.json');

// ========== VALIDATION FUNCTIONS (copied for testing) ==========
const VALIDATION = {
  QUERY_MAX_LENGTH: 500,
  QUERY_MIN_LENGTH: 1,
  ENDPOINT_PATTERN: /^[a-zA-Z0-9_\-]+$/,
  GUIDE_NAMES: ['pricing', 'qps_limits', 'tweet_filter_rules', 'changelog', 'introduction', 'authentication', 'readme'],
  CATEGORIES: ['user', 'tweet', 'community', 'webhook', 'stream', 'action', 'dm', 'list', 'trend', 'other']
};

const ErrorType = {
  INPUT_VALIDATION: 'input_validation',
  NOT_FOUND: 'not_found',
  INTERNAL_ERROR: 'internal_error',
  TIMEOUT: 'timeout',
};

function validateQuery(query) {
  if (!query || typeof query !== 'string') {
    return {
      valid: false,
      error: {
        type: ErrorType.INPUT_VALIDATION,
        message: 'Query cannot be empty',
        suggestion: 'Try: "user info", "advanced search", "rate limits", "webhook"',
        retryable: false
      }
    };
  }

  const trimmed = query.trim();

  if (trimmed.length < VALIDATION.QUERY_MIN_LENGTH) {
    return {
      valid: false,
      error: {
        type: ErrorType.INPUT_VALIDATION,
        message: 'Query too short',
        suggestion: 'Enter at least 1 character. Examples: "tweet", "user", "search"',
        retryable: false
      }
    };
  }

  if (trimmed.length > VALIDATION.QUERY_MAX_LENGTH) {
    return {
      valid: false,
      error: {
        type: ErrorType.INPUT_VALIDATION,
        message: `Query too long (${trimmed.length} chars, max ${VALIDATION.QUERY_MAX_LENGTH})`,
        suggestion: 'Use fewer, more specific keywords',
        retryable: false
      }
    };
  }

  return { valid: true, value: trimmed };
}

function validateEndpointName(name) {
  if (!name || typeof name !== 'string') {
    return {
      valid: false,
      error: {
        type: ErrorType.INPUT_VALIDATION,
        message: 'Endpoint name cannot be empty',
        suggestion: 'Use list_twitterapi_endpoints to see available endpoints',
        retryable: false
      }
    };
  }

  const trimmed = name.trim();

  if (!VALIDATION.ENDPOINT_PATTERN.test(trimmed)) {
    return {
      valid: false,
      error: {
        type: ErrorType.INPUT_VALIDATION,
        message: 'Invalid endpoint name format',
        suggestion: 'Use format like: get_user_info, tweet_advanced_search, add_webhook_rule',
        retryable: false
      }
    };
  }

  return { valid: true, value: trimmed };
}

function validateGuideName(name) {
  if (!name || typeof name !== 'string') {
    return {
      valid: false,
      error: {
        type: ErrorType.INPUT_VALIDATION,
        message: 'Guide name cannot be empty',
        suggestion: `Available guides: ${VALIDATION.GUIDE_NAMES.join(', ')}`,
        retryable: false
      }
    };
  }

  const trimmed = name.trim().toLowerCase();

  if (!VALIDATION.GUIDE_NAMES.includes(trimmed)) {
    return {
      valid: false,
      error: {
        type: ErrorType.INPUT_VALIDATION,
        message: `Unknown guide: "${trimmed}"`,
        suggestion: `Available guides: ${VALIDATION.GUIDE_NAMES.join(', ')}`,
        retryable: false
      }
    };
  }

  return { valid: true, value: trimmed };
}

function validateCategory(category) {
  if (!category) {
    return { valid: true, value: null };
  }

  const trimmed = category.trim().toLowerCase();

  if (!VALIDATION.CATEGORIES.includes(trimmed)) {
    return {
      valid: false,
      error: {
        type: ErrorType.INPUT_VALIDATION,
        message: `Unknown category: "${trimmed}"`,
        suggestion: `Available categories: ${VALIDATION.CATEGORIES.join(', ')}`,
        retryable: false
      }
    };
  }

  return { valid: true, value: trimmed };
}

// ========== SEARCH FUNCTIONS (copied for testing - Phase 2 version) ==========
/**
 * Advanced tokenizer with camelCase and compound word support
 */
function tokenize(text) {
  // Step 1: Split camelCase and PascalCase
  let processed = text.replace(/([a-z])([A-Z])/g, '$1 $2');

  // Step 2: Split numbers from letters
  processed = processed.replace(/([a-zA-Z])(\d)/g, '$1 $2');
  processed = processed.replace(/(\d)([a-zA-Z])/g, '$1 $2');

  // Step 3: Replace separators with spaces
  processed = processed
    .toLowerCase()
    .replace(/[_\-\/\.]/g, ' ')
    .replace(/[^a-z0-9\s]/g, '');

  // Step 4: Split and filter
  const tokens = processed
    .split(/\s+/)
    .filter(t => t.length > 1);

  // Step 5: Deduplicate while preserving order
  return [...new Set(tokens)];
}

/**
 * Generates n-grams from tokens for fuzzy matching
 */
function generateNGrams(tokens, n = 2) {
  const ngrams = [];
  for (const token of tokens) {
    if (token.length >= n) {
      for (let i = 0; i <= token.length - n; i++) {
        ngrams.push(token.slice(i, i + n));
      }
    }
  }
  return ngrams;
}

/**
 * Advanced scoring algorithm with weighted matching
 */
function calculateScore(searchText, queryTokens) {
  const textLower = searchText.toLowerCase();
  const textTokens = tokenize(searchText);
  const textNGrams = new Set(generateNGrams(textTokens));
  let score = 0;
  let matchCount = 0;

  for (const token of queryTokens) {
    let tokenScore = 0;

    // Exact token match (highest weight)
    if (textTokens.includes(token)) {
      tokenScore = 10;
      matchCount++;
    }
    // Prefix match
    else if (textTokens.some(t => t.startsWith(token))) {
      tokenScore = 8;
      matchCount++;
    }
    // Suffix/substring match
    else if (textTokens.some(t => t.includes(token) || token.includes(t))) {
      tokenScore = 6;
      matchCount++;
    }
    // Direct text inclusion
    else if (textLower.includes(token)) {
      tokenScore = 5;
      matchCount++;
    }
    // N-gram fuzzy match
    else {
      const queryNGrams = generateNGrams([token]);
      const ngramMatches = queryNGrams.filter(ng => textNGrams.has(ng)).length;
      if (ngramMatches > 0) {
        tokenScore = Math.min(3, ngramMatches * 0.5);
      }
    }

    score += tokenScore;
  }

  // Multi-token bonus
  if (matchCount > 1) {
    score += matchCount * 5;
  }

  // Position bonus
  if (textTokens.length > 0 && queryTokens.some(t => textTokens[0].includes(t))) {
    score += 3;
  }

  return score;
}

// ========== TESTS ==========

describe('Input Validation', () => {
  describe('validateQuery', () => {
    it('should accept valid queries', () => {
      const result = validateQuery('user info');
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.value, 'user info');
    });

    it('should reject empty queries', () => {
      const result = validateQuery('');
      assert.strictEqual(result.valid, false);
      assert.strictEqual(result.error.type, ErrorType.INPUT_VALIDATION);
    });

    it('should reject null queries', () => {
      const result = validateQuery(null);
      assert.strictEqual(result.valid, false);
    });

    it('should trim whitespace', () => {
      const result = validateQuery('  webhook  ');
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.value, 'webhook');
    });

    it('should reject queries exceeding max length', () => {
      const longQuery = 'a'.repeat(501);
      const result = validateQuery(longQuery);
      assert.strictEqual(result.valid, false);
      assert.ok(result.error.message.includes('too long'));
    });

    it('should accept queries at max length', () => {
      const maxQuery = 'a'.repeat(500);
      const result = validateQuery(maxQuery);
      assert.strictEqual(result.valid, true);
    });
  });

  describe('validateEndpointName', () => {
    it('should accept valid endpoint names', () => {
      const result = validateEndpointName('get_user_info');
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.value, 'get_user_info');
    });

    it('should accept names with hyphens', () => {
      const result = validateEndpointName('get-user-info');
      assert.strictEqual(result.valid, true);
    });

    it('should reject empty names', () => {
      const result = validateEndpointName('');
      assert.strictEqual(result.valid, false);
    });

    it('should reject names with special characters', () => {
      const result = validateEndpointName('get/user/info');
      assert.strictEqual(result.valid, false);
    });

    it('should reject names with spaces', () => {
      const result = validateEndpointName('get user info');
      assert.strictEqual(result.valid, false);
    });
  });

  describe('validateGuideName', () => {
    it('should accept valid guide names', () => {
      const result = validateGuideName('pricing');
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.value, 'pricing');
    });

    it('should be case-insensitive', () => {
      const result = validateGuideName('PRICING');
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.value, 'pricing');
    });

    it('should reject unknown guide names', () => {
      const result = validateGuideName('unknown_guide');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error.message.includes('Unknown guide'));
    });

    it('should reject empty names', () => {
      const result = validateGuideName('');
      assert.strictEqual(result.valid, false);
    });

    it('should accept all valid guide names', () => {
      for (const guide of VALIDATION.GUIDE_NAMES) {
        const result = validateGuideName(guide);
        assert.strictEqual(result.valid, true, `Failed for guide: ${guide}`);
      }
    });
  });

  describe('validateCategory', () => {
    it('should accept valid categories', () => {
      const result = validateCategory('user');
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.value, 'user');
    });

    it('should accept null (optional parameter)', () => {
      const result = validateCategory(null);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.value, null);
    });

    it('should accept undefined (optional parameter)', () => {
      const result = validateCategory(undefined);
      assert.strictEqual(result.valid, true);
    });

    it('should reject unknown categories', () => {
      const result = validateCategory('invalid_category');
      assert.strictEqual(result.valid, false);
    });

    it('should be case-insensitive', () => {
      const result = validateCategory('USER');
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.value, 'user');
    });
  });
});

describe('Search Functions', () => {
  describe('tokenize', () => {
    it('should split by spaces', () => {
      const tokens = tokenize('hello world');
      assert.deepStrictEqual(tokens, ['hello', 'world']);
    });

    it('should handle underscores', () => {
      const tokens = tokenize('get_user_info');
      assert.deepStrictEqual(tokens, ['get', 'user', 'info']);
    });

    it('should handle hyphens', () => {
      const tokens = tokenize('get-user-info');
      assert.deepStrictEqual(tokens, ['get', 'user', 'info']);
    });

    // Phase 2: camelCase support
    it('should split camelCase into separate tokens', () => {
      const tokens = tokenize('getUserInfo');
      assert.deepStrictEqual(tokens, ['get', 'user', 'info']);
    });

    it('should split PascalCase into separate tokens', () => {
      const tokens = tokenize('UserFollowers');
      assert.deepStrictEqual(tokens, ['user', 'followers']);
    });

    it('should split numbers from letters', () => {
      const tokens = tokenize('OAuth2Token');
      assert.ok(tokens.includes('oauth'));
      assert.ok(tokens.includes('token'));
    });

    it('should filter short tokens', () => {
      const tokens = tokenize('a b cd ef');
      assert.deepStrictEqual(tokens, ['cd', 'ef']);
    });

    it('should remove special characters', () => {
      const tokens = tokenize('hello! world?');
      assert.deepStrictEqual(tokens, ['hello', 'world']);
    });

    it('should deduplicate tokens', () => {
      const tokens = tokenize('user user_info userInfo');
      // Should not have duplicate 'user' tokens
      const userCount = tokens.filter(t => t === 'user').length;
      assert.strictEqual(userCount, 1);
    });
  });

  describe('generateNGrams', () => {
    it('should generate bigrams from tokens', () => {
      const ngrams = generateNGrams(['hello']);
      assert.deepStrictEqual(ngrams, ['he', 'el', 'll', 'lo']);
    });

    it('should handle multiple tokens', () => {
      const ngrams = generateNGrams(['ab', 'cd']);
      assert.deepStrictEqual(ngrams, ['ab', 'cd']);
    });

    it('should skip tokens shorter than n', () => {
      const ngrams = generateNGrams(['a', 'bc', 'def'], 2);
      assert.ok(!ngrams.includes('a'));
      assert.ok(ngrams.includes('bc'));
    });

    it('should support custom n value', () => {
      const ngrams = generateNGrams(['hello'], 3);
      assert.deepStrictEqual(ngrams, ['hel', 'ell', 'llo']);
    });
  });

  describe('calculateScore', () => {
    it('should score exact matches higher', () => {
      const score1 = calculateScore('user info endpoint', ['user']);
      const score2 = calculateScore('something else', ['user']);
      assert.ok(score1 > score2);
    });

    it('should score multiple matches higher', () => {
      const score1 = calculateScore('user info api', ['user', 'info']);
      const score2 = calculateScore('user data', ['user', 'info']);
      assert.ok(score1 > score2);
    });

    it('should return 0 for no matches', () => {
      const score = calculateScore('hello world', ['xyz', 'abc']);
      assert.strictEqual(score, 0);
    });

    it('should handle partial matches', () => {
      const score = calculateScore('get_user_followers', ['user']);
      assert.ok(score > 0);
    });
  });
});

describe('Documentation Data', () => {
  let docs;

  before(() => {
    docs = JSON.parse(fs.readFileSync(DOCS_PATH, 'utf-8'));
  });

  it('should have endpoints', () => {
    assert.ok(docs.endpoints);
    assert.ok(Object.keys(docs.endpoints).length > 0);
  });

  it('should have pages', () => {
    assert.ok(docs.pages);
    assert.ok(Object.keys(docs.pages).length > 0);
  });

  it('should have pricing page', () => {
    assert.ok(docs.pages.pricing);
  });

  it('should have authentication page', () => {
    assert.ok(docs.pages.authentication);
  });

  it('should have legal pages', () => {
    assert.ok(docs.pages.terms, 'Terms page missing');
    assert.ok(docs.pages.acceptable_use, 'Acceptable Use page missing');
  });

  it('should have dashboard page', () => {
    assert.ok(docs.pages.dashboard, 'Dashboard page missing');
  });

  it('endpoints should have required fields', () => {
    for (const [name, endpoint] of Object.entries(docs.endpoints)) {
      assert.ok(endpoint.url, `Endpoint ${name} missing url`);
      // Method and path are optional but common
    }
  });

  it('pages should have required fields', () => {
    for (const [name, page] of Object.entries(docs.pages)) {
      assert.ok(page.url || page.title, `Page ${name} missing url or title`);
    }
  });
});

describe('Cache Key Normalization', () => {
  function normalizeKey(key) {
    return key.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 100);
  }

  it('should lowercase keys', () => {
    assert.strictEqual(normalizeKey('HELLO'), 'hello');
  });

  it('should replace special chars with underscore', () => {
    assert.strictEqual(normalizeKey('hello world'), 'hello_world');
    assert.strictEqual(normalizeKey('hello-world'), 'hello_world');
  });

  it('should limit key length to 100', () => {
    const longKey = 'a'.repeat(150);
    assert.strictEqual(normalizeKey(longKey).length, 100);
  });

  it('should handle search queries', () => {
    const key = normalizeKey('search_user info webhook');
    assert.strictEqual(key, 'search_user_info_webhook');
  });
});

describe('MCP Protocol Integration', () => {
  it('should return structuredContent for tools with outputSchema', async () => {
    const repoRoot = path.join(__dirname, '..');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(repoRoot, 'index.js')],
      cwd: repoRoot,
      stderr: 'pipe',
    });

    const client = new Client({ name: 'twitterapi-docs-mcp-tests', version: '0.0.0' });

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      assert.ok(tools.tools.some(t => t.name === 'get_twitterapi_pricing'));

      const pricing = await client.callTool({ name: 'get_twitterapi_pricing', arguments: {} });
      assert.ok(pricing.structuredContent, 'Expected structuredContent in tool result');
      assert.strictEqual(typeof pricing.structuredContent.markdown, 'string');

      const page = await client.callTool({
        name: 'get_twitterapi_url',
        arguments: { url: 'https://twitterapi.io/pricing' }
      });
      assert.ok(page.structuredContent, 'Expected structuredContent in URL tool result');
      assert.strictEqual(page.structuredContent.kind, 'page');
      assert.strictEqual(page.structuredContent.name, 'pricing');
      assert.strictEqual(typeof page.structuredContent.markdown, 'string');

      const keyLookup = await client.callTool({
        name: 'get_twitterapi_url',
        arguments: { url: 'qps_limits' }
      });
      assert.ok(keyLookup.structuredContent, 'Expected structuredContent for key-based lookup');
      assert.strictEqual(keyLookup.structuredContent.kind, 'page');
      assert.strictEqual(keyLookup.structuredContent.name, 'qps_limits');

      const docsRoot = await client.callTool({
        name: 'get_twitterapi_url',
        arguments: { url: 'https://docs.twitterapi.io/' }
      });
      assert.ok(docsRoot.structuredContent, 'Expected structuredContent for docs root alias');
      assert.strictEqual(docsRoot.structuredContent.kind, 'page');
      assert.strictEqual(docsRoot.structuredContent.name, 'introduction');

      const apiRef = await client.callTool({
        name: 'get_twitterapi_url',
        arguments: { url: 'https://docs.twitterapi.io/api-reference' }
      });
      assert.ok(apiRef.structuredContent, 'Expected structuredContent for api-reference alias');
      assert.strictEqual(apiRef.structuredContent.kind, 'page');
      assert.strictEqual(apiRef.structuredContent.name, 'docs_api_reference');

      const badHost = await client.callTool({
        name: 'get_twitterapi_url',
        arguments: { url: 'https://example.com/' }
      });
      assert.strictEqual(badHost.isError, true);
    } finally {
      await client.close();
    }
  });
});

// Run tests
console.log('Running TwitterAPI.io MCP Server tests...\n');

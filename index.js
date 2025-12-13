#!/usr/bin/env node
/**
 * TwitterAPI.io Documentation MCP Server v1.0.5
 *
 * Production-ready MCP server with:
 * - Comprehensive error handling with ErrorType classification
 * - Input validation for all tools
 * - Structured logging with metrics
 * - LLM-optimized tool descriptions with output schemas
 * - Performance monitoring with SLO tracking
 * - Hybrid cache (memory + disk) for search and endpoints
 * - MCP Resources for static guide access
 * - Data freshness monitoring
 *
 * v3.3 Improvements (Phase 2):
 * - max_results parameter for search (1-20, default 10)
 * - Advanced tokenization with camelCase support
 * - Per-tool latency SLO tracking with alerts
 * - Enhanced MCP Resources for static guides
 * - Data freshness monitoring (24h staleness warning)
 *
 * v3.2 Improvements:
 * - Output schemas for all tools (helps LLM parse responses)
 *
 * v3.1 Improvements:
 * - HybridCache with LRU eviction and TTL expiry
 * - Memory-first caching with disk persistence for stdio MCP
 * - Automatic hourly cache cleanup
 * - Cache stats in metrics resource
 *
 * v3.0 Improvements:
 * - Error handling with suggestions for LLM
 * - Input validation (query length, pattern matching)
 * - Structured logging with latency tracking
 * - Better tool descriptions for LLM decision making
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_PATH = path.join(__dirname, "data", "docs.json");

// ========== ERROR HANDLING ==========
const ErrorType = {
  INPUT_VALIDATION: 'input_validation',
  NOT_FOUND: 'not_found',
  INTERNAL_ERROR: 'internal_error',
  TIMEOUT: 'timeout',
};

function formatToolError(error) {
  return {
    content: [{
      type: 'text',
      text: `Error: ${error.message}${error.suggestion ? '\n\nSuggestion: ' + error.suggestion : ''}`
    }],
    isError: true
  };
}

function formatToolSuccess(text, structuredContent) {
  const result = {
    content: [{ type: 'text', text }],
    isError: false
  };

  if (structuredContent !== undefined) {
    result.structuredContent = structuredContent;
  }

  return result;
}

// ========== STRUCTURED LOGGING ==========
const LogLevel = {
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR'
};

// Service Level Objectives (SLOs) - latency targets in ms
const SLO = {
  search_twitterapi_docs: { target: 50, acceptable: 100, alert: 200 },
  get_twitterapi_endpoint: { target: 10, acceptable: 50, alert: 100 },
  list_twitterapi_endpoints: { target: 5, acceptable: 20, alert: 50 },
  get_twitterapi_guide: { target: 10, acceptable: 50, alert: 100 },
  get_twitterapi_pricing: { target: 5, acceptable: 20, alert: 50 },
  get_twitterapi_auth: { target: 5, acceptable: 20, alert: 50 },
  get_twitterapi_url: { target: 20, acceptable: 200, alert: 1000 }
};

class Logger {
  constructor() {
    this.logs = [];
    this.MAX_LOGS = 10000;
    this.metrics = {
      requests: { total: 0, successful: 0, failed: 0, totalLatency: 0 },
      cache: { hits: 0, misses: 0 },
      tools: {},
      sloViolations: { target: 0, acceptable: 0, alert: 0 }
    };
  }

  log(level, component, message, data = null) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
      data
    };

    this.logs.push(entry);
    if (this.logs.length > this.MAX_LOGS) {
      this.logs.shift();
    }

    // Output to stderr (MCP standard - stdout is for protocol)
    const prefix = `[${entry.timestamp}] [${level}] [${component}]`;
    console.error(`${prefix} ${message}`, data ? JSON.stringify(data) : '');
  }

  info(component, message, data) {
    this.log(LogLevel.INFO, component, message, data);
  }

  warn(component, message, data) {
    this.log(LogLevel.WARN, component, message, data);
  }

  error(component, message, error) {
    this.log(LogLevel.ERROR, component, message, {
      error: error?.message,
      stack: error?.stack?.split('\n').slice(0, 3)
    });
  }

  recordToolCall(toolName, duration, success) {
    this.metrics.requests.total++;
    this.metrics.requests.totalLatency += duration;

    if (success) {
      this.metrics.requests.successful++;
    } else {
      this.metrics.requests.failed++;
    }

    if (!this.metrics.tools[toolName]) {
      this.metrics.tools[toolName] = {
        calls: 0,
        errors: 0,
        totalDuration: 0,
        minLatency: Infinity,
        maxLatency: 0,
        sloViolations: { target: 0, acceptable: 0, alert: 0 }
      };
    }

    const tool = this.metrics.tools[toolName];
    tool.calls++;
    tool.totalDuration += duration;
    tool.minLatency = Math.min(tool.minLatency, duration);
    tool.maxLatency = Math.max(tool.maxLatency, duration);

    if (!success) {
      tool.errors++;
    }

    // Track SLO violations
    const slo = SLO[toolName];
    if (slo) {
      if (duration > slo.alert) {
        tool.sloViolations.alert++;
        this.metrics.sloViolations.alert++;
        this.warn('slo', `ALERT: ${toolName} exceeded alert threshold`, {
          duration,
          threshold: slo.alert,
          severity: 'alert'
        });
      } else if (duration > slo.acceptable) {
        tool.sloViolations.acceptable++;
        this.metrics.sloViolations.acceptable++;
        this.warn('slo', `${toolName} exceeded acceptable threshold`, {
          duration,
          threshold: slo.acceptable,
          severity: 'acceptable'
        });
      } else if (duration > slo.target) {
        tool.sloViolations.target++;
        this.metrics.sloViolations.target++;
      }
    }
  }

  recordCacheHit() {
    this.metrics.cache.hits++;
  }

  recordCacheMiss() {
    this.metrics.cache.misses++;
  }

  getMetrics(cacheStats = null, dataFreshness = null) {
    const avgLatency = this.metrics.requests.total > 0
      ? Math.round(this.metrics.requests.totalLatency / this.metrics.requests.total)
      : 0;

    const cacheTotal = this.metrics.cache.hits + this.metrics.cache.misses;
    const cacheHitRate = cacheTotal > 0
      ? (this.metrics.cache.hits / cacheTotal * 100).toFixed(1)
      : 0;

    const result = {
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      requests: {
        ...this.metrics.requests,
        averageLatency: avgLatency
      },
      cache: {
        ...this.metrics.cache,
        hitRate: `${cacheHitRate}%`
      },
      sloViolations: this.metrics.sloViolations,
      tools: Object.entries(this.metrics.tools).reduce((acc, [tool, data]) => {
        const slo = SLO[tool];
        acc[tool] = {
          calls: data.calls,
          errors: data.errors,
          latency: {
            avg: Math.round(data.totalDuration / data.calls),
            min: data.minLatency === Infinity ? 0 : data.minLatency,
            max: data.maxLatency
          },
          slo: slo ? {
            target: `${slo.target}ms`,
            acceptable: `${slo.acceptable}ms`,
            alert: `${slo.alert}ms`,
            violations: data.sloViolations
          } : null
        };
        return acc;
      }, {})
    };

    // Add hybrid cache stats if provided
    if (cacheStats) {
      result.hybridCaches = cacheStats;
    }

    // Add data freshness if provided
    if (dataFreshness) {
      result.dataFreshness = dataFreshness;
    }

    return result;
  }
}

const logger = new Logger();

// ========== HYBRID CACHE ==========
const CACHE_DIR = path.join(__dirname, "cache");

class HybridCache {
  constructor(name, options = {}) {
    this.name = name;
    this.memory = new Map();
    this.MAX_MEMORY = options.maxEntries || 500;
    this.DEFAULT_TTL = options.ttl || 24 * 60 * 60 * 1000; // 24 hours
    this.DISK_WRITE_PROBABILITY = options.diskWriteProbability || 0.1; // 10% disk writes
    this.diskDir = path.join(CACHE_DIR, name);
    this.ensureDir();
  }

  ensureDir() {
    try {
      if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
      }
      if (!fs.existsSync(this.diskDir)) {
        fs.mkdirSync(this.diskDir, { recursive: true });
      }
    } catch (err) {
      logger.warn('cache', `Failed to create cache directory: ${err.message}`);
    }
  }

  normalizeKey(key) {
    return key.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 100);
  }

  isExpired(entry) {
    return Date.now() - entry.timestamp > entry.ttl;
  }

  get(key) {
    const normalized = this.normalizeKey(key);

    // Check memory first
    const memEntry = this.memory.get(normalized);
    if (memEntry && !this.isExpired(memEntry)) {
      logger.recordCacheHit();
      return memEntry.value;
    }
    this.memory.delete(normalized);

    // Check disk
    try {
      const diskPath = path.join(this.diskDir, `${normalized}.json`);
      if (fs.existsSync(diskPath)) {
        const diskEntry = JSON.parse(fs.readFileSync(diskPath, 'utf-8'));
        if (!this.isExpired(diskEntry)) {
          // Restore to memory
          this.memory.set(normalized, diskEntry);
          logger.recordCacheHit();
          logger.info('cache', `Restored from disk: ${this.name}/${normalized}`);
          return diskEntry.value;
        }
        // Clean up expired disk entry
        fs.unlinkSync(diskPath);
      }
    } catch (err) {
      // Disk read failed, continue gracefully
    }

    logger.recordCacheMiss();
    return null;
  }

  set(key, value, ttl = this.DEFAULT_TTL) {
    const normalized = this.normalizeKey(key);

    const entry = {
      key: normalized,
      value,
      timestamp: Date.now(),
      ttl
    };

    // Store in memory
    this.memory.set(normalized, entry);
    logger.info('cache', `Memory write: ${this.name}/${normalized}`, {
      diskProb: this.DISK_WRITE_PROBABILITY
    });

    // Evict oldest if over capacity (LRU-like)
    if (this.memory.size > this.MAX_MEMORY) {
      const oldestKey = this.memory.keys().next().value;
      this.memory.delete(oldestKey);
    }

    // Write to disk (always for stdio MCP servers)
    if (Math.random() < this.DISK_WRITE_PROBABILITY) {
      this.writeToDisk(normalized, entry);
    }
  }

  writeToDisk(key, entry) {
    try {
      const diskPath = path.join(this.diskDir, `${key}.json`);
      fs.writeFileSync(diskPath, JSON.stringify(entry, null, 2));
      logger.info('cache', `Disk write success: ${this.name}/${key}`);
    } catch (err) {
      logger.warn('cache', `Disk write failed: ${err.message}`, { path: this.diskDir, key });
    }
  }

  cleanup() {
    let memoryCleared = 0;
    let diskCleared = 0;

    // Memory cleanup
    for (const [key, entry] of this.memory.entries()) {
      if (this.isExpired(entry)) {
        this.memory.delete(key);
        memoryCleared++;
      }
    }

    // Disk cleanup
    try {
      const files = fs.readdirSync(this.diskDir);
      for (const file of files) {
        try {
          const diskPath = path.join(this.diskDir, file);
          const entry = JSON.parse(fs.readFileSync(diskPath, 'utf-8'));
          if (this.isExpired(entry)) {
            fs.unlinkSync(diskPath);
            diskCleared++;
          }
        } catch (err) {
          // Skip invalid files
        }
      }
    } catch (err) {
      // Disk cleanup failed, continue
    }

    if (memoryCleared > 0 || diskCleared > 0) {
      logger.info('cache', `Cleanup: ${memoryCleared} memory, ${diskCleared} disk entries removed`);
    }
  }

  stats() {
    let diskEntries = 0;
    try {
      diskEntries = fs.readdirSync(this.diskDir).length;
    } catch (err) {
      // Ignore
    }

    return {
      name: this.name,
      memoryEntries: this.memory.size,
      diskEntries,
      maxMemory: this.MAX_MEMORY
    };
  }
}

// Initialize caches
// Note: For stdio MCP servers (spawned per-call), use higher disk probability
// Memory cache is within-session, disk cache persists across sessions
const searchCache = new HybridCache('search', {
  maxEntries: 200,
  ttl: 6 * 60 * 60 * 1000,  // 6 hours for search
  diskWriteProbability: 1.0  // Always write to disk for stdio MCP
});
const endpointCache = new HybridCache('endpoints', {
  maxEntries: 100,
  ttl: 24 * 60 * 60 * 1000,  // 24 hours for endpoints
  diskWriteProbability: 1.0  // Always write to disk for stdio MCP
});
const urlCache = new HybridCache('urls', {
  maxEntries: 200,
  ttl: 24 * 60 * 60 * 1000,  // 24 hours for URL lookups
  diskWriteProbability: 1.0  // Always write to disk for stdio MCP
});

// Periodic cleanup (every hour)
let cleanupInterval = null;
function startCacheCleanup() {
  if (cleanupInterval) return;
  cleanupInterval = setInterval(() => {
    searchCache.cleanup();
    endpointCache.cleanup();
    urlCache.cleanup();
  }, 60 * 60 * 1000); // 1 hour
}

function stopCacheCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

function getAllCacheStats() {
  return {
    search: searchCache.stats(),
    endpoints: endpointCache.stats(),
    urls: urlCache.stats()
  };
}

// ========== INPUT VALIDATION ==========
const VALIDATION = {
  QUERY_MAX_LENGTH: 500,
  QUERY_MIN_LENGTH: 1,
  ENDPOINT_PATTERN: /^[a-zA-Z0-9_\-]+$/,
  GUIDE_NAMES: ['pricing', 'qps_limits', 'tweet_filter_rules', 'changelog', 'introduction', 'authentication', 'readme'],
  CATEGORIES: ['user', 'tweet', 'community', 'webhook', 'stream', 'action', 'dm', 'list', 'trend', 'other']
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

function validateGuideName(name, availableGuideNames = VALIDATION.GUIDE_NAMES) {
  if (!name || typeof name !== 'string') {
    return {
      valid: false,
      error: {
        type: ErrorType.INPUT_VALIDATION,
        message: 'Guide name cannot be empty',
        suggestion: `Available guides: ${availableGuideNames.join(', ')}`,
        retryable: false
      }
    };
  }

  const trimmed = name.trim().toLowerCase();

  if (!availableGuideNames.includes(trimmed)) {
    return {
      valid: false,
      error: {
        type: ErrorType.INPUT_VALIDATION,
        message: `Unknown guide: "${trimmed}"`,
        suggestion: `Available guides: ${availableGuideNames.join(', ')}`,
        retryable: false
      }
    };
  }

  return { valid: true, value: trimmed };
}

function validateCategory(category) {
  if (!category) {
    return { valid: true, value: null }; // Optional parameter
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

const ALLOWED_URL_HOSTS = new Set(['twitterapi.io', 'docs.twitterapi.io']);

function canonicalizeUrl(rawUrl) {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new Error('URL cannot be empty');

  let candidate = trimmed;
  if (candidate.startsWith('/')) {
    candidate = `https://twitterapi.io${candidate}`;
  } else if (/^(twitterapi\.io|docs\.twitterapi\.io)\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  const u = new URL(candidate);
  if (u.protocol !== 'https:') {
    throw new Error('Only https URLs are supported');
  }
  if (!ALLOWED_URL_HOSTS.has(u.hostname)) {
    throw new Error(`Unsupported host: ${u.hostname}`);
  }

  // Ignore fragments and common tracking/query params for matching
  u.hash = '';
  u.search = '';
  if (u.pathname !== '/' && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }

  return u.toString();
}

function normalizeKeyForName(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

function validateTwitterApiUrl(url) {
  if (!url || typeof url !== 'string') {
    return {
      valid: false,
      error: {
        type: ErrorType.INPUT_VALIDATION,
        message: 'URL cannot be empty',
        suggestion: 'Provide a full URL like https://twitterapi.io/pricing or https://docs.twitterapi.io/introduction',
        retryable: false
      }
    };
  }

  try {
    return { valid: true, value: canonicalizeUrl(url) };
  } catch (err) {
    return {
      valid: false,
      error: {
        type: ErrorType.INPUT_VALIDATION,
        message: `Invalid URL: ${err.message}`,
        suggestion: 'Only https://twitterapi.io/* and https://docs.twitterapi.io/* URLs are supported',
        retryable: false
      }
    };
  }
}

// ========== DATA LOADING ==========
let cachedDocs = null;
let lastModified = 0;

// Data freshness configuration
const DATA_FRESHNESS = {
  WARNING_THRESHOLD: 24 * 60 * 60 * 1000,  // 24 hours
  STALE_THRESHOLD: 72 * 60 * 60 * 1000,     // 72 hours
};

function loadDocs() {
  try {
    const stat = fs.statSync(DOCS_PATH);
    const mtime = stat.mtimeMs;

    if (!cachedDocs || mtime > lastModified) {
      logger.info('docs_loader', 'Loading documentation from disk');
      const content = fs.readFileSync(DOCS_PATH, "utf-8");
      cachedDocs = JSON.parse(content);
      lastModified = mtime;
      logger.recordCacheMiss();

      const endpointCount = Object.keys(cachedDocs.endpoints || {}).length;
      const pageCount = Object.keys(cachedDocs.pages || {}).length;
      logger.info('docs_loader', 'Documentation loaded', { endpoints: endpointCount, pages: pageCount });
    } else {
      logger.recordCacheHit();
    }

    return cachedDocs;
  } catch (err) {
    logger.error('docs_loader', 'Failed to load documentation', err);
    return { endpoints: {}, pages: {}, blogs: {}, authentication: {}, meta: {} };
  }
}

/**
 * Get data freshness information
 * Returns object with age, status (fresh/warning/stale), and human-readable age
 */
function getDataFreshness() {
  try {
    const stat = fs.statSync(DOCS_PATH);
    const ageMs = Date.now() - stat.mtimeMs;
    const ageHours = ageMs / (60 * 60 * 1000);
    const ageDays = ageHours / 24;

    let status = 'fresh';
    if (ageMs > DATA_FRESHNESS.STALE_THRESHOLD) {
      status = 'stale';
      logger.warn('data_freshness', 'Documentation is STALE', {
        ageHours: ageHours.toFixed(1),
        threshold: DATA_FRESHNESS.STALE_THRESHOLD / (60 * 60 * 1000)
      });
    } else if (ageMs > DATA_FRESHNESS.WARNING_THRESHOLD) {
      status = 'warning';
    }

    return {
      lastModified: new Date(stat.mtimeMs).toISOString(),
      ageMs,
      ageHuman: ageDays >= 1
        ? `${ageDays.toFixed(1)} days`
        : `${ageHours.toFixed(1)} hours`,
      status,
      thresholds: {
        warning: `${DATA_FRESHNESS.WARNING_THRESHOLD / (60 * 60 * 1000)}h`,
        stale: `${DATA_FRESHNESS.STALE_THRESHOLD / (60 * 60 * 1000)}h`
      }
    };
  } catch (err) {
    logger.error('data_freshness', 'Failed to check data freshness', err);
    return {
      lastModified: null,
      ageMs: null,
      ageHuman: 'unknown',
      status: 'error',
      error: err.message
    };
  }
}

// ========== SEARCH FUNCTIONS ==========
/**
 * Advanced tokenizer with camelCase and compound word support
 * Examples:
 *   "getUserInfo" → ["get", "user", "info"]
 *   "get_user_info" → ["get", "user", "info"]
 *   "OAuth2Token" → ["oauth", "2", "token"]
 */
function tokenize(text) {
  // Step 1: Split camelCase and PascalCase
  // "getUserInfo" → "get User Info"
  // "OAuth2Token" → "O Auth 2 Token"
  let processed = text.replace(/([a-z])([A-Z])/g, '$1 $2');

  // Step 2: Split numbers from letters
  // "OAuth2Token" → "OAuth 2 Token"
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
 * Score breakdown:
 *   - Exact token match: 1.0
 *   - Prefix match: 0.8
 *   - Substring match: 0.6
 *   - N-gram match: 0.3
 *   - Multiple token bonus: +0.5 per additional match
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
    // Direct text inclusion (handles compound words)
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

  // Multi-token bonus: reward results that match multiple query terms
  if (matchCount > 1) {
    score += matchCount * 5;
  }

  // Position bonus: boost if match appears in first word (likely endpoint name)
  if (textTokens.length > 0 && queryTokens.some(t => textTokens[0].includes(t))) {
    score += 3;
  }

  return score;
}

function searchInDocs(query, maxResults = 20) {
  const data = loadDocs();
  const queryTokens = tokenize(query);
  const results = [];

  // Search endpoints
  for (const [name, item] of Object.entries(data.endpoints || {})) {
    const searchText = [
      name,
      item.title || "",
      item.description || "",
      item.method || "",
      item.path || "",
      item.curl_example || "",
      item.raw_text || "",
      (item.parameters || []).map(p => p.name + ' ' + p.description).join(' '),
    ].join(" ");

    const score = calculateScore(searchText, queryTokens);
    if (score > 0) {
      results.push({
        type: "endpoint",
        name,
        title: item.title,
        description: item.description,
        method: item.method,
        path: item.path,
        url: item.url,
        score,
      });
    }
  }

  // Search pages
  for (const [name, item] of Object.entries(data.pages || {})) {
    const searchText = [
      name,
      item.title || "",
      item.description || "",
      item.raw_text || "",
      (item.paragraphs || []).join(" "),
      (item.list_items || []).join(" "),
      (item.headers || []).map(h => h.text).join(" "),
    ].join(" ");

    const score = calculateScore(searchText, queryTokens);
    if (score > 0) {
      results.push({
        type: "page",
        name,
        title: item.title,
        description: item.description,
        url: item.url,
        category: item.category,
        score,
      });
    }
  }

  // Search blogs
  for (const [name, item] of Object.entries(data.blogs || {})) {
    const searchText = [
      name,
      item.title || "",
      item.description || "",
      item.raw_text || "",
      (item.paragraphs || []).join(" "),
    ].join(" ");

    const score = calculateScore(searchText, queryTokens);
    if (score > 0) {
      results.push({
        type: "blog",
        name,
        title: item.title,
        description: item.description,
        url: item.url,
        score,
      });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, maxResults);
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&#x3C;/g, '<')
    .replace(/&#x3E;/g, '>')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function extractHtmlContent(html) {
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : '';

  const descMatch = html.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i);
  const description = descMatch ? decodeHtmlEntities(descMatch[1].trim()) : '';

  const headers = [];
  for (const m of html.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const level = Number(m[1]);
    const text = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (text) headers.push({ level, text });
  }

  const paragraphs = [];
  for (const m of html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = decodeHtmlEntities(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (text.length > 10) paragraphs.push(text);
  }

  const list_items = [];
  for (const m of html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
    const text = decodeHtmlEntities(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (text.length > 3) list_items.push(text);
  }

  const code_snippets = [];
  for (const m of html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi)) {
    const text = decodeHtmlEntities(m[1].replace(/<[^>]+>/g, '').trim());
    if (text.length > 10) code_snippets.push(text);
  }

  const raw_text = decodeHtmlEntities(
    html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );

  return { title, description, headers, paragraphs, list_items, code_snippets, raw_text };
}

function formatGuideMarkdown(name, page) {
  let output = `# ${page.title || name}\n\n`;
  output += `**URL:** ${page.url || "N/A"}\n\n`;

  if (page.description) {
    output += `## Overview\n${page.description}\n\n`;
  }

  if (page.headers?.length > 0) {
    output += `## Table of Contents\n`;
    output += page.headers.map(h => `${"  ".repeat(h.level - 1)}- ${h.text}`).join("\n");
    output += "\n\n";
  }

  if (page.paragraphs?.length > 0) {
    output += `## Content\n`;
    output += page.paragraphs.join("\n\n");
    output += "\n\n";
  }

  if (page.list_items?.length > 0) {
    output += `## Key Points\n`;
    output += page.list_items.map(li => `- ${li}`).join("\n");
    output += "\n\n";
  }

  if (page.code_snippets?.length > 0) {
    output += `## Code Examples\n\`\`\`\n`;
    output += page.code_snippets.join("\n");
    output += "\n```\n\n";
  }

  output += `## Full Content\n${page.raw_text || "No additional content."}`;
  return output;
}

function formatEndpointMarkdown(endpointName, endpoint) {
  const curlExample =
    endpoint.curl_example ||
    `curl --request ${endpoint.method || 'GET'} \\\n  --url https://api.twitterapi.io${endpoint.path || ''} \\\n  --header 'x-api-key: YOUR_API_KEY'`;

  return `# ${endpoint.title || endpointName}

## Endpoint Details
- **Method:** ${endpoint.method || "GET"}
- **Path:** ${endpoint.path || "Unknown"}
- **Full URL:** https://api.twitterapi.io${endpoint.path || ""}
- **Documentation:** ${endpoint.url}

## Description
${endpoint.description || "No description available."}

${endpoint.parameters?.length > 0 ? `## Parameters
${endpoint.parameters.map(p => `- **${p.name}**${p.required ? ' (required)' : ''}: ${p.description}`).join('\n')}` : ''}

## cURL Example
\`\`\`bash
${curlExample}
\`\`\`

${endpoint.code_snippets?.length > 0 ? `## Code Examples
\`\`\`
${endpoint.code_snippets.join("\n")}
\`\`\`` : ""}

## Full Documentation
${endpoint.raw_text || "No additional content available."}`;
}

function safeCanonicalizeUrl(url) {
  try {
    return canonicalizeUrl(url);
  } catch (_err) {
    return null;
  }
}

function findSnapshotItemByUrl(data, canonicalUrl) {
  for (const [name, ep] of Object.entries(data.endpoints || {})) {
    const epUrl = safeCanonicalizeUrl(ep?.url);
    if (epUrl && epUrl === canonicalUrl) {
      return { kind: 'endpoint', name, item: ep };
    }
  }

  for (const [name, page] of Object.entries(data.pages || {})) {
    const pageUrl = safeCanonicalizeUrl(page?.url);
    if (pageUrl && pageUrl === canonicalUrl) {
      return { kind: 'page', name, item: page };
    }
  }

  for (const [name, blog] of Object.entries(data.blogs || {})) {
    const blogUrl = safeCanonicalizeUrl(blog?.url);
    if (blogUrl && blogUrl === canonicalUrl) {
      return { kind: 'blog', name, item: blog };
    }
  }

  return null;
}

// ========== MCP SERVER ==========
const server = new Server(
  {
    name: "twitterapi-docs",
    version: "1.0.5",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
      completions: {},
    },
  }
);

// ========== TOOL DEFINITIONS (LLM-OPTIMIZED) ==========
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const docs = loadDocs();
  const availablePages = Object.keys(docs.pages || {}).sort();

  return {
    tools: [
    {
      name: "search_twitterapi_docs",
      description: `Search TwitterAPI.io documentation: API endpoints, guides (pricing, rate limits, filter rules), and blog posts.

USE THIS WHEN: You need to find information across the entire documentation.
RETURNS: Ranked results with endpoint paths, descriptions, and relevance scores.

Examples:
- "advanced search" → finds tweet search endpoints
- "rate limit" → finds QPS limits and pricing info
- "webhook" → finds webhook setup endpoints
- "getUserInfo" → finds user info endpoints (supports camelCase)`,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query (1-500 chars). Use English keywords like: 'search', 'user', 'tweet', 'webhook', 'pricing', 'rate limit'. Supports camelCase and underscore formats.",
            minLength: 1,
            maxLength: 500
          },
          max_results: {
            type: "integer",
            description: "Number of results to return. Use higher values (15-20) for comprehensive research, lower values (3-5) for quick lookups.",
            minimum: 1,
            maximum: 20,
            default: 10
          }
        },
        required: ["query"],
      },
      outputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Normalized (trimmed) search query." },
          max_results: { type: "integer", description: "Applied max results (1-20)." },
          cached: { type: "boolean", description: "Whether this response was served from cache." },
	          counts: {
	            type: "object",
	            properties: {
	              total: { type: "integer" },
	              endpoints: { type: "integer" },
	              pages: { type: "integer" },
	              blogs: { type: "integer" }
	            }
	          },
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["endpoint", "page", "blog"] },
                name: { type: "string" },
                title: { type: "string" },
                description: { type: "string" },
                url: { type: "string" },
                category: { type: "string" },
                method: { type: "string" },
                path: { type: "string" },
                score: { type: "number" }
              },
              required: ["type", "score"]
            }
          },
          markdown: { type: "string", description: "Human-readable markdown rendering of the results." }
        },
        required: ["query", "max_results", "results", "markdown"]
      }
    },
    {
      name: "get_twitterapi_endpoint",
      description: `Get complete documentation for a specific TwitterAPI.io endpoint.

USE THIS WHEN: You know the exact endpoint name (e.g., from search results).
RETURNS: Full details including path, parameters, cURL example, and code snippets.

Common endpoints:
- get_user_info, get_user_followers, get_user_following
- tweet_advanced_search, get_tweet_by_id
- add_webhook_rule, get_webhook_rules`,
      inputSchema: {
        type: "object",
        properties: {
          endpoint_name: {
            type: "string",
            description: "Exact endpoint name (use underscores). Examples: 'get_user_info', 'tweet_advanced_search', 'add_webhook_rule'",
          },
        },
        required: ["endpoint_name"],
      },
      outputSchema: {
        type: "object",
        properties: {
          endpoint_name: { type: "string" },
          title: { type: "string" },
          method: { type: "string" },
          path: { type: "string" },
          full_url: { type: "string" },
          doc_url: { type: "string" },
          description: { type: "string" },
          parameters: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                required: { type: "boolean" },
                description: { type: "string" }
              },
              required: ["name"]
            }
          },
          curl_example: { type: "string" },
          code_snippets: { type: "array", items: { type: "string" } },
          raw_text: { type: "string" },
          cached: { type: "boolean" },
          markdown: { type: "string" }
        },
        required: ["endpoint_name", "markdown"]
      }
    },
    {
      name: "list_twitterapi_endpoints",
      description: `List all TwitterAPI.io API endpoints organized by category.

USE THIS WHEN: You need to browse available endpoints or find endpoints by category.
CATEGORIES: user, tweet, community, webhook, stream, action, dm, list, trend

RETURNS: Endpoint names with HTTP method and path for each category.`,
      inputSchema: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "Optional filter: user, tweet, community, webhook, stream, action, dm, list, trend, other",
            enum: ["user", "tweet", "community", "webhook", "stream", "action", "dm", "list", "trend", "other"]
          },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          category: { type: ["string", "null"] },
          total: { type: "integer" },
          endpoints: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                method: { type: "string" },
                path: { type: "string" },
                description: { type: "string" },
                category: { type: "string" }
              },
              required: ["name", "category"]
            }
          },
          markdown: { type: "string" }
        },
        required: ["total", "endpoints", "markdown"]
      }
    },
    {
      name: "get_twitterapi_guide",
      description: `Get a TwitterAPI.io page from the offline snapshot by page key.

USE THIS WHEN: You need the full content of a specific page (guides, docs, policies, contact, etc.).
TIP: Use search_twitterapi_docs if you don't know the page key.

RETURNS: Full guide content with headers, paragraphs, and code examples.`,
      inputSchema: {
        type: "object",
        properties: {
          guide_name: {
            type: "string",
            description: "Page key (from data/pages). Examples: pricing, qps_limits, privacy, contact, introduction, authentication.",
            enum: availablePages
          },
        },
        required: ["guide_name"],
      },
      outputSchema: {
        type: "object",
        properties: {
          guide_name: { type: "string" },
          title: { type: "string" },
          url: { type: "string" },
          description: { type: "string" },
          headers: {
            type: "array",
            items: {
              type: "object",
              properties: {
                level: { type: "integer" },
                text: { type: "string" }
              },
              required: ["level", "text"]
            }
          },
          paragraphs: { type: "array", items: { type: "string" } },
          list_items: { type: "array", items: { type: "string" } },
          code_snippets: { type: "array", items: { type: "string" } },
          raw_text: { type: "string" },
          markdown: { type: "string" }
        },
        required: ["guide_name", "markdown"]
      }
    },
    {
      name: "get_twitterapi_url",
      description: `Fetch a TwitterAPI.io or docs.twitterapi.io URL.

USE THIS WHEN: You have a specific link and want its full content.
RETURNS: Parsed content from the offline snapshot. If not found, you can set fetch_live=true (restricted to twitterapi.io/docs.twitterapi.io).`,
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL to fetch. Examples: https://twitterapi.io/privacy, /pricing, docs.twitterapi.io/introduction"
          },
          fetch_live: {
            type: "boolean",
            description: "If true and the URL is missing from the offline snapshot, fetch it live over HTTPS (allowed hosts only).",
            default: false
          }
        },
        required: ["url"]
      },
      outputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          source: { type: "string", enum: ["snapshot", "live"] },
          kind: { type: "string", enum: ["endpoint", "page", "blog"] },
          name: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          markdown: { type: "string" }
        },
        required: ["url", "source", "kind", "name", "markdown"]
      }
    },
    {
      name: "get_twitterapi_pricing",
      description: `Get TwitterAPI.io pricing information: credit system, endpoint costs, QPS limits.

USE THIS WHEN: You need to know API costs, credit calculations, or rate limits.
RETURNS: Pricing tiers, credit costs per endpoint, QPS limits by balance level.`,
      inputSchema: {
        type: "object",
        properties: {},
      },
      outputSchema: {
        type: "object",
        properties: {
          credits_per_usd: { type: "number" },
          minimum_charge: { type: "string" },
          costs: { type: "object", additionalProperties: { type: "string" } },
          qps_limits: {
            type: "object",
            properties: {
              free: { type: "string" },
              paid: { type: "object", additionalProperties: { type: "string" } }
            }
          },
          notes: { type: "array", items: { type: "string" } },
          markdown: { type: "string" }
        },
        required: ["markdown"]
      }
    },
    {
      name: "get_twitterapi_auth",
      description: `Get TwitterAPI.io authentication guide: API key usage, headers, code examples.

USE THIS WHEN: You need to set up authentication or see request examples.
RETURNS: API key header format, base URL, cURL/Python/JavaScript examples.`,
      inputSchema: {
        type: "object",
        properties: {},
      },
      outputSchema: {
        type: "object",
        properties: {
          header: { type: "string" },
          base_url: { type: "string" },
          dashboard_url: { type: "string" },
          examples: {
            type: "object",
            properties: {
              curl: { type: "string" },
              python: { type: "string" },
              javascript: { type: "string" }
            }
          },
          markdown: { type: "string" }
        },
        required: ["header", "base_url", "markdown"]
      }
    },
    ],
  };
});

// ========== TOOL HANDLERS ==========
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = request.params.arguments ?? {};
  const startTime = Date.now();
  let success = true;

  try {
    const result = await handleToolCall(name, args);
    const duration = Date.now() - startTime;
    logger.recordToolCall(name, duration, !result.isError);
    logger.info('tool_call', `${name} completed`, { duration, isError: result.isError });
    return result;
  } catch (error) {
    success = false;
    const duration = Date.now() - startTime;
    logger.recordToolCall(name, duration, false);
    logger.error('tool_call', `${name} failed`, error);

    return formatToolError({
      type: ErrorType.INTERNAL_ERROR,
      message: 'An unexpected error occurred',
      suggestion: 'Try again or use a different query',
      retryable: true
    });
  }
});

async function handleToolCall(name, args) {
  const data = loadDocs();

  switch (name) {
    case "search_twitterapi_docs": {
      // Validate input
      const validation = validateQuery(args.query);
      if (!validation.valid) {
        return formatToolError(validation.error);
      }

      // Validate and set max_results (default: 10, range: 1-20)
      const maxResults = Math.min(20, Math.max(1, args.max_results || 10));

      // Check cache first (include maxResults in cache key)
      const cacheKey = `search_${validation.value}_${maxResults}`;
      const cachedOutput = searchCache.get(cacheKey);
      if (cachedOutput) {
        logger.info('search', 'Cache hit', { query: validation.value, maxResults });
        const cachedMarkdown = typeof cachedOutput === 'string' ? cachedOutput : cachedOutput.markdown;
        const markdown = `${cachedMarkdown}\n\n*[Cached result]*`;
        const structuredContent = typeof cachedOutput === 'string'
          ? {
            query: validation.value,
            max_results: maxResults,
            cached: true,
            counts: { total: 0, endpoints: 0, pages: 0, blogs: 0 },
            results: [],
            markdown
          }
          : { ...cachedOutput, cached: true, markdown };
        return formatToolSuccess(markdown, structuredContent);
      }

      const results = searchInDocs(validation.value, maxResults);

      if (results.length === 0) {
        const allEndpoints = Object.keys(data.endpoints || {}).slice(0, 15);
        const markdown = `No results for "${validation.value}".

**Suggestions:**
- Try different terms: "search", "user", "tweet", "webhook", "stream"
- Use English keywords
- Try broader terms

**Available endpoints (sample):**
${allEndpoints.map(e => `- ${e}`).join('\n')}

**Pages:**
- pricing, qps_limits, tweet_filter_rules, changelog, authentication`;
        return formatToolSuccess(markdown, {
          query: validation.value,
          max_results: maxResults,
          cached: false,
          counts: { total: 0, endpoints: 0, pages: 0, blogs: 0 },
          results: [],
          markdown
        });
      }

      const grouped = {
        endpoint: results.filter(r => r.type === "endpoint"),
        page: results.filter(r => r.type === "page"),
        blog: results.filter(r => r.type === "blog"),
      };

      let output = `## "${validation.value}" - ${results.length} results (showing up to ${maxResults}):\n\n`;

      if (grouped.endpoint.length > 0) {
        output += `### API Endpoints (${grouped.endpoint.length})\n`;
        output += grouped.endpoint.slice(0, 15).map((r, i) =>
          `${i + 1}. **${r.name}** - ${r.method || "GET"} ${r.path || ""}\n   ${r.description || r.title || ""}`
        ).join("\n\n");
        output += "\n\n";
      }

      if (grouped.page.length > 0) {
        output += `### Pages (${grouped.page.length})\n`;
        output += grouped.page.slice(0, 10).map((r, i) =>
          `${i + 1}. **${r.name}** - ${r.title || ""}\n   ${r.url || ""}`
        ).join("\n\n");
        output += "\n\n";
      }

      if (grouped.blog.length > 0) {
        output += `### Blog Posts (${grouped.blog.length})\n`;
        output += grouped.blog.slice(0, 5).map((r, i) =>
          `${i + 1}. **${r.title || r.name}**\n   ${r.url || ""}`
        ).join("\n\n");
      }

      // Cache the result
      const structuredContent = {
        query: validation.value,
        max_results: maxResults,
        cached: false,
        counts: {
          total: results.length,
          endpoints: grouped.endpoint.length,
          pages: grouped.page.length,
          blogs: grouped.blog.length
        },
        results,
        markdown: output
      };
      searchCache.set(cacheKey, structuredContent);

      return formatToolSuccess(output, structuredContent);
    }

    case "get_twitterapi_endpoint": {
      // Validate input
      const validation = validateEndpointName(args.endpoint_name);
      if (!validation.valid) {
        return formatToolError(validation.error);
      }

      // Check cache first
      const cacheKey = `endpoint_${validation.value}`;
      const cachedOutput = endpointCache.get(cacheKey);
      if (cachedOutput) {
        logger.info('endpoint', 'Cache hit', { endpoint: validation.value });
        if (typeof cachedOutput === 'string') {
          return formatToolSuccess(cachedOutput, {
            endpoint_name: validation.value,
            cached: true,
            markdown: cachedOutput
          });
        }

        return formatToolSuccess(cachedOutput.markdown, { ...cachedOutput, cached: true });
      }

      const endpoint = data.endpoints?.[validation.value];

      if (!endpoint) {
        const available = Object.keys(data.endpoints || {});
        const suggestions = available
          .filter(e => e.includes(validation.value.split('_')[0]) || validation.value.includes(e.split('_')[0]))
          .slice(0, 10);

        return formatToolError({
          type: ErrorType.NOT_FOUND,
          message: `Endpoint "${validation.value}" not found`,
          suggestion: suggestions.length > 0
            ? `Similar endpoints: ${suggestions.join(', ')}`
            : `Use list_twitterapi_endpoints to see all ${available.length} available endpoints`,
          retryable: false
        });
      }

      const curlExample =
        endpoint.curl_example ||
        `curl --request ${endpoint.method || 'GET'} \\
  --url https://api.twitterapi.io${endpoint.path || ''} \\
  --header 'x-api-key: YOUR_API_KEY'`;

      const info = `# ${endpoint.title || validation.value}

## Endpoint Details
- **Method:** ${endpoint.method || "GET"}
- **Path:** ${endpoint.path || "Unknown"}
- **Full URL:** https://api.twitterapi.io${endpoint.path || ""}
- **Documentation:** ${endpoint.url}

## Description
${endpoint.description || "No description available."}

${endpoint.parameters?.length > 0 ? `## Parameters
${endpoint.parameters.map(p => `- **${p.name}**${p.required ? ' (required)' : ''}: ${p.description}`).join('\n')}` : ''}

## cURL Example
\`\`\`bash
${curlExample}
\`\`\`

${endpoint.code_snippets?.length > 0 ? `## Code Examples
\`\`\`
${endpoint.code_snippets.join("\n")}
\`\`\`` : ""}

## Full Documentation
${endpoint.raw_text || "No additional content available."}`;

      // Cache the result
      const structuredContent = {
        endpoint_name: validation.value,
        title: endpoint.title || validation.value,
        method: endpoint.method || "GET",
        path: endpoint.path || "",
        full_url: `https://api.twitterapi.io${endpoint.path || ""}`,
        doc_url: endpoint.url || "",
        description: endpoint.description || "",
        parameters: endpoint.parameters || [],
        curl_example: curlExample,
        code_snippets: endpoint.code_snippets || [],
        raw_text: endpoint.raw_text || "",
        cached: false,
        markdown: info
      };
      endpointCache.set(cacheKey, structuredContent);

      return formatToolSuccess(info, structuredContent);
    }

    case "list_twitterapi_endpoints": {
      // Validate category (optional)
      const validation = validateCategory(args.category);
      if (!validation.valid) {
        return formatToolError(validation.error);
      }

      const endpoints = Object.entries(data.endpoints || {});

      const categories = {
        user: [], tweet: [], list: [], community: [], trend: [],
        dm: [], action: [], webhook: [], stream: [], other: [],
      };

      for (const [name, ep] of endpoints) {
        if (name.includes("user") || name.includes("follow")) {
          categories.user.push({ name, ...ep });
        } else if (name.includes("tweet") || name.includes("search") || name.includes("article")) {
          categories.tweet.push({ name, ...ep });
        } else if (name.includes("list")) {
          categories.list.push({ name, ...ep });
        } else if (name.includes("community")) {
          categories.community.push({ name, ...ep });
        } else if (name.includes("trend")) {
          categories.trend.push({ name, ...ep });
        } else if (name.includes("dm")) {
          categories.dm.push({ name, ...ep });
        } else if (name.includes("webhook") || name.includes("rule")) {
          categories.webhook.push({ name, ...ep });
        } else if (name.includes("monitor") || name.includes("stream")) {
          categories.stream.push({ name, ...ep });
        } else if (["login", "like", "retweet", "create", "delete", "upload"].some(k => name.includes(k))) {
          categories.action.push({ name, ...ep });
        } else {
          categories.other.push({ name, ...ep });
        }
      }

      const allStructured = [];
      for (const [cat, eps] of Object.entries(categories)) {
        for (const ep of eps) {
          allStructured.push({
            name: ep.name,
            method: ep.method || "GET",
            path: ep.path || "",
            description: ep.description || "",
            category: cat
          });
        }
      }

      if (validation.value && categories[validation.value]) {
        const filtered = allStructured.filter((e) => e.category === validation.value);
        const markdown = `## ${validation.value.toUpperCase()} Endpoints (${filtered.length})

${filtered.map((e) => `- **${e.name}**: ${e.method} ${e.path}\n  ${e.description}`).join("\n\n")}`;
        return formatToolSuccess(markdown, {
          category: validation.value,
          total: endpoints.length,
          endpoints: filtered,
          markdown
        });
      }

      let output = `# TwitterAPI.io Endpoints (Total: ${endpoints.length})\n\n`;
      for (const [cat, eps] of Object.entries(categories)) {
        if (eps.length > 0) {
          output += `## ${cat.toUpperCase()} (${eps.length})\n`;
          output += eps.map((e) => `- **${e.name}**: ${e.method || "GET"} ${e.path || ""}`).join("\n");
          output += "\n\n";
        }
      }
      return formatToolSuccess(output, {
        category: null,
        total: endpoints.length,
        endpoints: allStructured,
        markdown: output
      });
    }

    case "get_twitterapi_guide": {
      // Validate input
      const validation = validateGuideName(args.guide_name, Object.keys(data.pages || {}));
      if (!validation.valid) {
        return formatToolError(validation.error);
      }

      const page = data.pages?.[validation.value];

      if (!page) {
        return formatToolError({
          type: ErrorType.NOT_FOUND,
          message: `Guide "${validation.value}" not found`,
          suggestion: `Available guides: ${Object.keys(data.pages || {}).join(', ')}`,
          retryable: false
        });
      }

      const output = formatGuideMarkdown(validation.value, page);

      return formatToolSuccess(output, {
        guide_name: validation.value,
        title: page.title || validation.value,
        url: page.url || "",
        description: page.description || "",
        headers: page.headers || [],
        paragraphs: page.paragraphs || [],
        list_items: page.list_items || [],
        code_snippets: page.code_snippets || [],
        raw_text: page.raw_text || "",
        markdown: output
      });
    }

    case "get_twitterapi_url": {
      const validation = validateTwitterApiUrl(args.url);
      if (!validation.valid) {
        return formatToolError(validation.error);
      }

      const canonicalUrl = validation.value;
      const fetchLive = Boolean(args.fetch_live);

      const snapshotCacheKey = `url_snapshot_${canonicalUrl}`;
      const cachedSnapshot = urlCache.get(snapshotCacheKey);
      if (cachedSnapshot) {
        const markdown = `${cachedSnapshot.markdown}\n\n*[Cached result]*`;
        return formatToolSuccess(markdown, { ...cachedSnapshot, markdown });
      }

      const match = findSnapshotItemByUrl(data, canonicalUrl);
      if (match) {
        const markdown = match.kind === 'endpoint'
          ? formatEndpointMarkdown(match.name, match.item)
          : formatGuideMarkdown(match.name, match.item);

        const structuredContent = {
          url: canonicalUrl,
          source: 'snapshot',
          kind: match.kind,
          name: match.name,
          title: match.item?.title || match.name,
          description: match.item?.description || '',
          markdown
        };

        urlCache.set(snapshotCacheKey, structuredContent);
        return formatToolSuccess(markdown, structuredContent);
      }

      if (!fetchLive) {
        return formatToolError({
          type: ErrorType.NOT_FOUND,
          message: `URL not found in offline snapshot: ${canonicalUrl}`,
          suggestion: 'Run `npm run scrape` to refresh `data/docs.json`, or call again with { fetch_live: true }',
          retryable: false
        });
      }

      const liveCacheKey = `url_live_${canonicalUrl}`;
      const cachedLive = urlCache.get(liveCacheKey);
      if (cachedLive) {
        const markdown = `${cachedLive.markdown}\n\n*[Cached result]*`;
        return formatToolSuccess(markdown, { ...cachedLive, markdown });
      }

      try {
        const response = await fetch(canonicalUrl, { redirect: 'follow' });
        if (!response.ok) {
          return formatToolError({
            type: ErrorType.NOT_FOUND,
            message: `Failed to fetch URL (${response.status}): ${canonicalUrl}`,
            suggestion: 'Check that the URL is correct and accessible',
            retryable: response.status >= 500
          });
        }

        const html = await response.text();
        const extracted = extractHtmlContent(html);
        const parsed = new URL(canonicalUrl);

        let kind = 'page';
        let name = 'page';

        if (parsed.hostname === 'docs.twitterapi.io' && parsed.pathname.includes('/api-reference/endpoint/')) {
          const slug = parsed.pathname.split('/api-reference/endpoint/')[1]?.replace(/\/+$/g, '');
          if (slug) {
            kind = 'endpoint';
            name = slug;
          }
        } else if (parsed.hostname === 'twitterapi.io' && parsed.pathname.startsWith('/blog/')) {
          const slug = parsed.pathname.replace(/^\/blog\//, '');
          kind = 'blog';
          name = `blog_${normalizeKeyForName(slug)}`;
        } else if (parsed.pathname === '/') {
          name = 'home';
        } else {
          name = normalizeKeyForName(parsed.pathname.replace(/^\/+|\/+$/g, '').replace(/\//g, '_'));
        }

        const page = { ...extracted, url: canonicalUrl };
        const markdown = formatGuideMarkdown(name, page);

        const structuredContent = {
          url: canonicalUrl,
          source: 'live',
          kind,
          name,
          title: extracted.title || name,
          description: extracted.description || '',
          markdown
        };

        urlCache.set(liveCacheKey, structuredContent);
        return formatToolSuccess(markdown, structuredContent);
      } catch (error) {
        logger.error('url_fetch', `Failed to fetch URL: ${canonicalUrl}`, error);
        return formatToolError({
          type: ErrorType.TIMEOUT,
          message: 'Failed to fetch URL',
          suggestion: 'Try again, or run `npm run scrape` to include this page in the offline snapshot',
          retryable: true
        });
      }
    }

    case "get_twitterapi_pricing": {
      const pricing = data.pricing || {};
      const qps = data.qps_limits || {};

      const notes = [
        'Credits never expire',
        'Bonus credits valid for 30 days',
        'Up to 5% discount on bulk purchases',
        'List endpoints: 150 credits/request',
        '~97% cheaper than official Twitter API'
      ];

      const markdown = `# TwitterAPI.io Pricing

## Credit System
- **1 USD = ${pricing.credits_per_usd?.toLocaleString() || "100,000"} Credits**

## Endpoint Costs
${Object.entries(pricing.costs || {}).map(([k, v]) => `- **${k}**: ${v}`).join("\n")}

## Minimum Charge
${pricing.minimum_charge || "15 credits ($0.00015) per request"}

## QPS (Queries Per Second) Limits

### Free Users
${qps.free || "1 request per 5 seconds"}

### By Balance Level
${Object.entries(qps.paid || {}).map(([k, v]) => `- **${k.replace(/_/g, " ")}**: ${v}`).join("\n")}

## Important Notes
- Credits never expire
- Bonus credits valid for 30 days
- Up to 5% discount on bulk purchases
- List endpoints: 150 credits/request

## Cost Comparison
TwitterAPI.io is **~97% cheaper** than official Twitter API.
- Twitter Pro: $5,000/month
- TwitterAPI.io equivalent: ~$150/month`;

      return formatToolSuccess(markdown, {
        credits_per_usd: pricing.credits_per_usd || 100000,
        minimum_charge: pricing.minimum_charge || "15 credits ($0.00015) per request",
        costs: pricing.costs || {},
        qps_limits: {
          free: qps.free || "1 request per 5 seconds",
          paid: qps.paid || {}
        },
        notes,
        markdown
      });
    }

    case "get_twitterapi_auth": {
      const auth = data.authentication || {};

      const header = auth.header || "x-api-key";
      const baseUrl = auth.base_url || "https://api.twitterapi.io";
      const dashboardUrl = auth.dashboard_url || "https://twitterapi.io/dashboard";

      const examples = {
        curl: `curl -X GET "${baseUrl}/twitter/user/info?userName=elonmusk" \\\n  -H "${header}: YOUR_API_KEY"`,
        python:
          `import requests\n\nresponse = requests.get(\n    "${baseUrl}/twitter/user/info",\n    params={"userName": "elonmusk"},\n    headers={"${header}": "YOUR_API_KEY"}\n)\nprint(response.json())`,
        javascript:
          `const response = await fetch(\n  "${baseUrl}/twitter/user/info?userName=elonmusk",\n  { headers: { "${header}": "YOUR_API_KEY" } }\n);\nconst data = await response.json();`
      };

      const markdown = `# TwitterAPI.io Authentication

## API Key Usage
All requests require the \`${header}\` header.

## Base URL
\`${baseUrl}\`

## Getting Your API Key
1. Go to ${dashboardUrl}
2. Sign up / Log in
3. Copy your API key from the dashboard

## Request Examples

### cURL
\`\`\`bash
${examples.curl}
\`\`\`

### Python
\`\`\`python
${examples.python}
\`\`\`

### JavaScript
\`\`\`javascript
${examples.javascript}
\`\`\``;

      return formatToolSuccess(markdown, {
        header,
        base_url: baseUrl,
        dashboard_url: dashboardUrl,
        examples,
        markdown
      });
    }

    default:
      return formatToolError({
        type: ErrorType.NOT_FOUND,
        message: `Unknown tool: ${name}`,
        suggestion: 'Available tools: search_twitterapi_docs, get_twitterapi_endpoint, list_twitterapi_endpoints, get_twitterapi_guide, get_twitterapi_url, get_twitterapi_pricing, get_twitterapi_auth',
        retryable: false
      });
  }
}

// ========== RESOURCES ==========
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    // Documentation resources
    {
      uri: "twitterapi://docs/all",
      mimeType: "application/json",
      name: "All TwitterAPI.io Documentation",
      description: "52 endpoints + guide pages + blog posts",
    },
    {
      uri: "twitterapi://docs/endpoints",
      mimeType: "application/json",
      name: "API Endpoint List",
      description: "Summary of all API endpoints",
    },
    {
      uri: "twitterapi://endpoints/list",
      mimeType: "application/json",
      name: "API Endpoints (Alias)",
      description: "Alias of twitterapi://docs/endpoints",
    },
    {
      uri: "twitterapi://docs/guides",
      mimeType: "application/json",
      name: "Guide Pages",
      description: "Pricing, QPS limits, filter rules, etc.",
    },
    // Static guide resources (Phase 2)
    {
      uri: "twitterapi://guides/pricing",
      mimeType: "text/markdown",
      name: "Pricing Guide",
      description: "Credit system, endpoint costs, QPS limits",
    },
    {
      uri: "twitterapi://guides/authentication",
      mimeType: "text/markdown",
      name: "Authentication Guide",
      description: "API key setup, headers, code examples",
    },
    {
      uri: "twitterapi://guides/qps_limits",
      mimeType: "text/markdown",
      name: "Rate Limits Guide",
      description: "QPS limits by balance level",
    },
    {
      uri: "twitterapi://guides/qps-limits",
      mimeType: "text/markdown",
      name: "Rate Limits Guide (Alias)",
      description: "Alias of twitterapi://guides/qps_limits",
    },
    {
      uri: "twitterapi://guides/tweet_filter_rules",
      mimeType: "text/markdown",
      name: "Tweet Filter Rules",
      description: "Advanced search filter syntax",
    },
    {
      uri: "twitterapi://guides/filter-rules",
      mimeType: "text/markdown",
      name: "Tweet Filter Rules (Alias)",
      description: "Alias of twitterapi://guides/tweet_filter_rules",
    },
    {
      uri: "twitterapi://guides/changelog",
      mimeType: "text/markdown",
      name: "Changelog",
      description: "API changelog",
    },
    {
      uri: "twitterapi://guides/introduction",
      mimeType: "text/markdown",
      name: "Introduction",
      description: "Overview of TwitterAPI.io",
    },
    {
      uri: "twitterapi://guides/readme",
      mimeType: "text/markdown",
      name: "README",
      description: "Project overview and usage",
    },
    // Monitoring resources
    {
      uri: "twitterapi://metrics",
      mimeType: "application/json",
      name: "Server Metrics",
      description: "Performance metrics, SLO tracking, cache stats",
    },
    {
      uri: "twitterapi://health",
      mimeType: "application/json",
      name: "Health Check",
      description: "Server health status and data freshness",
    },
    {
      uri: "twitterapi://status/freshness",
      mimeType: "application/json",
      name: "Data Freshness",
      description: "Last docs update time and freshness status",
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  const data = loadDocs();

  // Documentation resources
  if (uri === "twitterapi://docs/all") {
    return {
      contents: [{
        uri,
        mimeType: "application/json",
        text: JSON.stringify(data, null, 2),
      }],
    };
  }

  if (uri === "twitterapi://docs/endpoints" || uri === "twitterapi://endpoints/list") {
    const summary = Object.entries(data.endpoints || {}).map(([name, ep]) => ({
      name,
      method: ep.method,
      path: ep.path,
      description: ep.description,
    }));
    return {
      contents: [{
        uri,
        mimeType: "application/json",
        text: JSON.stringify(summary, null, 2),
      }],
    };
  }

  if (uri === "twitterapi://docs/guides") {
    return {
      contents: [{
        uri,
        mimeType: "application/json",
        text: JSON.stringify({ pages: data.pages, blogs: data.blogs }, null, 2),
      }],
    };
  }

  // Static guide resources (Phase 2 - pre-rendered markdown for quick access)
  if (uri === "twitterapi://guides/pricing") {
    const pricing = data.pricing || {};
    const qps = data.qps_limits || {};
    return {
      contents: [{
        uri,
        mimeType: "text/markdown",
        text: `# TwitterAPI.io Pricing

## Credit System
- **1 USD = ${pricing.credits_per_usd?.toLocaleString() || "100,000"} Credits**

## Endpoint Costs
${Object.entries(pricing.costs || {}).map(([k, v]) => `- **${k}**: ${v}`).join("\n")}

## QPS Limits by Balance Level
${Object.entries(qps.paid || {}).map(([k, v]) => `- **${k.replace(/_/g, " ")}**: ${v}`).join("\n")}

## Important Notes
- Credits never expire
- Bonus credits valid for 30 days
- ~97% cheaper than official Twitter API`,
      }],
    };
  }

  if (uri === "twitterapi://guides/authentication") {
    const auth = data.authentication || {};
    return {
      contents: [{
        uri,
        mimeType: "text/markdown",
        text: `# TwitterAPI.io Authentication

## API Key Header
\`${auth.header || "x-api-key"}: YOUR_API_KEY\`

## Base URL
\`${auth.base_url || "https://api.twitterapi.io"}\`

## Quick Example
\`\`\`bash
curl -X GET "${auth.base_url || "https://api.twitterapi.io"}/twitter/user/info?userName=elonmusk" \\
  -H "${auth.header || "x-api-key"}: YOUR_API_KEY"
\`\`\``,
      }],
    };
  }

  if (uri === "twitterapi://guides/qps_limits" || uri === "twitterapi://guides/qps-limits") {
    const qps = data.qps_limits || {};
    return {
      contents: [{
        uri,
        mimeType: "text/markdown",
        text: `# TwitterAPI.io Rate Limits (QPS)

## Free Users
${qps.free || "1 request per 5 seconds"}

## Paid Users by Balance
${Object.entries(qps.paid || {}).map(([k, v]) => `- **${k.replace(/_/g, " ")}**: ${v}`).join("\n")}`,
      }],
    };
  }

  if (uri === "twitterapi://guides/tweet_filter_rules" || uri === "twitterapi://guides/filter-rules") {
    const page = data.pages?.tweet_filter_rules || {};
    return {
      contents: [{
        uri,
        mimeType: "text/markdown",
        text: `# Tweet Filter Rules

${page.raw_text || page.description || "Filter rules documentation not available."}`,
      }],
    };
  }

  if (uri === "twitterapi://guides/changelog") {
    const page = data.pages?.changelog || {};
    return {
      contents: [{
        uri,
        mimeType: "text/markdown",
        text: `# ${page.title || "Changelog"}

${page.raw_text || page.description || "Changelog not available."}`,
      }],
    };
  }

  if (uri === "twitterapi://guides/introduction") {
    const page = data.pages?.introduction || {};
    return {
      contents: [{
        uri,
        mimeType: "text/markdown",
        text: `# ${page.title || "Introduction"}

${page.raw_text || page.description || "Introduction not available."}`,
      }],
    };
  }

  if (uri === "twitterapi://guides/readme") {
    const page = data.pages?.readme || {};
    return {
      contents: [{
        uri,
        mimeType: "text/markdown",
        text: `# ${page.title || "README"}

${page.raw_text || page.description || "README not available."}`,
      }],
    };
  }

  // Monitoring resources
  if (uri === "twitterapi://metrics") {
    return {
      contents: [{
        uri,
        mimeType: "application/json",
        text: JSON.stringify(logger.getMetrics(getAllCacheStats(), getDataFreshness()), null, 2),
      }],
    };
  }

  if (uri === "twitterapi://health") {
    const freshness = getDataFreshness();
    const health = {
      status: freshness.status === 'stale' ? 'degraded' : 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      dataFreshness: freshness,
      cache: {
        search: searchCache.stats(),
        endpoints: endpointCache.stats(),
        urls: urlCache.stats()
      },
      sloStatus: {
        violations: logger.metrics.sloViolations,
        healthy: logger.metrics.sloViolations.alert === 0
      }
    };
    return {
      contents: [{
        uri,
        mimeType: "application/json",
        text: JSON.stringify(health, null, 2),
      }],
    };
  }

  if (uri === "twitterapi://status/freshness") {
    return {
      contents: [{
        uri,
        mimeType: "application/json",
        text: JSON.stringify(getDataFreshness(), null, 2),
      }],
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
});

// ========== COMPLETIONS HANDLER (for Glama.ai compatibility) ==========
server.setRequestHandler(CompleteRequestSchema, async () => {
  // Return empty completions - we don't provide autocomplete suggestions
  // but declaring the capability allows mcp-proxy to work correctly
  return {
    completion: {
      values: [],
      hasMore: false,
      total: 0
    }
  };
});

// ========== SERVER STARTUP ==========
async function main() {
  try {
    logger.info('init', 'Starting TwitterAPI.io Docs MCP Server v1.0.5');

    // Validate docs file exists
    if (!fs.existsSync(DOCS_PATH)) {
      throw new Error(`Documentation file not found: ${DOCS_PATH}`);
    }

    // Pre-load documentation
    const docs = loadDocs();
    const endpointCount = Object.keys(docs.endpoints || {}).length;
    const pageCount = Object.keys(docs.pages || {}).length;
    logger.info('init', 'Documentation validated', { endpoints: endpointCount, pages: pageCount });

    // Check data freshness
    const freshness = getDataFreshness();
    logger.info('init', 'Data freshness check', freshness);
    if (freshness.status === 'stale') {
      logger.warn('init', 'WARNING: Documentation data is stale! Consider refreshing.');
    }

    // Start cache cleanup scheduler
    startCacheCleanup();
    logger.info('init', 'Cache cleanup scheduler started (hourly)');

    // Log SLO configuration
    logger.info('init', 'SLO targets configured', {
      tools: Object.keys(SLO).length,
      targets: Object.entries(SLO).map(([t, s]) => `${t}: ${s.target}ms`)
    });

    // Connect transport
    const transport = new StdioServerTransport();
    await server.connect(transport);

    logger.info('init', 'MCP Server ready on stdio', {
      version: '1.0.5',
      features: [
        'offline snapshot',
        'endpoints + pages + blogs',
        'get_twitterapi_url (optional live fetch)',
        'structuredContent outputs',
        'MCP Resources',
        'data freshness',
        'trusted publishing'
      ]
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
      logger.info('shutdown', 'Received SIGINT, shutting down...');
      stopCacheCleanup();
      logger.info('shutdown', 'Final metrics', logger.getMetrics(getAllCacheStats(), getDataFreshness()));
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      logger.info('shutdown', 'Received SIGTERM, shutting down...');
      stopCacheCleanup();
      logger.info('shutdown', 'Final metrics', logger.getMetrics(getAllCacheStats(), getDataFreshness()));
      process.exit(0);
    });

  } catch (error) {
    logger.error('init', 'Fatal error during initialization', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('[FATAL] Unexpected error:', error);
  process.exit(1);
});

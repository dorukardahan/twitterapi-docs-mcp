#!/usr/bin/env node
/**
 * TwitterAPI.io Complete Documentation Scraper v2.1
 * Düzeltmeler:
 * - Path extraction bug fix (cURL'den doğru path çıkarma)
 * - İçerik truncation kaldırıldı
 * - Daha iyi parameter parsing
 * - Sitemap + blog index ile otomatik link keşfi
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const SITE_SITEMAP_URL = 'https://twitterapi.io/sitemap.xml';
const BLOG_INDEX_URL = 'https://twitterapi.io/blog/';
const DOCS_SITEMAP_URL = 'https://docs.twitterapi.io/sitemap.xml';
const DOCS_ENDPOINT_PREFIX = 'https://docs.twitterapi.io/api-reference/endpoint/';

const GUIDE_PAGE_KEYS = new Set([
  'pricing',
  'qps_limits',
  'tweet_filter_rules',
  'changelog',
  'readme',
  'twitter_stream',
  'introduction',
  'authentication',
]);

const BLOG_KEY_OVERRIDES = new Map([
  ['twitter-api-pricing-2025', 'blog_pricing_2025'],
  ['twitter-analytics-api-guide', 'blog_analytics_guide'],
  ['apify-alternative-for-twitter', 'blog_apify_alternative'],
  ['build-twitter-apps-with-kiro-ai-ide', 'blog_kiro_ai'],
  ['resources-and-tools', 'blog_resources'],
  ['how-to-monitor-twitter-accounts-for-new-tweets-in-real-time', 'blog_monitor_tweets'],
]);

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : require('http');
    client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectedUrl = new URL(res.headers.location, url).toString();
        return fetchPage(redirectedUrl).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
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
    .replace(/&#39;/g, "'");
}

function extractSitemapLocs(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map(m => m[1].trim())
    .filter(Boolean);
}

function normalizeKey(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

function stripSlashes(value) {
  return value.replace(/^\/+|\/+$/g, '');
}

function pageKeyFromUrl(url) {
  const { pathname } = new URL(url);
  const clean = stripSlashes(pathname);
  if (!clean) return 'home';
  if (clean === 'blog') return 'blog_index';
  return normalizeKey(clean.replace(/\//g, '_'));
}

function blogKeyFromUrl(url) {
  const { pathname } = new URL(url);
  const clean = stripSlashes(pathname);
  if (!clean || clean === 'blog') return 'blog_index';

  const slug = clean.startsWith('blog/') ? clean.slice('blog/'.length) : clean;
  const override = BLOG_KEY_OVERRIDES.get(slug);
  if (override) return override;

  return `blog_${normalizeKey(slug)}`;
}

function categoryForPageKey(key, host) {
  if (host === 'docs.twitterapi.io') return 'docs';
  if (key === 'blog_index') return 'blog';
  if (GUIDE_PAGE_KEYS.has(key)) return 'guide';
  return 'info';
}

function discoverBlogUrlsFromIndex(html) {
  const urls = new Set();
  const matches = html.matchAll(/href=["'](\/blog\/[^"'?#]+)\/?["']/gi);
  for (const m of matches) {
    const path = m[1].replace(/\/+$/g, '');
    if (path === '/blog') continue;
    urls.add(`https://twitterapi.io${path}`);
  }
  return [...urls];
}

async function discoverScrapeTargets() {
  // twitterapi.io (marketing + blog)
  const siteXml = await fetchPage(SITE_SITEMAP_URL);
  const siteUrls = new Set(extractSitemapLocs(siteXml));

  // Blog index often contains more posts than sitemap
  try {
    const blogIndexHtml = await fetchPage(BLOG_INDEX_URL);
    for (const u of discoverBlogUrlsFromIndex(blogIndexHtml)) {
      siteUrls.add(u);
    }
  } catch (_err) {
    // Non-fatal: fall back to sitemap + overrides
  }

  // Ensure legacy/known posts remain included even if not discoverable
  for (const slug of BLOG_KEY_OVERRIDES.keys()) {
    siteUrls.add(`https://twitterapi.io/blog/${slug}`);
  }

  const sitePages = [];
  const siteBlogs = [];
  for (const u of siteUrls) {
    const parsed = new URL(u);
    if (parsed.hostname !== 'twitterapi.io') continue;

    const isBlogPost = parsed.pathname.startsWith('/blog/')
      && parsed.pathname !== '/blog/'
      && parsed.pathname !== '/blog';

    if (isBlogPost) {
      const name = blogKeyFromUrl(u);
      siteBlogs.push({ url: u, name, category: 'blog' });
    } else {
      const name = pageKeyFromUrl(u);
      sitePages.push({ url: u, name, category: categoryForPageKey(name, parsed.hostname) });
    }
  }

  // docs.twitterapi.io (API reference + docs pages)
  const docsXml = await fetchPage(DOCS_SITEMAP_URL);
  const docsUrls = extractSitemapLocs(docsXml);

  const endpoints = [];
  const docsPages = [];
  for (const u of docsUrls) {
    if (!u.startsWith('https://docs.twitterapi.io/')) continue;
    if (u.startsWith(DOCS_ENDPOINT_PREFIX)) {
      const slug = u.slice(DOCS_ENDPOINT_PREFIX.length).replace(/\/+$/g, '');
      if (slug) endpoints.push(slug);
    } else {
      const name = pageKeyFromUrl(u);
      docsPages.push({ url: u, name, category: 'docs' });
    }
  }

  // Stable ordering
  sitePages.sort((a, b) => a.name.localeCompare(b.name));
  siteBlogs.sort((a, b) => a.name.localeCompare(b.name));
  docsPages.sort((a, b) => a.name.localeCompare(b.name));
  endpoints.sort();

  return { sitePages, siteBlogs, docsPages, endpoints };
}

function extractMainSiteContent(html, pageName) {
  const result = {
    name: pageName,
    scraped_at: new Date().toISOString(),
    type: 'page'
  };

  // Title
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) result.title = decodeHtmlEntities(titleMatch[1].trim());

  // Meta description
  const descMatch = html.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i);
  if (descMatch) result.description = decodeHtmlEntities(descMatch[1]);

  // H1, H2, H3 headers
  const headers = [];
  const h1Match = html.matchAll(/<h1[^>]*>([^<]+)<\/h1>/gi);
  for (const m of h1Match) headers.push({ level: 1, text: decodeHtmlEntities(m[1].trim()) });
  const h2Match = html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/gi);
  for (const m of h2Match) headers.push({ level: 2, text: decodeHtmlEntities(m[1].trim()) });
  const h3Match = html.matchAll(/<h3[^>]*>([^<]+)<\/h3>/gi);
  for (const m of h3Match) headers.push({ level: 3, text: decodeHtmlEntities(m[1].trim()) });
  if (headers.length) result.headers = headers;

  // Paragraphs - TÜM paragrafları al
  const paragraphs = [];
  const pMatch = html.matchAll(/<p[^>]*>([^<]+)<\/p>/gi);
  for (const m of pMatch) {
    const text = decodeHtmlEntities(m[1].trim());
    if (text.length > 10) paragraphs.push(text);
  }
  if (paragraphs.length) result.paragraphs = paragraphs; // Limit kaldırıldı

  // Code blocks - TÜM code bloklarını al
  const codeBlocks = [];
  const codeMatch = html.matchAll(/<code[^>]*>([^<]+)<\/code>/gi);
  for (const m of codeMatch) codeBlocks.push(decodeHtmlEntities(m[1]));
  if (codeBlocks.length) result.code_snippets = codeBlocks; // Limit kaldırıldı

  // Pre blocks (büyük kod blokları)
  const preBlocks = [];
  const preMatch = html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi);
  for (const m of preMatch) {
    const text = m[1].replace(/<[^>]+>/g, '').trim();
    if (text.length > 10) preBlocks.push(decodeHtmlEntities(text));
  }
  if (preBlocks.length) result.pre_blocks = preBlocks;

  // Lists (li items) - TÜM list itemları al
  const listItems = [];
  const liMatch = html.matchAll(/<li[^>]*>([^<]+)<\/li>/gi);
  for (const m of liMatch) {
    const text = decodeHtmlEntities(m[1].trim());
    if (text.length > 3) listItems.push(text);
  }
  if (listItems.length) result.list_items = listItems; // Limit kaldırıldı

  // Raw text extraction - TAM metin, truncation YOK
  result.raw_text = decodeHtmlEntities(html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());

  return result;
}

function extractEndpointContent(html, endpointName) {
  const result = {
    name: endpointName,
    url: `https://docs.twitterapi.io/api-reference/endpoint/${endpointName}`,
    scraped_at: new Date().toISOString(),
    type: 'endpoint'
  };

  // Title
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) result.title = decodeHtmlEntities(titleMatch[1].replace(' – Docs', '').trim());

  // Meta description
  const descMatch = html.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i);
  if (descMatch) result.description = decodeHtmlEntities(descMatch[1]);

  // ========== BUG FIX v2.1: Path çıkarma - Mintlify HTML formatı ==========
  // Mintlify, Next.js SSR kullanıyor ve içerik span tag'leri içinde syntax-highlighted

  // Yöntem 1: JSON data içinden path çıkar (en güvenilir)
  // Format: "path":"/twitter/user/info"
  const jsonPathMatch = html.match(/"path"\s*:\s*"(\/twitter\/[^"]+)"/i);
  if (jsonPathMatch) {
    result.path = jsonPathMatch[1].trim();
  }

  // Yöntem 2: Span içindeki URL'den çıkar
  // Format: https://api.twitterapi.io/twitter/user/info</span>
  // veya: https://api.twitterapi.io/oapi/my/info</span>
  if (!result.path) {
    const spanUrlMatch = html.match(/https:\/\/api\.twitterapi\.io(\/(?:twitter|oapi)\/[^<\s"'\\]+)/i);
    if (spanUrlMatch) {
      result.path = spanUrlMatch[1].replace(/\\$/, '').trim();
    }
  }

  // Yöntem 3: Plain text URL (fallback)
  if (!result.path) {
    const plainUrlMatch = html.match(/--url\s+https?:\/\/api\.twitterapi\.io([^\s\\'"<]+)/i);
    if (plainUrlMatch) {
      result.path = plainUrlMatch[1].replace(/\\$/, '').trim();
    }
  }

  // Method'u bul - JSON veya text'ten
  // JSON format: "method":"GET"
  const jsonMethodMatch = html.match(/"method"\s*:\s*"(GET|POST|PUT|DELETE|PATCH)"/i);
  if (jsonMethodMatch) {
    result.method = jsonMethodMatch[1].toUpperCase();
  }

  // Fallback: cURL'deki --request'ten
  if (!result.method) {
    const curlMethodMatch = html.match(/--request\s+(GET|POST|PUT|DELETE|PATCH)/i);
    if (curlMethodMatch) {
      result.method = curlMethodMatch[1].toUpperCase();
    }
  }

  // Alternatif: Endpoint başlığından method ve path
  // Format: "GET / twitter / user / info"
  if (!result.path) {
    const endpointHeaderMatch = html.match(/(GET|POST|PUT|DELETE|PATCH)\s+\/\s*([a-z_\/\s]+)/i);
    if (endpointHeaderMatch) {
      if (!result.method) result.method = endpointHeaderMatch[1].toUpperCase();
      result.path = '/' + endpointHeaderMatch[2].replace(/\s+/g, '').trim();
    }
  }

  // ========== Query Parameters Çıkarma ==========
  const parameters = [];

  // Query Parameters section'ını bul
  const paramSection = html.match(/Query Parameters[\s\S]*?(?=Response|Authorizations|$)/i);
  if (paramSection) {
    // Parameter adlarını ve açıklamalarını çıkar
    const paramMatches = paramSection[0].matchAll(/(\w+)\s+string[^<]*(?:required)?[^<]*(?:<[^>]*>)*\s*([^<]+)/gi);
    for (const m of paramMatches) {
      const paramName = m[1].trim();
      const paramDesc = decodeHtmlEntities(m[2].trim());
      if (paramName && paramName !== 'string' && paramDesc.length > 5) {
        parameters.push({
          name: paramName,
          description: paramDesc,
          required: paramSection[0].toLowerCase().includes(paramName.toLowerCase() + '" required') ||
                   paramSection[0].toLowerCase().includes(paramName.toLowerCase() + ' required')
        });
      }
    }
  }
  if (parameters.length) result.parameters = parameters;

  // ========== Response Schema Çıkarma ==========
  const responseMatch = html.match(/Response\s+200[\s\S]*?(?=Response\s+\d{3}|Authorizations|$)/i);
  if (responseMatch) {
    const responseFields = [];
    const fieldMatches = responseMatch[0].matchAll(/(\w+)\.\s*(\w+)\s+(string|integer|boolean|object|array)/gi);
    for (const m of fieldMatches) {
      responseFields.push({
        parent: m[1],
        field: m[2],
        type: m[3]
      });
    }
    if (responseFields.length) result.response_fields = responseFields.slice(0, 50);
  }

  // Code blocks - TÜM code bloklarını al
  const codeBlocks = [];
  const codeMatch = html.matchAll(/<code[^>]*>([^<]+)<\/code>/gi);
  for (const m of codeMatch) {
    const code = decodeHtmlEntities(m[1]);
    if (code.length > 5) codeBlocks.push(code);
  }
  if (codeBlocks.length) result.code_snippets = codeBlocks;

  // cURL örneğini ayrıca sakla
  const curlExample = html.match(/curl\s+--request[^<]+/i);
  if (curlExample) {
    result.curl_example = decodeHtmlEntities(curlExample[0]
      .replace(/\\n/g, '\n')
      .replace(/\s+/g, ' ')
      .trim());
  }

  // Raw text - TAM içerik, truncation YOK
  result.raw_text = decodeHtmlEntities(html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());

  return result;
}

async function scrapeAll() {
  console.log('🚀 TwitterAPI.io v2.1 Scraper - Tüm içerikler çekiliyor...\n');

  console.log('🔎 Link keşfi (sitemap + blog index)...\n');
  const targets = await discoverScrapeTargets();

  const pagesToScrape = [...targets.sitePages, ...targets.docsPages];
  const blogsToScrape = targets.siteBlogs;
  const endpointsToScrape = targets.endpoints;

  const docs = {
    meta: {
      source: 'https://twitterapi.io + https://docs.twitterapi.io',
      scraped_at: new Date().toISOString(),
      version: '2.1',
      total_endpoints: endpointsToScrape.length,
      total_pages: pagesToScrape.length,
      total_blogs: blogsToScrape.length
    },
    authentication: {
      header: 'x-api-key',
      header_value: 'YOUR_API_KEY',
      base_url: 'https://api.twitterapi.io',
      dashboard_url: 'https://twitterapi.io/dashboard'
    },
    qps_limits: {
      free: '1 request per 5 seconds',
      paid: {
        '1000_credits': '3 QPS',
        '5000_credits': '6 QPS',
        '10000_credits': '10 QPS',
        '50000_credits': '20 QPS'
      }
    },
    pricing: {
      credits_per_usd: 100000,
      costs: {
        tweets: '15 credits per tweet',
        profiles: '18 credits per user',
        followers: '15 credits per follower',
        list_calls: '150 credits per call'
      },
      minimum_charge: '15 credits ($0.00015) per request'
    },
    endpoints: {},
    pages: {},
    blogs: {}
  };

  console.log(`📄 Sayfalar çekiliyor... (${pagesToScrape.length})\n`);
  for (const page of pagesToScrape) {
    process.stdout.write(`  ${page.name}... `);
    try {
      const html = await fetchPage(page.url);
      const content = extractMainSiteContent(html, page.name);
      content.url = page.url;
      content.category = page.category;
      docs.pages[page.name] = content;
      console.log('✅');
    } catch (err) {
      console.log('❌', err.message);
    }
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n📰 Blog yazıları çekiliyor... (${blogsToScrape.length})\n`);
  for (const blog of blogsToScrape) {
    process.stdout.write(`  ${blog.name}... `);
    try {
      const html = await fetchPage(blog.url);
      const content = extractMainSiteContent(html, blog.name);
      content.url = blog.url;
      content.category = 'blog';
      docs.blogs[blog.name] = content;
      console.log('✅');
    } catch (err) {
      console.log('❌', err.message);
    }
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n📚 API Endpoint dokümanları çekiliyor... (${endpointsToScrape.length})\n`);
  for (const endpoint of endpointsToScrape) {
    const url = `https://docs.twitterapi.io/api-reference/endpoint/${endpoint}`;
    process.stdout.write(`  ${endpoint}... `);
    try {
      const html = await fetchPage(url);
      docs.endpoints[endpoint] = extractEndpointContent(html, endpoint);
      console.log('✅');
    } catch (err) {
      console.log('❌', err.message);
      docs.endpoints[endpoint] = { name: endpoint, error: err.message, url };
    }
    await new Promise(r => setTimeout(r, 150));
  }

  const outPath = path.join(__dirname, 'data', 'docs.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(docs, null, 2));

  const stats = {
    endpoints: Object.keys(docs.endpoints).length,
    pages: Object.keys(docs.pages).length,
    blogs: Object.keys(docs.blogs).length
  };

  console.log(`
✅ Scraping tamamlandı! (v2.1)
   - ${stats.endpoints} endpoint
   - ${stats.pages} sayfa
   - ${stats.blogs} blog yazısı

📁 Kaydedildi: ${outPath}
`);
}

scrapeAll().catch(console.error);

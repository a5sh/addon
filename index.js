import puppeteer from "@cloudflare/puppeteer";

const MANIFEST = {
  id: 'moviesmod.addon',
  version: '0.9.0',
  name: 'MoviesMod Enhanced',
  description: 'Serverless link extractor with optimized SID resolution',
  types: ['movie', 'series'],
  catalogs: [],
  resources: ['stream'],
  idPrefixes: ['tt', 'tmdb:'],
  behaviorHints: { p2p: false, configurable: false },
};

const MOVIESMOD_BASE = 'https://moviesmod.army';
const cache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000;

// ============================================================================
// UTILITY FUNCTIONS (inspired by Nuvio Streams)
// ============================================================================

function stripTags(html) {
  return (html || '').replace(/<[^>]*>/g, '').trim();
}

function getMatch(text, regex, index = 1) {
  const match = text.match(regex);
  return match ? match[index] : null;
}

function extractFromHTML(html, pattern) {
  const match = html.match(pattern);
  return match ? match[1] || match[0] : null;
}

async function fetchWithRetry(url, options = {}, retries = 1) {
  const timeout = options.timeout || 15000;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: { 
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          ...options.headers 
        },
      });
      clearTimeout(timeoutId);
      if (response.status === 403 || response.status === 429) throw new Error(`Blocked: HTTP ${response.status}`);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.message.includes('Blocked')) throw error;
      if (attempt === retries) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
    }
  }
}

// ============================================================================
// LINK RESOLVER (inspired by Nuvio's linkResolver.js)
// ============================================================================

/**
 * Resolve SID (tech.unblockedgames.world) link to ?go= redirect
 * Key improvement: Handles the verify step where ?go= appears after form submission
 */
async function resolveSidToGoLink(sidUrl, browser, logger) {
  logger(`[SID] Starting SID resolution: ${sidUrl.substring(0, 80)}...`);

  if (!browser) {
    logger(`[SID] ✗ Browser not available`);
    return null;
  }

  let page;
  try {
    page = await browser.newPage();
    
    // Setup request interception to reduce bandwidth
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const rt = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(rt)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Step 1: Load the SID page
    logger(`[SID] Step 1: Loading SID page...`);
    await page.goto(sidUrl, { 
      waitUntil: 'domcontentloaded', 
      timeout: 15000 
    }).catch(e => logger(`[SID] Warning: ${e.message}`));

    await new Promise(r => setTimeout(r, 1000));

    // Step 2: Check for and handle verify button/form
    logger(`[SID] Step 2: Looking for verify mechanism...`);
    
    // Try multiple button selectors
    const selectors = [
      'button[type="submit"]',
      'a#two_steps_btn',
      'input[type="submit"]',
      'button:contains("Verify")',
      'button:contains("Continue")',
      'a.btn:contains("Verify")'
    ];

    let clicked = false;
    for (const selector of selectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          logger(`[SID] Step 2: Found and clicking button: ${selector}`);
          await element.click();
          await new Promise(r => setTimeout(r, 2000));
          clicked = true;
          break;
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    if (!clicked) {
      logger(`[SID] Step 2: No button found, checking for auto-redirects...`);
      // Wait for potential meta refresh or JS redirect
      await new Promise(r => setTimeout(r, 2000));
    }

    // Step 3: Extract ?go= from current page or URL
    logger(`[SID] Step 3: Extracting ?go= link...`);
    
    const currentUrl = page.url();
    logger(`[SID] Step 3: Current URL: ${currentUrl.substring(0, 100)}...`);

    let goLink = null;

    // Check if current URL already contains ?go=
    if (currentUrl.includes('?go=')) {
      goLink = currentUrl;
      logger(`[SID] ✓ Found ?go= in URL`);
    } else {
      // Look in page content
      const pageContent = await page.content();
      
      const patterns = [
        /href=["']([^"']*\?go=[^"']+)["']/i,
        /window\.location\.href\s*=\s*["']([^"']*\?go=[^"']+)["']/i,
        /(https?:[^\s"']+\?go=[^\s"']+)/i,
        /location\.replace?\s*\(\s*["']([^"']*\?go=[^"']+)["']\s*\)/i
      ];

      for (const pattern of patterns) {
        const match = pageContent.match(pattern);
        if (match) {
          goLink = match[1] || match[0];
          logger(`[SID] ✓ Found ?go= in page content`);
          break;
        }
      }
    }

    if (goLink) {
      if (!goLink.startsWith('http')) {
        const origin = new URL(sidUrl).origin;
        goLink = new URL(goLink, origin).href;
      }
      logger(`[SID] ✓ SUCCESS: ${goLink.substring(0, 80)}...`);
      return goLink;
    }

    logger(`[SID] ✗ Could not extract ?go= link`);
    return null;

  } catch (error) {
    logger(`[SID] ✗ Error: ${error.message}`);
    return null;
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (e) {
        // Ignore close errors
      }
    }
  }
}

/**
 * Follow ?go= redirect to driveseed/driveleech
 */
async function followGoRedirect(goUrl, browser, logger) {
  logger(`[Redirect] Following ?go=: ${goUrl.substring(0, 80)}...`);

  if (!browser) {
    logger(`[Redirect] ✗ Browser unavailable`);
    return null;
  }

  let page;
  try {
    page = await browser.newPage();
    
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const rt = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(rt)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(goUrl, { waitUntil: 'domcontentloaded', timeout: 12000 })
      .catch(e => logger(`[Redirect] Warning: ${e.message}`));

    await new Promise(r => setTimeout(r, 1500));

    const finalUrl = page.url();
    const html = await page.content();

    logger(`[Redirect] ✓ Landed: ${finalUrl.substring(0, 80)}...`);

    if (finalUrl.includes('driveseed')) {
      return { url: finalUrl, html, type: 'driveseed' };
    } else if (finalUrl.includes('driveleech')) {
      return { url: finalUrl, html, type: 'driveleech' };
    }

    return { url: finalUrl, html, type: 'other' };

  } catch (error) {
    logger(`[Redirect] ✗ Error: ${error.message}`);
    return null;
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (e) {}
    }
  }
}

/**
 * Extract download buttons from driveseed page
 */
async function extractDriveseedOptions(html, logger) {
  logger(`[Driveseed] Extracting download options...`);

  const downloadOptions = [];
  const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    const text = stripTags(match[2]).toLowerCase();

    if (href.includes('instant') || href.includes('video-seed') || text.includes('instant')) {
      downloadOptions.push({ title: 'Instant Download', type: 'instant', url: href, priority: 1 });
    } else if (href.includes('resume') && href.includes('cloud')) {
      downloadOptions.push({ title: 'Resume Cloud', type: 'resume', url: href, priority: 2 });
    } else if (href.includes('worker') || href.includes('workerseed')) {
      downloadOptions.push({ title: 'Resume Worker Bot', type: 'worker', url: href, priority: 3 });
    }
  }

  // Deduplicate
  const uniqueOptions = [];
  const seenUrls = new Set();
  for (const option of downloadOptions) {
    if (!seenUrls.has(option.url)) {
      seenUrls.add(option.url);
      uniqueOptions.push(option);
    }
  }

  uniqueOptions.sort((a, b) => a.priority - b.priority);

  const size = getMatch(html, /Size\s*:\s*([0-9.,]+\s*[KMGT]B)/i);
  const fileName = getMatch(html, /Name\s*:\s*([^<\n]+)/i, 1)?.trim();

  logger(`[Driveseed] ✓ Found ${uniqueOptions.length} options`);
  return { downloadOptions: uniqueOptions, size, fileName };
}

// ============================================================================
// PROVIDER FUNCTIONS (inspired by Nuvio's modular providers)
// ============================================================================

async function searchMoviesMod(query) {
  const cacheKey = `search:${query}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey).data;

  try {
    const searchUrl = `${MOVIESMOD_BASE}/?s=${encodeURIComponent(query)}`;
    const response = await fetchWithRetry(searchUrl);
    const html = await response.text();
    const results = [];
    const articleRegex = /<article[^>]*>([\s\S]*?)<\/article>/gi;
    let articleMatch;

    while ((articleMatch = articleRegex.exec(html)) !== null) {
      const articleHtml = articleMatch[1];
      const linkMatch = articleHtml.match(/<a[^>]+href=["']([^"']+)["'][^>]*title=["']([^"']+)["']/i) 
                     || articleHtml.match(/<h2[^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);

      if (linkMatch) {
        const url = linkMatch[1];
        const title = stripTags(linkMatch[2]);
        if (url && title && !url.includes('javascript')) {
          const fullUrl = url.startsWith('http') ? url : `${MOVIESMOD_BASE}${url}`;
          if (!results.some(r => r.url === fullUrl)) results.push({ url: fullUrl, title, source: 'moviesmod' });
        }
      }
    }

    cache.set(cacheKey, { data: results, timestamp: Date.now() });
    return results;
  } catch (error) {
    throw error;
  }
}

async function extractDownloadLinks(moviePageUrl, logger) {
  logger(`[Extract] Fetching: ${moviePageUrl.substring(0, 60)}...`);
  const response = await fetchWithRetry(moviePageUrl);
  const html = await response.text();

  const links = [];
  const contentMatch = html.match(/class=["'][^"']*thecontent[^"']*["'][^>]*>([\s\S]*?)(?:<div class="post-navigation"|<h4 class="total-comments"|<\/article>|<div id="comments")/i);
  
  if (!contentMatch) {
    logger(`[Extract] ✗ No .thecontent found`);
    return links;
  }

  const blocks = contentMatch[1].split(/(?=<h[2-6])/i);
  
  for (const block of blocks) {
    const headerMatch = block.match(/<h[2-6][^>]*>([\s\S]*?)<\/h[2-6]>/i);
    const rawHeader = stripTags(headerMatch ? headerMatch[1] : 'Unknown');
    const quality = rawHeader.length > 100 ? rawHeader.substring(0, 50) : rawHeader;

    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let linkMatch;
    
    while ((linkMatch = linkRegex.exec(block)) !== null) {
      const url = linkMatch[1];
      if (url && (url.includes('modpro') || url.includes('links') || url.includes('unblockedgames'))) {
        links.push({ quality, url: url.startsWith('http') ? url : `${MOVIESMOD_BASE}${url}` });
      }
    }
  }

  logger(`[Extract] ✓ Found ${links.length} links`);
  return links;
}

async function extractAllDownloadableLinks(moviePageUrl, env, logger) {
  logger(`[Pipeline] Starting extraction pipeline...`);
  
  try {
    const downloadLinks = await extractDownloadLinks(moviePageUrl, logger);
    if (downloadLinks.length === 0) {
      logger(`[Pipeline] ✗ No initial links found`);
      return { links: [] };
    }

    // Get browser instance
    if (!env.MYBROWSER) {
      logger(`[Pipeline] ✗ Browser not available`);
      return { links: [] };
    }

    const browser = await puppeteer.launch(env.MYBROWSER, { protocolTimeout: 30000 });
    const allDownloadableLinks = [];

    // Process first quality only to save resources
    const primaryLink = downloadLinks[0];
    logger(`[Pipeline] Processing: ${primaryLink.quality}`);

    try {
      // Resolve intermediate links
      let finalLinks = await resolveIntermediateLink(primaryLink.url, moviePageUrl, logger);
      if (!finalLinks || finalLinks.length === 0) {
        logger(`[Pipeline] ✗ No final links from intermediate resolution`);
        await browser.close();
        return { links: [] };
      }

      // Process primary target
      const primaryTarget = finalLinks.find(l => l.server.includes('Fast') || l.server.includes('G-Drive')) || finalLinks[0];
      logger(`[Pipeline] Processing target: ${primaryTarget.server}`);

      let currentUrl = primaryTarget.url;

      // If SID link, resolve it
      if (currentUrl.includes('unblockedgames') || currentUrl.includes('creativeexpressions') || currentUrl.includes('examzculture')) {
        logger(`[Pipeline] Detected SID link, resolving...`);
        const goLink = await resolveSidToGoLink(currentUrl, browser, logger);
        
        if (goLink) {
          currentUrl = goLink;
          logger(`[Pipeline] ✓ SID resolved to ?go= link`);

          // Follow the redirect
          const redirectResult = await followGoRedirect(currentUrl, browser, logger);
          if (redirectResult && (redirectResult.type === 'driveseed' || redirectResult.type === 'driveleech')) {
            const { downloadOptions, size, fileName } = await extractDriveseedOptions(redirectResult.html, logger);
            
            for (const option of downloadOptions) {
              allDownloadableLinks.push({
                quality: primaryLink.quality,
                server: primaryTarget.server,
                method: option.title,
                url: option.url,
                size,
                fileName
              });
            }
          }
        } else {
          logger(`[Pipeline] ✗ SID resolution failed`);
        }
      } else if (currentUrl.includes('driveseed')) {
        // Direct driveseed link
        const response = await fetchWithRetry(currentUrl);
        const html = await response.text();
        const { downloadOptions, size, fileName } = await extractDriveseedOptions(html, logger);
        
        for (const option of downloadOptions) {
          allDownloadableLinks.push({
            quality: primaryLink.quality,
            server: primaryTarget.server,
            method: option.title,
            url: option.url,
            size,
            fileName
          });
        }
      } else {
        logger(`[Pipeline] Direct link: ${primaryTarget.server}`);
        allDownloadableLinks.push({
          quality: primaryLink.quality,
          server: primaryTarget.server,
          method: 'Direct',
          url: currentUrl
        });
      }

    } catch (error) {
      logger(`[Pipeline] ✗ Error processing link: ${error.message}`);
    } finally {
      await browser.close();
    }

    logger(`[Pipeline] ✓ Complete: ${allDownloadableLinks.length} streams extracted`);
    return { links: allDownloadableLinks };

  } catch (error) {
    logger(`[Pipeline] ✗ Fatal: ${error.message}`);
    return { links: [] };
  }
}

async function resolveIntermediateLink(initialUrl, refererUrl, logger) {
  try {
    const urlObject = new URL(initialUrl);
    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    if (urlObject.hostname.includes('dramadrip.com')) {
      const response = await fetchWithRetry(initialUrl, { headers: { 'Referer': refererUrl } });
      const html = await response.text();
      let episodePageLink = null;
      let match;

      while ((match = linkRegex.exec(html)) !== null) {
        const link = match[1];
        if (link.includes('episodes.modpro') || link.includes('cinematickit')) {
          episodePageLink = link;
          break;
        }
      }

      if (episodePageLink) {
        return await resolveIntermediateLink(episodePageLink, initialUrl, logger);
      }
    } else if (urlObject.hostname.includes('episodes.modpro.blog') || urlObject.hostname.includes('cinematickit.org')) {
      const response = await fetchWithRetry(initialUrl, { headers: { 'Referer': refererUrl } });
      const html = await response.text();
      const finalLinks = [];
      let match;

      while ((match = linkRegex.exec(html)) !== null) {
        if (match[1].includes('driveseed') || match[1].includes('unblockedgames') || match[1].includes('creativeexpressions')) {
          finalLinks.push({ server: stripTags(match[2]) || 'Server', url: match[1] });
        }
      }

      return finalLinks;
    } else if (urlObject.hostname.includes('modrefer.in') || urlObject.hostname.includes('links.modpro.blog')) {
      const response = await fetchWithRetry(initialUrl, { headers: { 'Referer': refererUrl } });
      const html = await response.text();
      const finalLinks = [];
      let match;

      while ((match = linkRegex.exec(html)) !== null) {
        const url = match[1];
        const text = stripTags(match[2]);
        if (url && (url.includes('driveseed') || url.includes('unblockedgames') || url.includes('creativeexpressions') || url.includes('examzculture'))) {
          if (!text.toLowerCase().includes('comment')) {
            finalLinks.push({ server: text || 'Link', url });
          }
        }
      }

      logger(`[Intermediate] ✓ Found ${finalLinks.length} links`);
      return finalLinks;
    }

    return [];
  } catch (error) {
    logger(`[Intermediate] ✗ Error: ${error.message}`);
    return [];
  }
}

// ============================================================================
// REQUEST HANDLERS
// ============================================================================

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  let path = url.pathname || '/';

  // Home page
  if (path === '/' || path === '/search') {
    return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MoviesMod Serverless Extractor</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container { 
      background: white;
      border-radius: 12px;
      padding: 40px;
      max-width: 1200px;
      margin: 0 auto;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    }
    h1 { color: #333; text-align: center; margin-bottom: 10px; }
    .subtitle { color: #666; text-align: center; margin-bottom: 30px; font-size: 14px; }
    .search-box { display: flex; gap: 10px; margin-bottom: 30px; }
    input { flex: 1; padding: 12px 16px; border: 2px solid #e0e0e0; border-radius: 8px; }
    button { padding: 12px 30px; background: #667eea; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; }
    button:hover { background: #5568d3; }
    .two-column { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 30px; }
    @media (max-width: 768px) { .two-column { grid-template-columns: 1fr; } }
    .section { background: #f9f9f9; padding: 20px; border-radius: 8px; border: 1px solid #e0e0e0; }
    .section-title { font-weight: 600; color: #667eea; margin-bottom: 15px; font-size: 14px; text-transform: uppercase; }
    .result-item { background: white; padding: 12px; border-radius: 6px; margin-bottom: 10px; border-left: 3px solid #667eea; }
    .result-title { font-weight: 600; color: #333; margin-bottom: 6px; font-size: 13px; }
    .result-url { 
      font-size: 11px; 
      color: #666; 
      font-family: 'Courier New', monospace;
      background: #f0f0f0; 
      padding: 8px; 
      border-radius: 4px; 
      margin-bottom: 8px; 
      display: block; 
      overflow-x: auto;
      word-break: break-all;
    }
    .btn-group { display: flex; gap: 8px; flex-wrap: wrap; }
    .copy-btn { 
      font-size: 10px; 
      padding: 6px 12px; 
      background: #e0e0e0; 
      color: #333; 
      border: none; 
      border-radius: 4px; 
      cursor: pointer;
    }
    .copy-btn:hover { background: #d0d0d0; }
    .loading { text-align: center; color: #666; padding: 20px; }
    .error { 
      background: #fee; 
      color: #c33; 
      padding: 15px; 
      border-radius: 8px; 
      border-left: 4px solid #c33; 
      margin-top: 20px; 
    }
    .empty { text-align: center; color: #999; padding: 30px 20px; font-size: 14px; }
    .debug-log {
      font-family: 'Courier New', monospace;
      font-size: 12px;
      background: #1e1e1e;
      color: #d4d4d4;
      padding: 15px;
      border-radius: 8px;
      max-height: 400px;
      overflow-y: auto;
      line-height: 1.4;
    }
    .log-error { color: #f48771; }
    .log-success { color: #6a9955; }
    .log-info { color: #9cdcfe; }
    .log-warning { color: #ce9178; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎬 MoviesMod Serverless Extractor</h1>
    <p class="subtitle">Advanced link extraction with intelligent SID resolution</p>
    
    <div class="search-box">
      <input type="text" id="searchInput" placeholder="Search a movie or series..." onkeypress="if(event.key==='Enter') search()" autofocus>
      <button onclick="search()">Search</button>
    </div>

    <div id="alert" class="error" style="display: none;"></div>

    <div class="two-column">
      <div class="section">
        <div class="section-title">📽️ Movie Pages</div>
        <div id="pageResults" class="empty">Search to see results</div>
      </div>
      
      <div class="section">
        <div class="section-title">🔗 Download Links</div>
        <div id="downloadResults" class="empty">Links appear here</div>
      </div>
    </div>

    <div class="section" style="margin-top: 20px;">
      <div class="section-title">🐛 Extraction Logs</div>
      <div class="debug-log" id="debugLogs">Ready for extraction...</div>
    </div>
  </div>

  <script>
    let activeStream = null;

    async function search() {
      const query = document.getElementById('searchInput').value.trim();
      if (!query) return;

      if (activeStream) activeStream.close();

      document.getElementById('alert').style.display = 'none';
      document.getElementById('pageResults').innerHTML = '<div class="loading">🔍 Searching...</div>';
      document.getElementById('downloadResults').innerHTML = '';
      clearLogs();

      try {
        const pageResponse = await fetch(\`/search-api?q=\${encodeURIComponent(query)}\`);
        const pageData = await pageResponse.json();

        if (!pageData.results || pageData.results.length === 0) {
          document.getElementById('pageResults').innerHTML = '<div class="empty">No results found</div>';
          return;
        }

        document.getElementById('pageResults').innerHTML = pageData.results.map((r, i) => \`
          <div class="result-item">
            <div class="result-title">\${i + 1}. \${r.title}</div>
            <span class="result-url">\${r.url}</span>
            <div class="btn-group">
              <button class="copy-btn" onclick="copyText('\${r.url}')">Copy URL</button>
              <button class="copy-btn" onclick="extractLinks('\${r.url}')">Extract</button>
            </div>
          </div>
        \`).join('');

      } catch (error) {
        document.getElementById('alert').textContent = \`Error: \${error.message}\`;
        document.getElementById('alert').style.display = 'block';
      }
    }

    function extractLinks(url) {
      document.getElementById('downloadResults').innerHTML = '<div class="loading">⏳ Extracting...</div>';
      clearLogs();

      if (activeStream) activeStream.close();

      const eventSource = new EventSource(\`/extract-links?url=\${encodeURIComponent(url)}\`);
      activeStream = eventSource;

      eventSource.onmessage = function(event) {
        const data = JSON.parse(event.data);
        
        if (data.type === 'log') {
          addLog(data.message);
        } 
        
        if (data.type === 'result') {
          eventSource.close();
          const links = data.links;
          
          if (!links || links.length === 0) {
            document.getElementById('downloadResults').innerHTML = '<div class="empty">No downloadable links found</div>';
            return;
          }

          const grouped = {};
          links.forEach(link => {
            if (!grouped[link.quality]) grouped[link.quality] = [];
            grouped[link.quality].push(link);
          });

          let html = '';
          Object.keys(grouped).forEach(quality => {
            html += \`<div style="margin-bottom: 15px;"><div class="result-title">⭐ \${quality}</div>\`;
            grouped[quality].forEach(link => {
              html += \`<div style="margin-left: 10px; margin-bottom: 12px;">
                <div style="font-size: 11px; color: #666; margin-bottom: 6px;">
                  📌 \${link.method}\${link.server ? ' • ' + link.server : ''}\${link.fileName ? '<br/>📁 ' + link.fileName : ''}\${link.size ? '<br/>📊 ' + link.size : ''}
                </div>
                <span class="result-url">\${link.url}</span>
                <div class="btn-group" style="margin-top: 6px;">
                  <button class="copy-btn" onclick="copyText('\${link.url}')">Copy</button>
                  <button class="copy-btn" onclick="window.open('\${link.url}', '_blank')">Open</button>
                </div>
              </div>\`;
            });
            html += '</div>';
          });

          document.getElementById('downloadResults').innerHTML = html;
        }
      };

      eventSource.onerror = function() {
        eventSource.close();
      };
    }

    function copyText(text) {
      navigator.clipboard.writeText(text);
      alert('Copied!');
    }

    function clearLogs() {
      document.getElementById('debugLogs').innerHTML = '';
    }

    function addLog(message) {
      const logs = document.getElementById('debugLogs');
      const isError = message.includes('✗');
      const isSuccess = message.includes('✓');
      const isWarning = message.includes('⚠');
      
      const span = document.createElement('div');
      if (isError) span.className = 'log-error';
      else if (isSuccess) span.className = 'log-success';
      else if (isWarning) span.className = 'log-warning';
      else span.className = 'log-info';
      
      span.textContent = message;
      span.style.paddingBottom = '2px';
      span.style.marginBottom = '4px';
      span.style.borderBottom = '1px solid #333';
      
      logs.appendChild(span);
      logs.scrollTop = logs.scrollHeight;
    }
  </script>
</body>
</html>`, { headers: { 'Content-Type': 'text/html' } });
  }

  if (path === '/manifest.json') {
    return new Response(JSON.stringify(MANIFEST), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  if (path === '/search-api') {
    const query = url.searchParams.get('q');
    if (!query) return new Response(JSON.stringify({ results: [] }), { headers: { 'Content-Type': 'application/json' } });

    try {
      const results = await searchMoviesMod(query);
      return new Response(JSON.stringify({ results: results.slice(0, 10) }), { headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      return new Response(JSON.stringify({ results: [], error: error.message }), { headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (path === '/extract-links') {
    const pageUrl = url.searchParams.get('url');
    if (!pageUrl) return new Response("Missing URL", { status: 400 });

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const streamLogger = async (msg) => {
      try {
        await writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'log', message: msg })}\n\n`));
      } catch (e) {}
    };

    ctx.waitUntil((async () => {
      try {
        const result = await extractAllDownloadableLinks(pageUrl, env, streamLogger);
        await writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'result', links: result.links })}\n\n`));
      } catch (error) {
        await streamLogger(`[Pipeline] ✗ Fatal: ${error.message}`);
        await writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'result', links: [] })}\n\n`));
      } finally {
        await writer.close();
      }
    })());

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }
    });
  }

  return new Response('Not Found', { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    }

    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({ error: error.message }), { 
        status: 500, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }
  },
};

const MANIFEST = {
  id: 'moviesmod.addon',
  version: '0.5.0',
  name: 'MoviesMod',
  description: 'MoviesMod scraper with client-side resolution',
  types: ['movie', 'series'],
  catalogs: [],
  resources: ['stream'],
  idPrefixes: ['tt', 'tmdb:'],
  behaviorHints: { p2p: false, configurable: false },
};

const MOVIESMOD_BASE = 'https://moviesmod.army';

const cache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000;

function getMatch(text, regex, index = 1) {
  const match = text.match(regex);
  return match ? match[index] : null;
}

function stripTags(html) {
  return (html || '').replace(/<[^>]*>/g, '').trim();
}

async function fetchWithRetry(url, options = {}, retries = 2) {
  const timeout = options.timeout || 15000;
  for (let attempt = 0; attempt < retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          ...options.headers,
        },
      });
      clearTimeout(timeoutId);
      if (response.status === 403 || response.status === 429) throw new Error(`Blocked: HTTP ${response.status}`);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.message.includes('Blocked')) throw error;
      if (attempt === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}

// ---------- SEARCH (Worker-side) ----------
async function searchMoviesMod(query) {
  const cacheKey = `search:${query}`;
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_TTL) return cached.data;
    cache.delete(cacheKey);
  }
  try {
    const searchUrl = `${MOVIESMOD_BASE}/?s=${encodeURIComponent(query)}`;
    const response = await fetchWithRetry(searchUrl);
    const html = await response.text();
    const results = [];
    const articleRegex = /<article[^>]*>([\s\S]*?)<\/article>/gi;
    let match;
    while ((match = articleRegex.exec(html)) !== null) {
      const articleHtml = match[1];
      const linkMatch = articleHtml.match(/<a[^>]+href=["']([^"']+)["'][^>]*title=["']([^"']+)["']/i)
                     || articleHtml.match(/<h2[^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
      if (linkMatch) {
        const url = linkMatch[1];
        const title = stripTags(linkMatch[2]);
        if (url && title && !url.includes('javascript')) {
          const fullUrl = url.startsWith('http') ? url : `${MOVIESMOD_BASE}${url}`;
          if (!results.some(r => r.url === fullUrl)) {
            results.push({ url: fullUrl, title, source: 'moviesmod' });
          }
        }
      }
    }
    cache.set(cacheKey, { data: results, timestamp: Date.now() });
    return results;
  } catch (error) {
    console.error(`MoviesMod search error:`, error.message);
    throw error;
  }
}

// ---------- DRIVESEED PARSING (Worker-side) ----------
async function resolveDriveseedLink(driveseedUrl, logs) {
  try {
    logs.push(`[Driveseed] Resolving: ${driveseedUrl}`);
    const response = await fetchWithRetry(driveseedUrl);
    const finalUrl = response.url;
    let finalHtml = await response.text();

    const redirectMatch = getMatch(finalHtml, /window\.location(?:\.replace|\.href)?\s*(?:\(\s*|=\s*)["']([^"']+)["']/i);
    if (redirectMatch) {
      const redirectTo = redirectMatch.startsWith('http') ? redirectMatch : `https://driveseed.org${redirectMatch.startsWith('/') ? '' : '/'}${redirectMatch}`;
      logs.push(`[Driveseed] Following inner redirect to: ${redirectTo}`);
      const finalResponse = await fetchWithRetry(redirectTo);
      finalHtml = await finalResponse.text();
    }

    const downloadOptions = [];
    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = linkRegex.exec(finalHtml)) !== null) {
      const href = match[1];
      const text = stripTags(match[2]).toLowerCase();
      if (href.includes('instant') || href.includes('video-seed') || href.includes('cdn.')) {
        if (text.includes('instant') || text.includes('v2')) {
          downloadOptions.push({ title: 'Instant Download', type: 'instant', url: href, priority: 1 });
        }
      } else if (href.includes('resume') || href.includes('worker') || href.includes('zfile')) {
        downloadOptions.push({ title: 'Resume Cloud', type: 'resume', url: href, priority: 2 });
      } else if (href.includes('telegram') || href.includes('seedtg')) {
        downloadOptions.push({ title: 'Telegram', type: 'telegram', url: href, priority: 4 });
      }
    }

    const size = getMatch(finalHtml, /Size\s*:\s*([0-9.,]+\s*[KMGT]B)/i);
    const fileName = getMatch(finalHtml, /Name\s*:\s*([^<]+)/i, 1)?.trim() || null;
    downloadOptions.sort((a, b) => a.priority - b.priority);
    logs.push(`[Driveseed] ✓ ${downloadOptions.length} options for: ${fileName || finalUrl}`);
    return { downloadOptions, size, fileName };
  } catch (error) {
    logs.push(`[Driveseed] ✗ Error: ${error.message}`);
    return { downloadOptions: [], size: null, fileName: null };
  }
}

// ---------- EXTRACT DOWNLOAD LINKS FROM MOVIE PAGE (Worker-side) ----------
async function extractDownloadLinks(moviePageUrl, logs) {
  try {
    logs.push(`[Extract] Fetching movie page: ${moviePageUrl}`);
    const response = await fetchWithRetry(moviePageUrl);
    const html = await response.text();
    const links = [];
    const contentMatch = html.match(/class=["'][^"']*thecontent[^"']*["'][^>]*>([\s\S]*?)(?:<div class="post-navigation"|<h4 class="total-comments"|<\/article>|<div id="comments")/i);
    if (!contentMatch) {
      logs.push('[Extract] ✗ No .thecontent div found');
      return links;
    }
    const blocks = contentMatch[1].split(/(?=<h[2-6])/i);
    for (const block of blocks) {
      const headerMatch = block.match(/<h[2-6][^>]*>([\s\S]*?)<\/h[2-6]>/i);
      const rawHeader = stripTags(headerMatch ? headerMatch[1] : 'Unknown Quality');
      const qualityMatch = rawHeader.match(/\b(480p|720p|1080p|2160p|4K)\b/i);
      const bitMatch = rawHeader.match(/\b(10Bit|8Bit)\b/i);
      const sizeMatch = rawHeader.match(/\[([0-9.]+\s*[KMGT]B)\]/i);
      let quality = rawHeader;
      if (quality.length > 100 || !qualityMatch) {
        quality = '';
        if (qualityMatch) quality += qualityMatch[1];
        if (bitMatch) quality += ' ' + bitMatch[1];
        if (sizeMatch) quality += ' [' + sizeMatch[1] + ']';
        if (!quality) quality = 'Unknown';
      }
      quality = quality.trim();
      const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let lm;
      while ((lm = linkRegex.exec(block)) !== null) {
        const url = lm[1];
        if (url && (url.includes('modpro') || url.includes('links'))) {
          links.push({ quality, url: url.startsWith('http') ? url : `${MOVIESMOD_BASE}${url}` });
          logs.push(`[Extract] ✓ Captured link for quality: ${quality}`);
        }
      }
    }
    logs.push(`[Extract] Found ${links.length} download links`);
    return links;
  } catch (error) {
    logs.push(`[Extract] ✗ Error: ${error.message}`);
    return [];
  }
}

// ---------- MAIN ENDPOINT ----------
async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  // ---- MANIFEST ----
  if (path === '/manifest.json') {
    return new Response(JSON.stringify(MANIFEST), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  // ---- SEARCH API ----
  if (path === '/search-api') {
    const query = url.searchParams.get('q');
    if (!query) return new Response(JSON.stringify({ results: [] }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    try {
      const results = await searchMoviesMod(query);
      return new Response(JSON.stringify({ results: results.slice(0, 10) }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    } catch (error) {
      return new Response(JSON.stringify({ results: [], error: error.message }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }
  }

  // ---- EXTRACT LINKS FROM MOVIE PAGE (Worker does what it can) ----
  if (path === '/extract-links') {
    const pageUrl = url.searchParams.get('url');
    if (!pageUrl) return new Response(JSON.stringify({ links: [], logs: ['✗ No URL'] }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    try {
      const logs = [];
      logs.push(`[Main] Extracting links from: ${pageUrl}`);
      const downloadLinks = await extractDownloadLinks(pageUrl, logs);
      
      // For each quality, collect the modpro/links URLs (these go to the client)
      const result = [];
      for (const link of downloadLinks) {
        result.push({
          quality: link.quality,
          // Return the intermediate URL — the client will resolve it with JS
          url: link.url,
        });
      }
      
      return new Response(JSON.stringify({ links: result, logs }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    } catch (error) {
      return new Response(JSON.stringify({ links: [], logs: [`✗ Fatal: ${error.message}`] }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  }

  // ---- RESOLVE INTERMEDIATE LINK (client-side JS resolves the 5s countdown, then sends URL to Worker) ----
  if (path === '/resolve-intermediate') {
    const intermediateUrl = url.searchParams.get('url');
    const referer = url.searchParams.get('ref') || intermediateUrl;
    if (!intermediateUrl) return new Response(JSON.stringify({ error: 'No URL' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    
    try {
      const logs = [`[Resolve] Fetching intermediate: ${intermediateUrl}`];
      const response = await fetchWithRetry(intermediateUrl, { headers: { 'Referer': referer } });
      const html = await response.text();
      
      // Parse out ALL link types
      const finalLinks = [];
      const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = linkRegex.exec(html)) !== null) {
        const href = match[1];
        const text = stripTags(match[2]);
        if (!href || !text || text.toLowerCase().includes('comment') || text.toLowerCase().includes('report')) continue;
        
        if (href.includes('driveseed.org/r?') || href.includes('driveseed.org/file/') ||
            href.includes('driveseed.org/zfile/') || href.includes('driveleech.org/') ||
            href.includes('video-seed.') || href.includes('workerseed.') ||
            href.includes('seedtg.') || href.includes('instant.') || href.includes('cdn.')) {
          finalLinks.push({ server: text, url: href, type: 'direct' });
        } else if (href.includes('drive.google.com') || text.toLowerCase().includes('google drive') || text.toLowerCase().includes('g-drive')) {
          finalLinks.push({ server: text, url: href, type: 'gdrive' });
        } else if (href.includes('cloud.') || href.includes('unblockedgames') || href.includes('tech.')) {
          finalLinks.push({ server: text, url: href, type: 'sid' });
        } else if (href.includes('urlflix')) {
          finalLinks.push({ server: text, url: href, type: 'urlflix' });
        }
      }
      
      logs.push(`[Resolve] Found ${finalLinks.length} links`);
      return new Response(JSON.stringify({ links: finalLinks, logs }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    } catch (error) {
      return new Response(JSON.stringify({ links: [], logs: [`[Resolve] ✗ ${error.message}`] }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  }

  // ---- RESOLVE DRIVESEED (Worker-side) ----
  if (path === '/resolve-driveseed') {
    const driveseedUrl = url.searchParams.get('url');
    if (!driveseedUrl) return new Response(JSON.stringify({ error: 'No URL' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    try {
      const logs = [`[Driveseed] Resolving: ${driveseedUrl}`];
      const result = await resolveDriveseedLink(driveseedUrl, logs);
      return new Response(JSON.stringify({ ...result, logs }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }
  }

  // ---- RESOLVE SID (client-side JS resolves the verification in the browser) ----
  if (path === '/resolve-sid') {
    const sidUrl = url.searchParams.get('url');
    if (!sidUrl) return new Response(JSON.stringify({ error: 'No URL' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    try {
      // Worker tries first with redirect chain
      const logs = [`[SID] Resolving: ${sidUrl}`];
      const origin = new URL(sidUrl).origin;
      
      // Try: just fetch with redirect: 'manual' and follow the chain
      const resp = await fetchWithRetry(sidUrl, { redirect: 'manual' });
      const location = resp.headers.get('location');
      
      if (location) {
        const goUrl = new URL(location, origin).href;
        logs.push(`[SID] Server redirected to: ${goUrl}`);
        
        const resp2 = await fetchWithRetry(goUrl, { headers: { 'Referer': sidUrl }, redirect: 'follow' });
        if (resp2.url && resp2.url.includes('driveseed.org')) {
          logs.push(`[SID] ✓ Driveseed: ${resp2.url}`);
          return new Response(JSON.stringify({ url: resp2.url, logs }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          });
        }
      }
      
      // If Worker can't resolve, tell client to use an iframe
      logs.push(`[SID] ⚠ Worker cannot resolve — needs browser JS`);
      return new Response(JSON.stringify({ needsBrowser: true, url: sidUrl, logs }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message, needsBrowser: true, url: sidUrl }), {
        status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  }

  // ---- PROXY ENDPOINT (for client-side fetch to bypass CORS) ----
  if (path === '/proxy') {
    const target = url.searchParams.get('url');
    if (!target) return new Response(JSON.stringify({ error: 'No URL' }), { status: 400 });
    try {
      const response = await fetchWithRetry(target, {
        headers: {
          'Referer': url.searchParams.get('ref') || target,
        }
      });
      const text = await response.text();
      return new Response(text, {
        headers: {
          'Content-Type': 'text/html',
          'Access-Control-Allow-Origin': '*',
        }
      });
    } catch (error) {
      return new Response('Error: ' + error.message, { status: 500 });
    }
  }

  // ---- MAIN UI PAGE ----
  return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MoviesMod Scraper</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
    .container { background: white; border-radius: 12px; padding: 40px; max-width: 1200px; margin: 0 auto; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
    h1 { color: #333; margin-bottom: 10px; text-align: center; }
    .subtitle { color: #666; text-align: center; margin-bottom: 30px; font-size: 14px; }
    .search-box { display: flex; gap: 10px; margin-bottom: 30px; }
    input { flex: 1; padding: 12px 16px; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 16px; }
    button { padding: 12px 30px; background: #667eea; color: white; border: none; border-radius: 8px; cursor: pointer; }
    .two-column { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 30px; }
    @media (max-width: 768px) { .two-column { grid-template-columns: 1fr; } }
    .section { background: #f9f9f9; padding: 20px; border-radius: 8px; border: 1px solid #e0e0e0; }
    .section-title { font-weight: 600; color: #667eea; margin-bottom: 15px; font-size: 14px; text-transform: uppercase; }
    .result-item { background: white; padding: 12px; border-radius: 6px; margin-bottom: 10px; border-left: 3px solid #667eea; word-break: break-all; }
    .result-title { font-weight: 600; color: #333; margin-bottom: 6px; font-size: 13px; }
    .result-url { font-size: 11px; color: #666; font-family: monospace; background: #f0f0f0; padding: 6px; border-radius: 4px; margin-bottom: 6px; display: block; overflow-x: auto; }
    .copy-btn { font-size: 10px; padding: 4px 12px; background: #e0e0e0; color: #333; border: none; border-radius: 4px; cursor: pointer; }
    .copy-btn:hover { background: #d0d0d0; }
    .loading { text-align: center; color: #666; padding: 20px; }
    .error { background: #fee; color: #c33; padding: 15px; border-radius: 8px; border-left: 4px solid #c33; margin-top: 20px; }
    .empty { text-align: center; color: #999; padding: 30px 20px; font-size: 14px; }
    .timed-out { color: #e9c46a; }
    iframe.resolver { width: 100%; height: 300px; border: 1px solid #ddd; border-radius: 8px; display: none; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎬 MoviesMod Scraper</h1>
    <p class="subtitle">Client-side Countdown & SID Bypass</p>
    <div class="search-box">
      <input type="text" id="searchInput" placeholder="Search movie or series..." onkeypress="if(event.key==='Enter') search()" autofocus>
      <button onclick="search()">Search</button>
    </div>
    <div id="alert" class="error" style="display: none;"></div>
    <div class="two-column">
      <div class="section">
        <div class="section-title">📽️ Movies</div>
        <div id="pageResults" class="empty">Search to see results</div>
      </div>
      <div class="section">
        <div class="section-title">🔗 Download Links</div>
        <div id="downloadResults" class="empty">Links appear here</div>
      </div>
    </div>
    <div class="section" style="margin-top: 20px;">
      <div class="section-title">🐛 Logs</div>
      <div id="debugLogs" style="font-family: monospace; font-size: 12px; background: #fff; padding: 15px; border-radius: 8px; border: 1px solid #e0e0e0; max-height: 400px; overflow-y: auto; color: #444; line-height: 1.5;">Awaiting action...</div>
    </div>
    <iframe id="resolverIframe" class="resolver"></iframe>
  </div>

  <script>
    // ---- Utility ----
    function addLog(msg, type = 'info') {
      const el = document.getElementById('debugLogs');
      const colors = { info: '#444', success: '#2a9d8f', error: '#c33', warn: '#e9c46a' };
      el.innerHTML += \`<div style="color: \${colors[type] || '#444'}; border-bottom: 1px solid #eee; padding-bottom: 2px; margin-bottom: 4px;">\${msg}</div>\`;
      el.scrollTop = el.scrollHeight;
    }

    function copyText(text) { navigator.clipboard.writeText(text); alert('Copied!'); }

    // ---- Resolve a single intermediate URL (with 5s countdown bypass) ----
    async function resolveIntermediateUrl(url, ref) {
      addLog(\`[Resolve] Fetching intermediate page: \${url}\`, 'info');
      
      // Step 1: Fetch the raw HTML via Worker proxy (gets the page before JS runs)
      const proxyResp = await fetch(\`/proxy?url=\${encodeURIComponent(url)}&ref=\${encodeURIComponent(ref || url)}\`);
      const html = await proxyResp.text();
      
      // Step 2: Client-side JS execution! We inject the HTML into a hidden iframe,
      // let the countdown JS run, then extract the populated links.
      addLog(\`[Resolve] Loading page in iframe to execute countdown JS...\`, 'info');
      
      return new Promise((resolve, reject) => {
        const iframe = document.getElementById('resolverIframe');
        iframe.style.display = 'block';
        
        // Write the HTML into the iframe
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        iframeDoc.open();
        iframeDoc.write(html);
        iframeDoc.close();
        
        // Wait for the countdown (5s + buffer)
        addLog(\`[Resolve] Waiting 7s for countdown to complete...\`, 'warn');
        
        setTimeout(() => {
          try {
            // Extract all links from the iframe (now populated by JS)
            const links = [];
            const anchors = iframeDoc.querySelectorAll('a');
            anchors.forEach(a => {
              const href = a.href || a.getAttribute('href') || '';
              const text = (a.textContent || '').trim();
              if (!href || !text || text.toLowerCase().includes('comment') || text.toLowerCase().includes('report')) return;
              
              if (href.includes('driveseed.org/r?') || href.includes('driveseed.org/file/') ||
                  href.includes('driveseed.org/zfile/') || href.includes('driveleech.org/') ||
                  href.includes('video-seed.') || href.includes('workerseed.') ||
                  href.includes('seedtg.') || href.includes('instant.') || href.includes('cdn.')) {
                links.push({ server: text, url: href, type: 'direct' });
              } else if (href.includes('drive.google.com') || text.toLowerCase().includes('google drive') || text.toLowerCase().includes('g-drive')) {
                links.push({ server: text, url: href, type: 'gdrive' });
              } else if (href.includes('cloud.') || href.includes('unblockedgames') || href.includes('tech.')) {
                links.push({ server: text, url: href, type: 'sid' });
              } else if (href.includes('urlflix')) {
                links.push({ server: text, url: href, type: 'urlflix' });
              }
            });
            
            iframe.style.display = 'none';
            addLog(\`[Resolve] Found \${links.length} links from iframe\`, links.length > 0 ? 'success' : 'warn');
            resolve(links);
          } catch (e) {
            iframe.style.display = 'none';
            addLog(\`[Resolve] Iframe error: \${e.message}\`, 'error');
            // Fallback: use the links we parsed server-side
            resolve([]);
          }
        }, 7000); // 7s for the 5s countdown + buffer
      });
    }

    // ---- Resolve SID URL (using iframe to execute browser JS) ----
    async function resolveSidUrl(sidUrl) {
      addLog(\`[SID] Trying to resolve: \${sidUrl}\`, 'info');
      
      // First try Worker-side
      const workerResp = await fetch(\`/resolve-sid?url=\${encodeURIComponent(sidUrl)}\`);
      const workerData = await workerResp.json();
      
      if (workerData.needsBrowser) {
        addLog(\`[SID] Worker couldn't resolve, using browser...\`, 'warn');
        
        // Use iframe to load the SID page (lets browser JS run)
        return new Promise((resolve, reject) => {
          const iframe = document.getElementById('resolverIframe');
          iframe.style.display = 'block';
          iframe.src = sidUrl;
          
          // Wait for the verification flow
          addLog(\`[SID] Waiting for verification flow (up to 25s)...\`, 'warn');
          
          let attempts = 0;
          const checkInterval = setInterval(() => {
            attempts++;
            try {
              const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
              const currentUrl = iframe.contentWindow.location.href;
              
              // Check if we've been redirected to driveseed
              if (currentUrl.includes('driveseed.org')) {
                clearInterval(checkInterval);
                iframe.style.display = 'none';
                addLog(\`[SID] ✓ Redirected to driveseed: \${currentUrl}\`, 'success');
                resolve(currentUrl);
                return;
              }
              
              // Try clicking elements to progress the flow
              const landing = iframeDoc.querySelector('#landing');
              if (landing) {
                addLog(\`[SID] Clicking #landing submit...\`, 'info');
                const btn = landing.querySelector('button, input[type="submit"]');
                if (btn) btn.click();
                else landing.submit();
              }
              
              const verifyBtn = iframeDoc.querySelector('#verify_button');
              if (verifyBtn) {
                addLog(\`[SID] Clicking #verify_button...\`, 'info');
                verifyBtn.click();
              }
              
              const twoSteps = iframeDoc.querySelector('#two_steps_btn');
              if (twoSteps && twoSteps.href && twoSteps.href.length > 0) {
                addLog(\`[SID] Found go URL: \${twoSteps.href}\`, 'success');
                iframe.src = twoSteps.href;
              }
              
              if (attempts > 30) { // ~30 seconds
                clearInterval(checkInterval);
                iframe.style.display = 'none';
                addLog(\`[SID] Timed out waiting for redirect\`, 'error');
                resolve(null);
              }
            } catch (e) {
              // Cross-origin iframe restrictions may cause errors
              // We can still check the iframe's current URL
              try {
                const currentUrl = iframe.contentWindow.location.href;
                if (currentUrl.includes('driveseed.org')) {
                  clearInterval(checkInterval);
                  iframe.style.display = 'none';
                  addLog(\`[SID] ✓ Redirected: \${currentUrl}\`, 'success');
                  resolve(currentUrl);
                  return;
                }
              } catch(e2) {}
              
              if (attempts > 30) {
                clearInterval(checkInterval);
                iframe.style.display = 'none';
                addLog(\`[SID] Timed out\`, 'error');
                resolve(null);
              }
            }
          }, 1000);
        });
      } else if (workerData.url) {
        addLog(\`[SID] ✓ Worker resolved: \${workerData.url}\`, 'success');
        return workerData.url;
      }
      
      return null;
    }

    // ---- Process a single quality link (with client-side JS execution) ----
    async function processQuality(quality, url) {
      addLog(\`[Process] \${quality}: \${url}\`, 'info');
      
      // Step 1: Load the intermediate page in iframe to bypass 5s countdown
      const links = await resolveIntermediateUrl(url, url);
      
      // Step 2: Pick the best link (direct > sid > other)
      const directLink = links.find(l => l.type === 'direct');
      const sidLink = links.find(l => l.type === 'sid');
      const bestLink = directLink || sidLink || links[0];
      
      if (!bestLink) {
        addLog(\`[Process] No links found for \${quality}\`, 'error');
        return [];
      }
      
      addLog(\`[Process] Best link: \${bestLink.server} (\${bestLink.type})\`, 'info');
      let targetUrl = bestLink.url;
      
      // Step 3: If SID, resolve it
      if (bestLink.type === 'sid') {
        const resolved = await resolveSidUrl(targetUrl);
        if (resolved) targetUrl = resolved;
        else {
          addLog(\`[Process] SID resolution failed for \${quality}\`, 'error');
          return [];
        }
      }
      
      // Step 4: If URLFlix, resolve
      if (targetUrl.includes('urlflix')) {
        addLog(\`[URLFlix] Resolving...\`, 'info');
        try {
          const ufResp = await fetch(\`/proxy?url=\${encodeURIComponent(targetUrl)}\`);
          const ufHtml = await ufResp.text();
          const match = ufHtml.match(/window\\.location(?:\\\\.replace)?\\s*\\+?=\\s*["']([^"']+)["']/i);
          if (match) targetUrl = new URL(match[1], targetUrl).href;
        } catch(e) {}
      }
      
      // Step 5: Resolve driveseed
      if (targetUrl.includes('driveseed.org') || targetUrl.includes('driveleech.org')) {
        addLog(\`[Driveseed] Fetching: \${targetUrl}\`, 'info');
        const dsResp = await fetch(\`/resolve-driveseed?url=\${encodeURIComponent(targetUrl)}\`);
        const dsData = await dsResp.json();
        
        if (dsData.downloadOptions && dsData.downloadOptions.length > 0) {
          addLog(\`[Driveseed] ✓ Found \${dsData.downloadOptions.length} download options\`, 'success');
          return dsData.downloadOptions.map(opt => ({
            quality,
            server: bestLink.server,
            method: opt.title,
            url: opt.url,
            size: dsData.size,
            fileName: dsData.fileName,
          }));
        }
      }
      
      // Direct link (video-seed, worker, cdn)
      addLog(\`[Driveseed] Using direct: \${targetUrl}\`, 'success');
      return [{
        quality,
        server: bestLink.server,
        method: 'Direct Link',
        url: targetUrl,
      }];
    }

    // ---- Main search + extract flow ----
    async function search() {
      const query = document.getElementById('searchInput').value.trim();
      if (!query) return;
      
      document.getElementById('alert').style.display = 'none';
      document.getElementById('pageResults').innerHTML = '<div class="loading">Searching...</div>';
      document.getElementById('downloadResults').innerHTML = '';
      document.getElementById('debugLogs').innerHTML = '';
      
      try {
        // Search
        const pageResp = await fetch(\`/search-api?q=\${encodeURIComponent(query)}\`);
        const pageData = await pageResp.json();
        
        if (!pageData.results || pageData.results.length === 0) {
          document.getElementById('pageResults').innerHTML = '<div class="empty">No results</div>';
          return;
        }
        
        document.getElementById('pageResults').innerHTML = pageData.results.map((r, i) => \`
          <div class="result-item">
            <div class="result-title">\${i + 1}. \${r.title}</div>
            <span class="result-url">\${r.url}</span>
            <button class="copy-btn" onclick="copyText('\${r.url}')">Copy URL</button>
          </div>
        \`).join('');
        
        document.getElementById('downloadResults').innerHTML = '<div class="loading">Processing (requires browser JS — about 15s)...</div>';
        
        // Extract intermediate links from movie page
        const firstResult = pageData.results[0];
        const extractResp = await fetch(\`/extract-links?url=\${encodeURIComponent(firstResult.url)}\`);
        const extractData = await extractResp.json();
        
        if (extractData.logs) {
          extractData.logs.forEach(l => addLog(l));
        }
        
        if (!extractData.links || extractData.links.length === 0) {
          document.getElementById('downloadResults').innerHTML = '<div class="empty">No download links found</div>';
          return;
        }
        
        // Process first quality (client-side JS for countdown bypass)
        const firstQuality = extractData.links[0];
        const results = await processQuality(firstQuality.quality, firstQuality.url);
        
        // Display results
        if (results.length === 0) {
          document.getElementById('downloadResults').innerHTML = '<div class="empty">No links resolved</div>';
          return;
        }
        
        const grouped = {};
        results.forEach(l => {
          if (!grouped[l.quality]) grouped[l.quality] = [];
          grouped[l.quality].push(l);
        });
        
        let html = '';
        Object.keys(grouped).forEach(quality => {
          html += \`<div style="margin-bottom: 15px;"><div class="result-title">\${quality}</div>\`;
          grouped[quality].forEach(link => {
            html += \`<div style="margin-left: 10px; margin-bottom: 8px;">
              <div style="font-size: 11px; color: #666; margin-bottom: 4px;">
                📌 \${link.method}\${link.server ? ' • ' + link.server : ''}\${link.fileName ? '<br/>📁 ' + link.fileName : ''}\${link.size ? '<br/>📊 ' + link.size : ''}
              </div>
              <span class="result-url">\${link.url}</span>
              <button class="copy-btn" onclick="window.open('\${link.url}', '_blank')">Open</button>
              <button class="copy-btn" onclick="copyText('\${link.url}')">Copy</button>
            </div>\`;
          });
          html += '</div>';
        });
        
        document.getElementById('downloadResults').innerHTML = html;
        addLog('✓ Done!', 'success');
        
      } catch (error) {
        document.getElementById('alert').textContent = \`Error: \${error.message}\`;
        document.getElementById('alert').style.display = 'block';
        addLog(\`✗ Fatal: \${error.message}\`, 'error');
      }
    }
  </script>
</body>
</html>`, { headers: { 'Content-Type': 'text/html' } });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
    }
    try {
      return await handleRequest(request);
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  },
};

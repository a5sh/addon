import * as cheerio from 'https://esm.sh/cheerio';

const MANIFEST = {
  id: 'moviesmod.addon',
  version: '0.2.4',
  name: 'MoviesMod',
  description: 'Extracts HTTP streams from MoviesMod with direct download links',
  types: ['movie', 'series'],
  catalogs: [],
  resources: ['stream'],
  idPrefixes: ['tt', 'tmdb:'],
  behaviorHints: {
    p2p: false,
    configurable: false,
  },
};

const MOVIESMOD_BASE = 'https://moviesmod.army';

// Cache for search results and extracted streams
const cache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

// Custom error types
class NotFoundError extends Error {
  constructor(message = 'Not Found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

class BlockedError extends Error {
  constructor(message = 'Blocked') {
    super(message);
    this.name = 'BlockedError';
  }
}

// Fetcher with retry logic and timeout
async function fetchWithRetry(url, options = {}, retries = 3) {
  const timeout = options.timeout || 10000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            ...options.headers,
          },
        });
        clearTimeout(timeoutId);
        
        if (response.status === 403 || response.status === 429) {
          throw new BlockedError(`HTTP ${response.status}`);
        }
        if (response.status === 404) {
          throw new NotFoundError(`HTTP 404`);
        }
        return response;
      } catch (error) {
        if (error instanceof NotFoundError || error instanceof BlockedError) {
          throw error;
        }
        if (attempt === retries - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// Search for content on MoviesMod using AST
async function searchMoviesMod(query) {
  const cacheKey = `search:${query}`;
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }
    cache.delete(cacheKey);
  }

  try {
    const searchUrl = `${MOVIESMOD_BASE}/?s=${encodeURIComponent(query)}`;
    const response = await fetchWithRetry(searchUrl);
    const html = await response.text();
    const $ = cheerio.load(html);

    const results = [];
    
    // Evaluate standard content container layouts for search
    $('article.latestPost, article.post, .post').each((_, el) => {
      const a = $(el).find('h2 a, .title a, a.title').first();
      if (a.length === 0) return;
      
      const url = a.attr('href');
      const title = a.attr('title') || a.text().trim();

      if (url && title && !url.includes('javascript')) {
        const fullUrl = url.startsWith('http') ? url : `${MOVIESMOD_BASE}${url}`;
        
        if (!results.some(r => r.url === fullUrl)) {
          results.push({
            url: fullUrl,
            title: title,
            source: 'moviesmod',
          });
        }
      }
    });

    cache.set(cacheKey, {
      data: results,
      timestamp: Date.now(),
    });

    return results;
  } catch (error) {
    console.error(`MoviesMod search error for "${query}":`, error.message);
    throw error;
  }
}

// Extract download links from page
async function extractDownloadLinks(moviePageUrl, logs) {
  try {
    logs.push(`[Extract] Fetching movie page: ${moviePageUrl}`);
    const response = await fetchWithRetry(moviePageUrl);
    const html = await response.text();

    const $ = cheerio.load(html);
    const links = [];
    
    const contentBox = $('.thecontent');
    if (contentBox.length === 0) {
      logs.push('[Extract] ✗ No .thecontent div found');
      return links;
    }

    let lastHeader = 'Unknown Quality';
    
    // Iterate sequentially over elements to associate links with the closest preceding header
    contentBox.children().each((_, el) => {
      const tagName = el.tagName.toLowerCase();
      
      if (['h2', 'h3', 'h4', 'h5', 'h6'].includes(tagName)) {
        lastHeader = $(el).text().trim();
      } else if (tagName === 'p' || tagName === 'div') {
        $(el).find('a').each((_, aEl) => {
          const a = $(aEl);
          const url = a.attr('href');
          
          if (url && (url.includes('modpro') || url.includes('links'))) {
            logs.push(`[Extract] Evaluated anchor URL: ${url}`);
            
            // Apply regex extraction against the active state of lastHeader
            const qualityMatch = lastHeader.match(/\b(480p|720p|1080p|2160p|4K)\b/i);
            const bitMatch = lastHeader.match(/\b(10Bit|8Bit)\b/i);
            const sizeMatch = lastHeader.match(/\[([0-9.]+\s*[KMGT]B)\]/i);
            
            let quality = lastHeader;
            if (quality.length > 100) {
              quality = '';
              if (qualityMatch) quality += qualityMatch[1];
              if (bitMatch) quality += ' ' + bitMatch[1];
              if (sizeMatch) quality += ' [' + sizeMatch[1] + ']';
              if (!quality) quality = 'Unknown';
            }

            links.push({
              quality: quality.trim(),
              url: url.startsWith('http') ? url : `${MOVIESMOD_BASE}${url}`,
            });
            logs.push(`[Extract] ✓ Captured link for quality: ${quality.trim()}`);
          }
        });
      }
    });

    logs.push(`[Extract] Found ${links.length} download links`);
    return links;
  } catch (error) {
    logs.push(`[Extract] ✗ Error extracting download links: ${error.message}`);
    return [];
  }
}

// Resolve SID (unblockedgames.world, creativeexpressions) token payloads
async function resolveTechUnblockedLink(sidUrl, logs) {
  logs.push(`[SID] Resolving payload for: ${sidUrl}`);
  const { origin } = new URL(sidUrl);

  try {
    let response = await fetchWithRetry(sidUrl);
    let html = await response.text();
    let $ = cheerio.load(html);
    
    const wp_http = $('input[name="_wp_http"]').val();
    let action1 = $('form').attr('action');
    
    if (!wp_http || !action1) {
      logs.push(`[SID] ✗ Could not find initial token _wp_http or form action.`);
      return null;
    }
    action1 = new URL(action1, origin).href;
    logs.push(`[SID] Step 1 passed. Action URL: ${action1}`);

    const formData1 = new URLSearchParams({ '_wp_http': wp_http });
    response = await fetchWithRetry(action1, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': sidUrl,
      },
      body: formData1.toString(),
    });

    html = await response.text();
    $ = cheerio.load(html);
    
    const wp_http2 = $('input[name="_wp_http2"]').val();
    const token = $('input[name="token"]').val();
    let action2 = $('form').attr('action');

    if (!wp_http2 || !token || !action2) {
      logs.push(`[SID] ✗ Could not find secondary tokens _wp_http2 or token.`);
      return null;
    }
    action2 = new URL(action2, origin).href;
    logs.push(`[SID] Step 2 passed. Final action URL: ${action2}`);

    const formData2 = new URLSearchParams({ '_wp_http2': wp_http2, token });
    response = await fetchWithRetry(action2, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': action1,
      },
      body: formData2.toString(),
    });

    html = await response.text();
    let match = html.match(/setAttribute\("href",\s*"([^"]+)"\)/);
    
    if (!match) {
      logs.push(`[SID] ✗ JS execution payload missing setAttribute("href"). Checking fallback...`);
      const redirectMatch = html.match(/window\.location\.replace\("([^"]+)"\)/);
      if(redirectMatch) {
          const finalUrl = new URL(redirectMatch[1], origin).href;
          logs.push(`[SID] ✓ Resolved via window.location fallback: ${finalUrl}`);
          return finalUrl;
      }
      return null;
    }
    
    const finalUrl = new URL(match[1], origin).href;
    logs.push(`[SID] ✓ Successfully resolved SID: ${finalUrl}`);
    return finalUrl;
  } catch (error) {
    logs.push(`[SID] ✗ Exception: ${error.message}`);
    return null;
  }
}

// Resolve intermediate routing domains (dramadrip, modrefer, modpro)
async function resolveIntermediateLink(initialUrl, refererUrl, quality, logs) {
  try {
    const urlObject = new URL(initialUrl);

    if (urlObject.hostname.includes('dramadrip.com')) {
      logs.push(`[Dramadrip] Processing: ${initialUrl}`);
      const response = await fetchWithRetry(initialUrl, { headers: { 'Referer': refererUrl } });
      const html = await response.text();
      const $ = cheerio.load(html);

      let episodePageLink = null;
      const seasonMatch = quality.match(/Season\s+(\d+)/i);
      
      if (seasonMatch) {
        const seasonId = seasonMatch[0].toLowerCase();
        const qualityMatch = quality.match(/(1080p|720p|480p|2160p)/i);
        const targetQuality = qualityMatch ? qualityMatch[1].toLowerCase() : '';

        $('a').each((_, el) => {
          const a = $(el);
          const link = a.attr('href') || '';
          const text = a.text().toLowerCase();
          const headerMatch = html.match(new RegExp(seasonId + '[^<]*', 'i'));
          
          if (link.includes('episodes.modpro') || link.includes('cinematickit')) {
            if (targetQuality && text.includes(targetQuality) && headerMatch) {
              episodePageLink = link;
            }
          }
        });
      }

      if (!episodePageLink) {
        episodePageLink = $('a[href*="episodes.modpro"], a[href*="cinematickit"]').first().attr('href') || null;
      }

      if (episodePageLink) {
        logs.push(`[Dramadrip] Resolved to episode page, executing drill down.`);
        return await resolveIntermediateLink(episodePageLink, initialUrl, quality, logs);
      }
    } else if (urlObject.hostname.includes('episodes.modpro.blog') || urlObject.hostname.includes('cinematickit.org')) {
      logs.push(`[Episodes] Processing: ${initialUrl}`);
      const response = await fetchWithRetry(initialUrl, { headers: { 'Referer': refererUrl } });
      const html = await response.text();
      const $ = cheerio.load(html);

      const finalLinks = [];
      $('a[href*="driveseed"]').each((_, el) => {
        const a = $(el);
        finalLinks.push({
          server: a.text().trim() || 'Driveseed',
          url: a.attr('href'),
        });
      });
      logs.push(`[Episodes] Found ${finalLinks.length} links`);
      return finalLinks;

    } else if (urlObject.hostname.includes('modrefer.in') || urlObject.hostname.includes('links.modpro.blog')) {
      logs.push(`[ModRefer] Processing: ${initialUrl}`);
      const response = await fetchWithRetry(initialUrl, { headers: { 'Referer': refererUrl } });
      const html = await response.text();
      const $ = cheerio.load(html);

      const finalLinks = [];
      
      $('a').each((_, el) => {
        const a = $(el);
        const url = a.attr('href');
        const text = a.text().trim();
        
        if (url && (url.includes('driveseed') || url.includes('drive') || url.includes('cloud') || url.includes('unblockedgames') || url.includes('urlflix'))) {
          if (!text.toLowerCase().includes('comment')) {
            finalLinks.push({ 
              server: text || 'Direct Link', 
              url 
            });
            logs.push(`[ModRefer] Extracted target server: ${text}`);
          }
        }
      });
      
      logs.push(`[ModRefer] Found ${finalLinks.length} valid routing links`);
      return finalLinks;
    }

    return [];
  } catch (error) {
    logs.push(`[Intermediate] ✗ Error: ${error.message}`);
    return [];
  }
}

// Resolve driveseed domains against JS challenge limits
async function resolveDriveseedLink(driveseedUrl, logs) {
  try {
    logs.push(`[Driveseed] Resolving: ${driveseedUrl}`);
    const response = await fetchWithRetry(driveseedUrl);
    const html = await response.text();

    const redirectMatch = html.match(/window\.location\.replace\("([^"]+)"\)/);
    if (!redirectMatch) {
      logs.push(`[Driveseed] ✗ No redirect found`);
      return { downloadOptions: [], size: null, fileName: null };
    }

    const finalUrl = `https://driveseed.org${redirectMatch[1]}`;
    logs.push(`[Driveseed] Following JS redirect to ${finalUrl}`);
    const finalResponse = await fetchWithRetry(finalUrl);
    const finalHtml = await finalResponse.text();
    const $ = cheerio.load(finalHtml);

    const downloadOptions = [];
    
    $('a').each((_, el) => {
      const a = $(el);
      const href = a.attr('href') || '';
      const text = a.text().toLowerCase();
      
      if (href.includes('instant') || href.includes('video-seed')) {
        if (text.includes('instant')) {
           downloadOptions.push({ title: 'Instant Download', type: 'instant', url: href, priority: 1 });
        }
      } else if (href.includes('resume')) {
        downloadOptions.push({ title: 'Resume Cloud', type: 'resume', url: href, priority: 2 });
      } else if (href.includes('worker')) {
        downloadOptions.push({ title: 'Resume Worker Bot', type: 'worker', url: href, priority: 3 });
      }
    });

    let size = null;
    let fileName = null;
    
    const sizeMatch = finalHtml.match(/Size\s*:\s*([0-9.,]+\s*[KMGT]B)/i);
    if (sizeMatch) size = sizeMatch[1];

    const fileMatch = finalHtml.match(/Name\s*:\s*([^<]+)/i);
    if (fileMatch) fileName = fileMatch[1].trim();

    downloadOptions.sort((a, b) => a.priority - b.priority);
    logs.push(`[Driveseed] ✓ Found ${downloadOptions.length} download options`);
    return { downloadOptions, size, fileName };
  } catch (error) {
    logs.push(`[Driveseed] ✗ Error: ${error.message}`);
    return { downloadOptions: [], size: null, fileName: null };
  }
}

// Main execution wrapper tying the resolution chains
async function extractAllDownloadableLinks(moviePageUrl) {
  const logs = [];
  logs.push(`[Main] Getting all downloadable links from: ${moviePageUrl}`);
  try {
    const downloadLinks = await extractDownloadLinks(moviePageUrl, logs);
    
    if (downloadLinks.length === 0) {
      logs.push(`[Main] ✗ No initial download links found`);
      return { links: [], logs };
    }

    const allDownloadableLinks = [];

    for (const link of downloadLinks.slice(0, 10)) {
      try {
        logs.push(`[Main] Processing quality: ${link.quality}`);
        
        const finalLinks = await resolveIntermediateLink(link.url, moviePageUrl, link.quality, logs);
        
        for (const targetLink of finalLinks) {
          try {
            let currentUrl = targetLink.url;

            if (currentUrl.includes('unblockedgames') || currentUrl.includes('creativeexpressions')) {
              logs.push(`[Main] SID link detected, escalating to resolveTechUnblockedLink`);
              const resolvedSid = await resolveTechUnblockedLink(currentUrl, logs);
              if (resolvedSid) {
                currentUrl = resolvedSid;
              }
            }

            if (currentUrl.includes('driveseed.org') || currentUrl.includes('driveseed')) {
              const { downloadOptions, size, fileName } = await resolveDriveseedLink(currentUrl, logs);
              
              for (const option of downloadOptions) {
                allDownloadableLinks.push({
                  quality: link.quality,
                  server: targetLink.server,
                  method: option.title,
                  url: option.url,
                  size,
                  fileName,
                });
              }
            } else {
              allDownloadableLinks.push({
                quality: link.quality,
                server: targetLink.server,
                method: 'Direct Link',
                url: currentUrl,
              });
            }
          } catch (e) {
             logs.push(`[Main] ✗ Error with ${targetLink.server}: ${e.message}`);
          }
        }
      } catch (e) {
        logs.push(`[Main] ✗ Error with quality ${link.quality}: ${e.message}`);
      }
    }

    logs.push(`[Main] ✓ Finished. Total links extracted: ${allDownloadableLinks.length}`);
    return { links: allDownloadableLinks, logs };
  } catch (error) {
    logs.push(`[Main] ✗ Fatal Error: ${error.message}`);
    return { links: [], logs };
  }
}

// Stremio HTTP server handler defining frontend layout
async function handleRequest(request) {
  const url = new URL(request.url);
  let path = url.pathname;
  
  if (!path || path === '') path = '/';

  if (path === '/' || path === '/search') {
    return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MoviesMod Enhanced Scraper</title>
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
    h1 { color: #333; margin-bottom: 10px; text-align: center; }
    .subtitle { color: #666; text-align: center; margin-bottom: 30px; font-size: 14px; }
    .search-box { display: flex; gap: 10px; margin-bottom: 30px; }
    input { flex: 1; padding: 12px 16px; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 16px; }
    input:focus { outline: none; border-color: #667eea; }
    button { padding: 12px 30px; background: #667eea; color: white; border: none; border-radius: 8px; cursor: pointer; }
    button:hover { background: #764ba2; }
    .two-column { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 30px; }
    @media (max-width: 768px) { .two-column { grid-template-columns: 1fr; } }
    .section { background: #f9f9f9; padding: 20px; border-radius: 8px; border: 1px solid #e0e0e0; }
    .section-title { font-weight: 600; color: #667eea; margin-bottom: 15px; font-size: 14px; text-transform: uppercase; }
    .result-item { background: white; padding: 12px; border-radius: 6px; margin-bottom: 10px; border-left: 3px solid #667eea; word-break: break-word; }
    .result-title { font-weight: 600; color: #333; margin-bottom: 6px; font-size: 13px; }
    .result-url { font-size: 11px; color: #666; font-family: monospace; background: #f0f0f0; padding: 6px; border-radius: 4px; margin-bottom: 6px; display: block; overflow-x: auto; }
    .copy-btn { font-size: 10px; padding: 4px 12px; background: #e0e0e0; color: #333; border: none; border-radius: 4px; cursor: pointer; }
    .copy-btn:hover { background: #d0d0d0; }
    .loading { text-align: center; color: #666; padding: 20px; }
    .error { background: #fee; color: #c33; padding: 15px; border-radius: 8px; border-left: 4px solid #c33; margin-top: 20px; }
    .empty { text-align: center; color: #999; padding: 30px 20px; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎬 MoviesMod Enhanced Scraper</h1>
    <p class="subtitle">Search & Extract Direct Download Links</p>
    
    <div class="search-box">
      <input 
        type="text" 
        id="searchInput" 
        placeholder="Search movie or series..." 
        onkeypress="if(event.key==='Enter') search()"
        autofocus
      >
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
      <div class="section-title">🐛 Debug Logs</div>
      <div id="debugLogs" style="font-family: monospace; font-size: 12px; background: #fff; padding: 15px; border-radius: 8px; border: 1px solid #e0e0e0; max-height: 400px; overflow-y: auto; color: #444; line-height: 1.5;">
        Awaiting action...
      </div>
    </div>
  </div>

  <script>
    async function search() {
      const query = document.getElementById('searchInput').value.trim();
      if (!query) return;

      const pageDiv = document.getElementById('pageResults');
      const downloadDiv = document.getElementById('downloadResults');
      const debugDiv = document.getElementById('debugLogs');
      const alertDiv = document.getElementById('alert');
      
      alertDiv.style.display = 'none';
      pageDiv.innerHTML = '<div class="loading">Searching movies...</div>';
      downloadDiv.innerHTML = '';
      debugDiv.innerHTML = '<div class="loading">Awaiting trace logs...</div>';

      try {
        const pageResponse = await fetch(\`/search-api?q=\${encodeURIComponent(query)}\`);
        const pageData = await pageResponse.json();

        if (!pageData.results || pageData.results.length === 0) {
          pageDiv.innerHTML = '<div class="empty">No results found</div>';
          return;
        }

        pageDiv.innerHTML = pageData.results.map((r, i) => \`
          <div class="result-item">
            <div class="result-title">\${i + 1}. \${r.title}</div>
            <span class="result-url">\${r.url}</span>
            <button class="copy-btn" onclick="copyText('\${r.url}')">Copy URL</button>
          </div>
        \`).join('');

        downloadDiv.innerHTML = '<div class="loading">Extracting download links...</div>';
        
        const firstResult = pageData.results[0];
        const linksResponse = await fetch(\`/extract-links?url=\${encodeURIComponent(firstResult.url)}\`);
        const linksData = await linksResponse.json();

        if (linksData.logs) {
          debugDiv.innerHTML = linksData.logs.map(log => {
             const isErr = log.includes('✗');
             const isPass = log.includes('✓');
             const color = isErr ? '#c33' : isPass ? '#2a9d8f' : '#444';
             return \`<div style="color: \${color}; border-bottom: 1px solid #eee; padding-bottom: 2px; margin-bottom: 4px;">\${log}</div>\`;
          }).join('');
        }

        if (!linksData.links || linksData.links.length === 0) {
          downloadDiv.innerHTML = '<div class="empty">No downloadable links found</div>';
          return;
        }

        const grouped = {};
        linksData.links.forEach(link => {
          if (!grouped[link.quality]) grouped[link.quality] = [];
          grouped[link.quality].push(link);
        });

        let html = '';
        Object.keys(grouped).forEach(quality => {
          html += \`<div style="margin-bottom: 15px;">
            <div class="result-title">\${quality}</div>\`;
          
          grouped[quality].forEach(link => {
            html += \`<div style="margin-left: 10px; margin-bottom: 8px;">
              <div style="font-size: 11px; color: #666; margin-bottom: 4px;">
                📌 \${link.method}\${link.server ? ' • ' + link.server : ''}\${link.fileName ? '<br/>📁 ' + link.fileName : ''}\${link.size ? '<br/>📊 ' + link.size : ''}
              </div>
              <span class="result-url">\${link.url}</span>
              <button class="copy-btn" onclick="copyText('\${link.url}')">Copy</button>
            </div>\`;
          });
          
          html += '</div>';
        });

        downloadDiv.innerHTML = html;

      } catch (error) {
        alertDiv.textContent = \`Error: \${error.message}\`;
        alertDiv.style.display = 'block';
      }
    }

    function copyText(text) {
      navigator.clipboard.writeText(text);
      alert('Copied to clipboard!');
    }
  </script>
</body>
</html>`, {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  if (path === '/manifest.json') {
    return new Response(JSON.stringify(MANIFEST), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  if (path === '/search-api') {
    const query = url.searchParams.get('q');
    if (!query) {
      return new Response(JSON.stringify({ results: [] }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    try {
      const results = await searchMoviesMod(query);
      return new Response(JSON.stringify({ results: results.slice(0, 10) }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    } catch (error) {
      return new Response(JSON.stringify({ results: [], error: error.message }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  }

  if (path === '/extract-links') {
    const pageUrl = url.searchParams.get('url');
    if (!pageUrl) {
      return new Response(JSON.stringify({ links: [], logs: ['✗ No URL provided'] }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    try {
      const result = await extractAllDownloadableLinks(pageUrl);
      return new Response(JSON.stringify({ links: result.links, logs: result.logs }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    } catch (error) {
      return new Response(JSON.stringify({ links: [], logs: [`✗ Fatal error: ${error.message}`] }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  }

  const streamMatch = path.match(/^\/stream\/([^\/]+)\/([^\/]+)\.json$/);
  if (streamMatch) {
    const type = streamMatch[1];
    const id = streamMatch[2];

    try {
      if (!id.startsWith('tt') && !id.startsWith('tmdb:')) {
        return new Response(JSON.stringify({ streams: [] }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }
      return new Response(JSON.stringify({ streams: [] }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    } catch (error) {
      return new Response(JSON.stringify({ streams: [] }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
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
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    try {
      return await handleRequest(request);
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};

import puppeteer from "@cloudflare/puppeteer";

const MANIFEST = {
  id: 'moviesmod.addon',
  version: '1.0.0',
  name: 'MoviesMod Smart Extractor',
  description: 'Serverless link extractor with Nuvio-style SID resolution',
  types: ['movie', 'series'],
  catalogs: [],
  resources: ['stream'],
  idPrefixes: ['tt', 'tmdb:'],
  behaviorHints: { p2p: false, configurable: false },
};

const MOVIESMOD_BASE = 'https://moviesmod.army';
const cache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000;

// Helper to escape HTML
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

// ============================================================================
// NUVIO-STYLE SID RESOLVER (No Puppeteer needed!)
// ============================================================================

async function resolveTechUnblockedLink(sidUrl, logger) {
  logger(`[SID] Starting Nuvio-style resolution...`);
  const origin = new URL(sidUrl).origin;

  try {
    logger(`[SID] Step 0: Loading initial page...`);
    const response0 = await fetch(sidUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });

    const html0 = await response0.text();
    const wp_httpMatch = html0.match(/<input[^>]*name=["']_wp_http["'][^>]*value=["']([^"']+)["']/i);
    if (!wp_httpMatch?.[1]) {
      logger(`[SID] ✗ Could not find _wp_http in form`);
      return null;
    }

    const actionMatch = html0.match(/<form[^>]*action=["']([^"']+)["']/i);
    if (!actionMatch?.[1]) {
      logger(`[SID] ✗ Could not find form action`);
      return null;
    }

    const wp_http = wp_httpMatch[1];
    const action1 = actionMatch[1];
    logger(`[SID] ✓ Step 0: Extracted form data`);

    logger(`[SID] Step 1: Submitting form...`);
    const formData1 = new URLSearchParams();
    formData1.append('_wp_http', wp_http);

    const response1 = await fetch(action1, {
      method: 'POST',
      body: formData1.toString(),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': sidUrl,
      }
    });

    const html1 = await response1.text();
    logger(`[SID] ✓ Step 1: Form submitted`);

    logger(`[SID] Step 2: Extracting verification data...`);
    const wp_http2Match = html1.match(/<input[^>]*name=["']_wp_http2["'][^>]*value=["']([^"']+)["']/i);
    const tokenMatch = html1.match(/<input[^>]*name=["']token["'][^>]*value=["']([^"']+)["']/i);
    const action2Match = html1.match(/<form[^>]*action=["']([^"']+)["']/i);

    if (!wp_http2Match?.[1] || !tokenMatch?.[1] || !action2Match?.[1]) {
      logger(`[SID] ✗ Could not extract verification data`);
      return null;
    }

    const wp_http2 = wp_http2Match[1];
    const token = tokenMatch[1];
    const action2 = action2Match[1];
    logger(`[SID] ✓ Step 2: Extracted verification data`);

    logger(`[SID] Step 3: Submitting verification...`);
    const formData2 = new URLSearchParams();
    formData2.append('_wp_http2', wp_http2);
    formData2.append('token', token);

    const response2 = await fetch(action2, {
      method: 'POST',
      body: formData2.toString(),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': response1.url || sidUrl,
      }
    });

    const html2 = await response2.text();
    logger(`[SID] ✓ Step 3: Verification submitted`);

    logger(`[SID] Step 4: Extracting dynamic values...`);
    const cookieMatch = html2.match(/s_343\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/);
    const linkMatch = html2.match(/setAttribute\s*\(\s*["']href["']\s*,\s*["']([^"']+)["']\s*\)/);

    if (!cookieMatch?.[1] || !cookieMatch?.[2] || !linkMatch?.[1]) {
      logger(`[SID] ✗ Could not extract dynamic values from JS`);
      return null;
    }

    const cookieName = cookieMatch[1];
    const cookieValue = cookieMatch[2];
    const linkPath = linkMatch[1];
    logger(`[SID] ✓ Step 4: Found dynamic cookie: ${cookieName}`);

    logger(`[SID] Step 5: Fetching with dynamic cookie...`);
    const finalUrl = new URL(linkPath, origin).href;
    const cookieHeader = `${cookieName}=${cookieValue}`;

    const response3 = await fetch(finalUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': cookieHeader,
        'Referer': response2.url || sidUrl,
      }
    });

    const html3 = await response3.text();
    logger(`[SID] ✓ Step 5: Got final page`);

    logger(`[SID] Step 6: Extracting driveleech link...`);
    const metaMatch = html3.match(/<meta\s+http-equiv=["']refresh["'][^>]*content=["']([^"']+)["']/i);
    if (!metaMatch?.[1]) {
      logger(`[SID] ✗ No meta refresh found`);
      return null;
    }

    const urlMatch = metaMatch[1].match(/url\s*=\s*([^;]+)/i);
    if (!urlMatch?.[1]) {
      logger(`[SID] ✗ Could not extract URL from meta`);
      return null;
    }

    const driveleechUrl = urlMatch[1].trim().replace(/["']/g, '');
    logger(`[SID] ✓ SUCCESS: ${driveleechUrl.substring(0, 80)}...`);
    return driveleechUrl;

  } catch (error) {
    logger(`[SID] ✗ Error: ${error.message}`);
    return null;
  }
}

async function extractDriveseedOptions(url, logger) {
  logger(`[Driveseed] Fetching: ${url.substring(0, 80)}...`);

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });

    let html = await response.text();
    const redirectMatch = html.match(/window\.location\.replace\s*\(\s*["']([^"']+)["']\s*\)/);
    if (redirectMatch?.[1]) {
      logger(`[Driveseed] Following JS redirect...`);
      const redirectUrl = `https://driveseed.org${redirectMatch[1]}`;
      const redirectResponse = await fetch(redirectUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': url }
      });
      html = await redirectResponse.text();
    }

    const sizeMatch = html.match(/Size\s*:\s*([0-9.,]+\s*[KMGT]B)/i);
    const fileMatch = html.match(/Name\s*:\s*([^<\n]+)/i);

    const size = sizeMatch?.[1]?.trim() || null;
    const fileName = fileMatch?.[1]?.trim() || null;

    const options = [];
    const linkRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1];
      const text = (match[2] || '').replace(/<[^>]*>/g, '').toLowerCase().trim();

      if (text.includes('instant') || href.includes('video-seed')) {
        options.push({ title: 'Instant Download', type: 'instant', url: href, priority: 1 });
      } else if (text.includes('resume') && text.includes('cloud')) {
        options.push({ title: 'Resume Cloud', type: 'resume', url: href, priority: 2 });
      } else if (text.includes('worker') || text.includes('workerseed')) {
        options.push({ title: 'Resume Worker Bot', type: 'worker', url: href, priority: 3 });
      }
    }

    const seen = new Set();
    const unique = options.filter(o => {
      if (seen.has(o.url)) return false;
      seen.add(o.url);
      return true;
    });

    unique.sort((a, b) => a.priority - b.priority);
    logger(`[Driveseed] ✓ Found ${unique.length} options`);
    if (fileName) logger(`[Driveseed] File: ${fileName}`);
    if (size) logger(`[Driveseed] Size: ${size}`);

    return { options: unique, size, fileName };

  } catch (error) {
    logger(`[Driveseed] ✗ Error: ${error.message}`);
    return { options: [], size: null, fileName: null };
  }
}

// ============================================================================
// SEARCH & EXTRACTION
// ============================================================================

function stripTags(html) {
  return (html || '').replace(/<[^>]*>/g, '').trim();
}

async function searchMoviesMod(query) {
  const cacheKey = `search:${query}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey).data;
  }

  try {
    const url = `${MOVIESMOD_BASE}/?s=${encodeURIComponent(query)}`;
    const response = await fetch(url);
    const html = await response.text();
    const results = [];

    const articleRegex = /<article[^>]*>([\s\S]*?)<\/article>/gi;
    let articleMatch;

    while ((articleMatch = articleRegex.exec(html)) !== null) {
      const articleHtml = articleMatch[1];
      const linkMatch = articleHtml.match(/<a[^>]+href=["']([^"']+)["'][^>]*title=["']([^"']+)["']/)
                     || articleHtml.match(/<h2[^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/);

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
    throw error;
  }
}

async function extractDownloadLinks(moviePageUrl, logger) {
  logger(`[Extract] Fetching: ${moviePageUrl.substring(0, 60)}...`);

  const response = await fetch(moviePageUrl);
  const html = await response.text();

  const links = [];
  const contentMatch = html.match(/class=["'][^"']*thecontent[^"']*["'][^>]*>([\s\S]*?)(?:<div class="post-navigation"|<h4|<\/article>|<div id="comments")/i);

  if (!contentMatch) {
    logger(`[Extract] ✗ No content found`);
    return links;
  }

  const blocks = contentMatch[1].split(/(?=<h[2-6])/i);

  for (const block of blocks) {
    const headerMatch = block.match(/<h[2-6][^>]*>([\s\S]*?)<\/h[2-6]>/i);
    const quality = stripTags(headerMatch ? headerMatch[1] : 'Unknown');

    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let linkMatch;

    while ((linkMatch = linkRegex.exec(block)) !== null) {
      const url = linkMatch[1];
      if (url && (url.includes('modpro') || url.includes('links') || url.includes('unblockedgames') || url.includes('dramadrip'))) {
        links.push({ quality, url: url.startsWith('http') ? url : `${MOVIESMOD_BASE}${url}` });
      }
    }
  }

  logger(`[Extract] ✓ Found ${links.length} links`);
  return links;
}

async function resolveIntermediateLink(url, refererUrl, logger) {
  try {
    const urlObject = new URL(url);
    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    if (urlObject.hostname.includes('dramadrip.com')) {
      const response = await fetch(url, { headers: { 'Referer': refererUrl } });
      const html = await response.text();
      let link = null;
      let match;

      while ((match = linkRegex.exec(html)) !== null) {
        if (match[1].includes('episodes.modpro') || match[1].includes('cinematickit')) {
          link = match[1];
          break;
        }
      }

      if (link) return await resolveIntermediateLink(link, url, logger);
    } else if (urlObject.hostname.includes('episodes.modpro.blog') || urlObject.hostname.includes('cinematickit.org')) {
      const response = await fetch(url, { headers: { 'Referer': refererUrl } });
      const html = await response.text();
      const finalLinks = [];
      let match;

      while ((match = linkRegex.exec(html)) !== null) {
        if (match[1].includes('driveseed') || match[1].includes('unblockedgames') || match[1].includes('creativeexpressions') || match[1].includes('examzculture')) {
          finalLinks.push({ server: stripTags(match[2]) || 'Server', url: match[1] });
        }
      }

      return finalLinks;
    } else if (urlObject.hostname.includes('modrefer.in') || urlObject.hostname.includes('links.modpro.blog')) {
      const response = await fetch(url, { headers: { 'Referer': refererUrl } });
      const html = await response.text();
      const finalLinks = [];
      let match;

      while ((match = linkRegex.exec(html)) !== null) {
        const href = match[1];
        const text = stripTags(match[2]);
        if (href && (href.includes('driveseed') || href.includes('unblockedgames') || href.includes('creativeexpressions') || href.includes('examzculture'))) {
          if (!text.toLowerCase().includes('comment')) {
            finalLinks.push({ server: text || 'Link', url: href });
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

async function extractAllDownloadableLinks(moviePageUrl, env, logger) {
  logger(`[Pipeline] Starting extraction...`);

  try {
    const downloadLinks = await extractDownloadLinks(moviePageUrl, logger);
    if (downloadLinks.length === 0) {
      logger(`[Pipeline] ✗ No download links found`);
      return { links: [] };
    }

    const allLinks = [];
    const primaryLink = downloadLinks[0];
    logger(`[Pipeline] Processing: ${primaryLink.quality}`);

    try {
      const finalLinks = await resolveIntermediateLink(primaryLink.url, moviePageUrl, logger);
      if (!finalLinks || finalLinks.length === 0) {
        logger(`[Pipeline] ✗ No final links`);
        return { links: [] };
      }

      const primaryTarget = finalLinks.find(l => l.server.includes('Fast') || l.server.includes('G-Drive')) || finalLinks[0];
      logger(`[Pipeline] Target: ${primaryTarget.server}`);

      let currentUrl = primaryTarget.url;

      if (currentUrl.includes('unblockedgames') || currentUrl.includes('creativeexpressions') || currentUrl.includes('examzculture')) {
        logger(`[Pipeline] Detected SID link, resolving...`);
        const driveleechUrl = await resolveTechUnblockedLink(currentUrl, logger);

        if (driveleechUrl) {
          currentUrl = driveleechUrl;
          logger(`[Pipeline] ✓ SID resolved`);

          const response = await fetch(driveleechUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          let html = await response.text();
          let finalUrl = response.url || driveleechUrl;

          if (!finalUrl.includes('driveseed')) {
            const match = html.match(/(https?:\/\/[^\s"'<>]*driveseed\.org[^\s"'<>]*)/i);
            if (match) finalUrl = match[1];
          }

          if (finalUrl.includes('driveseed')) {
            const { options, size, fileName } = await extractDriveseedOptions(finalUrl, logger);
            for (const opt of options) {
              allLinks.push({
                quality: primaryLink.quality,
                server: primaryTarget.server,
                method: opt.title,
                url: opt.url,
                size,
                fileName
              });
            }
          }
        }
      } else if (currentUrl.includes('driveseed')) {
        const { options, size, fileName } = await extractDriveseedOptions(currentUrl, logger);
        for (const opt of options) {
          allLinks.push({
            quality: primaryLink.quality,
            server: primaryTarget.server,
            method: opt.title,
            url: opt.url,
            size,
            fileName
          });
        }
      } else {
        allLinks.push({
          quality: primaryLink.quality,
          server: primaryTarget.server,
          method: 'Direct',
          url: currentUrl
        });
      }

    } catch (error) {
      logger(`[Pipeline] ✗ Error: ${error.message}`);
    }

    logger(`[Pipeline] ✓ Complete: ${allLinks.length} streams`);
    return { links: allLinks };

  } catch (error) {
    logger(`[Pipeline] ✗ Fatal: ${error.message}`);
    return { links: [] };
  }
}

// ============================================================================
// CLOUDFLARE WORKERS HANDLERS
// ============================================================================

const htmlTemplate = (function() {
  const htmlContent = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MoviesMod Smart Extractor</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
.container { background: white; border-radius: 12px; padding: 40px; max-width: 1200px; margin: 0 auto; box-shadow: 0 20px 60px rgba(0,0,0,0.3); }
h1 { color: #333; text-align: center; margin-bottom: 30px; }
.search-box { display: flex; gap: 10px; margin-bottom: 30px; }
input { flex: 1; padding: 12px 16px; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 16px; }
button { padding: 12px 30px; background: #667eea; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; }
button:hover { background: #5568d3; }
.two-column { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 30px; }
@media (max-width: 768px) { .two-column { grid-template-columns: 1fr; } }
.section { background: #f9f9f9; padding: 20px; border-radius: 8px; border: 1px solid #e0e0e0; }
.section-title { font-weight: 600; color: #667eea; margin-bottom: 15px; text-transform: uppercase; font-size: 12px; }
.result-item { background: white; padding: 12px; border-radius: 6px; margin-bottom: 10px; border-left: 3px solid #667eea; }
.result-title { font-weight: 600; color: #333; margin-bottom: 6px; }
.result-url { font-size: 11px; color: #666; font-family: monospace; background: #f0f0f0; padding: 8px; border-radius: 4px; margin-bottom: 8px; display: block; overflow-x: auto; word-break: break-all; }
.btn-group { display: flex; gap: 8px; flex-wrap: wrap; }
.copy-btn { font-size: 10px; padding: 6px 12px; background: #e0e0e0; color: #333; border: none; border-radius: 4px; cursor: pointer; }
.copy-btn:hover { background: #d0d0d0; }
.empty { text-align: center; color: #999; padding: 30px 20px; }
.debug-log { font-family: 'Courier New', monospace; font-size: 12px; background: #1e1e1e; color: #d4d4d4; padding: 15px; border-radius: 8px; max-height: 300px; overflow-y: auto; line-height: 1.4; }
.log-success { color: #6a9955; }
.log-error { color: #f48771; }
.log-info { color: #9cdcfe; }
</style>
</head>
<body>
<div class="container">
<h1>🎬 MoviesMod Smart Extractor</h1>
<div class="search-box">
<input type="text" id="searchInput" placeholder="Search movie or series..." onkeypress="if(event.key===String.fromCharCode(13)) search()" autofocus>
<button onclick="search()">Search</button>
</div>
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
<div class="debug-log" id="debugLogs">Ready...</div>
</div>
</div>

<script>
let activeStream = null;

function search() {
  const query = document.getElementById('searchInput').value.trim();
  if (!query) return;

  if (activeStream) activeStream.close();

  document.getElementById('pageResults').innerHTML = '<div class="empty">Searching...</div>';
  document.getElementById('downloadResults').innerHTML = '';
  clearLogs();

  fetch('/search-api?q=' + encodeURIComponent(query))
    .then(res => res.json())
    .then(data => {
      if (!data.results || data.results.length === 0) {
        document.getElementById('pageResults').innerHTML = '<div class="empty">No results</div>';
        return;
      }

      let html = '';
      for (let i = 0; i < data.results.length; i++) {
        const r = data.results[i];
        const escapedUrl = r.url.replace(/'/g, '\\\\'').replace(/"/g, '&quot;');
        html += '<div class="result-item">' +
                '<div class="result-title">' + (i + 1) + '. ' + r.title + '</div>' +
                '<span class="result-url">' + r.url + '</span>' +
                '<div class="btn-group">' +
                '<button class="copy-btn" onclick="copyText(String.fromCharCode(39) + escapedUrl + String.fromCharCode(39))">Copy</button>' +
                '<button class="copy-btn" onclick="extractLinks(String.fromCharCode(39) + escapedUrl + String.fromCharCode(39))">Extract</button>' +
                '</div>' +
                '</div>';
      }
      document.getElementById('pageResults').innerHTML = html;
    })
    .catch(e => alert('Error: ' + e.message));
}

function extractLinks(url) {
  document.getElementById('downloadResults').innerHTML = '<div class="empty">Extracting...</div>';
  clearLogs();

  if (activeStream) activeStream.close();

  const es = new EventSource('/extract-links?url=' + encodeURIComponent(url));
  activeStream = es;

  es.onmessage = (evt) => {
    const data = JSON.parse(evt.data);
    
    if (data.type === 'log') {
      addLog(data.message);
    }
    
    if (data.type === 'result') {
      es.close();
      const links = data.links;
      
      if (!links || links.length === 0) {
        document.getElementById('downloadResults').innerHTML = '<div class="empty">No links found</div>';
        return;
      }

      const grouped = {};
      for (let i = 0; i < links.length; i++) {
        const l = links[i];
        if (!grouped[l.quality]) grouped[l.quality] = [];
        grouped[l.quality].push(l);
      }

      let html = '';
      for (const q in grouped) {
        html += '<div style="margin-bottom: 15px;"><div class="result-title">⭐ ' + q + '</div>';
        for (let i = 0; i < grouped[q].length; i++) {
          const l = grouped[q][i];
          html += '<div style="margin-left: 10px; margin-bottom: 12px;">' +
                  '<div style="font-size: 11px; color: #666; margin-bottom: 6px;">' +
                  '📌 ' + l.method + (l.server ? ' • ' + l.server : '') + (l.size ? '<br/>📊 ' + l.size : '') +
                  '</div>' +
                  '<span class="result-url">' + l.url + '</span>' +
                  '<div class="btn-group" style="margin-top: 6px;">' +
                  '<button class="copy-btn" onclick="copyText(String.fromCharCode(39) + l.url.replace(/String.fromCharCode(39)/g, String.fromCharCode(92) + String.fromCharCode(39)) + String.fromCharCode(39))">Copy</button>' +
                  '<button class="copy-btn" onclick="window.open(String.fromCharCode(39) + l.url + String.fromCharCode(39), String.fromCharCode(95) + String.fromCharCode(98) + String.fromCharCode(108) + String.fromCharCode(97) + String.fromCharCode(110) + String.fromCharCode(107))">Open</button>' +
                  '</div>' +
                  '</div>';
        }
        html += '</div>';
      }

      document.getElementById('downloadResults').innerHTML = html;
    }
  };

  es.onerror = () => es.close();
}

function copyText(text) {
  navigator.clipboard.writeText(text);
  alert('Copied!');
}

function clearLogs() {
  document.getElementById('debugLogs').innerHTML = '';
}

function addLog(msg) {
  const logs = document.getElementById('debugLogs');
  const div = document.createElement('div');
  
  if (msg.includes('✓')) div.className = 'log-success';
  else if (msg.includes('✗')) div.className = 'log-error';
  else div.className = 'log-info';
  
  div.textContent = msg;
  div.style.paddingBottom = '2px';
  div.style.marginBottom = '4px';
  div.style.borderBottom = '1px solid #333';
  
  logs.appendChild(div);
  logs.scrollTop = logs.scrollHeight;
}
</script>
</body>
</html>`;
  return htmlContent;
})();

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname || '/';

  if (path === '/' || path === '/search') {
    return new Response(htmlTemplate, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  if (path === '/manifest.json') {
    return new Response(JSON.stringify(MANIFEST), {
      headers: { 'Content-Type': 'application/json' }
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
        await writer.write(encoder.encode('data: ' + JSON.stringify({ type: 'log', message: msg }) + '\n\n'));
      } catch (e) {}
    };

    ctx.waitUntil((async () => {
      try {
        const result = await extractAllDownloadableLinks(pageUrl, env, streamLogger);
        await writer.write(encoder.encode('data: ' + JSON.stringify({ type: 'result', links: result.links }) + '\n\n'));
      } catch (error) {
        await streamLogger('[Error] ' + error.message);
        await writer.write(encoder.encode('data: ' + JSON.stringify({ type: 'result', links: [] }) + '\n\n'));
      } finally {
        await writer.close();
      }
    })());

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
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
          'Access-Control-Allow-Methods': 'GET, OPTIONS'
        }
      });
    }

    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      console.error('Error:', error);
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }
};

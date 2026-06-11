const MANIFEST = {
  id: 'moviesmod.addon',
  version: '0.4.1',
  name: 'MoviesMod',
  description: 'Extracts HTTP streams from MoviesMod (Custom Cookie Engine & Sub-page Referer)',
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
const cache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000;

function getMatch(text, regex, index = 1) {
  const match = text.match(regex);
  return match ? match[index] : null;
}

function stripTags(html) {
  return (html || '').replace(/<[^>]*>/g, '').trim();
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Base fetcher for standard domains
async function fetchWithRetry(url, options = {}, retries = 1) {
  const timeout = options.timeout || 15000;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, ...options.headers },
      });
      clearTimeout(timeoutId);
      if (response.status === 403 || response.status === 429) throw new Error(`Blocked: HTTP ${response.status}`);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.message.includes('Blocked')) throw error;
      if (attempt === retries) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

// Custom Fetch Engine: Manually catches 302 redirects to hoard cookies into a virtual session map
async function fetchWithCookies(url, options = {}, cookieMap = new Map()) {
  let currentUrl = url;
  let maxRedirects = 5;
  let html = '';
  let finalRes = null;

  while (maxRedirects > 0) {
    const headers = new Headers(options.headers || {});
    
    // Pre-seed session to bypass aggressive empty-cookie drops
    if (cookieMap.size === 0) {
      cookieMap.set('PHPSESSID', Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15));
      cookieMap.set('cf_clearance', Math.random().toString(36).substring(2, 15));
    }

    headers.set('Cookie', Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join('; '));
    headers.set('User-Agent', USER_AGENT);

    const res = await fetch(currentUrl, {
      method: options.method || 'GET',
      headers,
      body: options.body,
      redirect: 'manual', // Prevent native fetch from dropping Set-Cookie headers on 302 hops
      cache: 'no-store'
    });

    finalRes = res;
    html = await res.text();

    // 1. Extract Headers Cookies
    let setCookies = [];
    if (typeof res.headers.getSetCookie === 'function') {
      setCookies = res.headers.getSetCookie();
    } else {
      const sc = res.headers.get('set-cookie');
      if (sc) setCookies = sc.split(/,(?=\s*[A-Za-z0-9_-]+\s*=)/);
    }
    
    for (const c of setCookies) {
      if (!c) continue;
      const pair = c.split(';')[0].trim();
      const splitIndex = pair.indexOf('=');
      if (splitIndex !== -1) {
        const k = pair.substring(0, splitIndex).trim();
        const v = pair.substring(splitIndex + 1).trim();
        if (k && !['path', 'expires', 'domain', 'httponly', 'secure', 'samesite', 'max-age'].includes(k.toLowerCase())) {
          cookieMap.set(k, v);
        }
      }
    }

    // 2. Extract Javascript Inline Cookies
    const jsRegex = /document\.cookie\s*=\s*(['"`])([^`'"]+)\1/gi;
    let match;
    while ((match = jsRegex.exec(html)) !== null) {
      const pair = match[2].split(';')[0].trim();
      const splitIndex = pair.indexOf('=');
      if (splitIndex !== -1) {
        const k = pair.substring(0, splitIndex).trim();
        const v = pair.substring(splitIndex + 1).trim();
        if (k) cookieMap.set(k, v);
      }
    }

    // 3. Follow Redirect Manually
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      let location = res.headers.get('location');
      if (location) {
        if (location.startsWith('/')) location = new URL(location, currentUrl).href;
        else location = new URL(location).href;
        
        if (res.status === 302 || res.status === 303) {
          options.method = 'GET';
          delete options.body;
          if (options.headers) delete options.headers['Content-Type'];
        }
        
        if (!options.headers) options.headers = {};
        options.headers['Referer'] = currentUrl;
        
        currentUrl = location;
        maxRedirects--;
        continue;
      }
    }
    break;
  }
  return { response: finalRes, url: currentUrl, html, cookieMap };
}

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

async function extractDownloadLinks(moviePageUrl, logs) {
  try {
    logs.push(`[Extract] Fetching movie page: ${moviePageUrl}`);
    const response = await fetchWithRetry(moviePageUrl);
    const html = await response.text();

    const links = [];
    const contentMatch = html.match(/class=["'][^"']*thecontent[^"']*["'][^>]*>([\s\S]*?)(?:<div class="post-navigation"|<h4 class="total-comments"|<\/article>|<div id="comments")/i);
    if (!contentMatch) return links;

    const blocks = contentMatch[1].split(/(?=<h[2-6])/i);
    
    for (const block of blocks) {
      const headerMatch = block.match(/<h[2-6][^>]*>([\s\S]*?)<\/h[2-6]>/i);
      const rawHeader = stripTags(headerMatch ? headerMatch[1] : 'Unknown Quality');
      const qualityMatch = rawHeader.match(/\b(480p|720p|1080p|2160p|4K)\b/i);
      
      let quality = rawHeader;
      if (quality.length > 100 || !qualityMatch) {
        quality = '';
        if (qualityMatch) quality += qualityMatch[1];
        if (!quality) quality = 'Unknown';
      }
      quality = quality.trim();

      const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let linkMatch;
      
      while ((linkMatch = linkRegex.exec(block)) !== null) {
        const url = linkMatch[1];
        if (url && (url.includes('modpro') || url.includes('links'))) {
          links.push({ quality, url: url.startsWith('http') ? url : `${MOVIESMOD_BASE}${url}` });
        }
      }
    }
    logs.push(`[Extract] Found ${links.length} download links`);
    return links;
  } catch (error) {
    return [];
  }
}

// Complete Safelink Bypass resolving Sub-Page Redirections and strict Referers
async function resolveTechUnblockedLink(sidUrl, logs) {
  logs.push(`[SID] Resolving payload for: ${sidUrl}`);
  const { origin } = new URL(sidUrl);
  const cookieMap = new Map();

  try {
    // Step 1: Initial Load (Follows any HTTP 302 to root automatically)
    let step1 = await fetchWithCookies(sidUrl, { method: 'GET' }, cookieMap);
    let wp_http = getMatch(step1.html, /name=["']_wp_http["']\s+value=["']([^"']+)["']/i) || getMatch(step1.html, /value=["']([^"']+)["']\s+name=["']_wp_http["']/i);
    let action1 = getMatch(step1.html, /<form[^>]+action=["']([^"']+)["']/i) || step1.url;
    
    if (!wp_http) {
      logs.push(`[SID] ✗ Missing initial token. Snippet: ${step1.html.replace(/\s+/g, ' ').substring(0, 150)}`);
      return null;
    }

    const action1Url = new URL(action1, step1.url).href;

    // Step 2: POST to root
    let step2 = await fetchWithCookies(action1Url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': step1.url },
      body: new URLSearchParams({ '_wp_http': wp_http }).toString()
    }, cookieMap);

    let currentUrl = step2.url;
    let html2 = step2.html;

    // Bridge checking: The server often returns an HTML page with a <meta> refresh or JS window.location instead of a 302
    let subpageUrlMatch = getMatch(html2, /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?[0-9]+;\s*url=([^"']+)["']?/i) || 
                          getMatch(html2, /window\.location(?:\.replace|\.href)?\s*(?:\(\s*|=\s*)["']([^"']+)["']/i);

    if (subpageUrlMatch) {
      let subpageUrl = new URL(subpageUrlMatch, currentUrl).href;
      if (subpageUrl !== currentUrl) {
        logs.push(`[SID] Following HTML/JS redirect to Sub-Page: ${subpageUrl}`);
        let step2_5 = await fetchWithCookies(subpageUrl, { method: 'GET', headers: { 'Referer': currentUrl } }, cookieMap);
        currentUrl = step2_5.url;
        html2 = step2_5.html;
      }
    }

    logs.push(`[SID] Landed on Sub-Page: ${currentUrl}`);

    let wp_http2 = getMatch(html2, /name=["']_wp_http2["']\s+value=["']([^"']+)["']/i) || getMatch(html2, /value=["']([^"']+)["']\s+name=["']_wp_http2["']/i);
    let token = getMatch(html2, /name=["']token["']\s+value=["']([^"']+)["']/i) || getMatch(html2, /value=["']([^"']+)["']\s+name=["']token["']/i);
    let action2 = getMatch(html2, /<form[^>]+action=["']([^"']+)["']/i) || currentUrl;

    if (!wp_http2) {
      logs.push(`[SID] ✗ Missing secondary tokens on Sub-Page. Snippet: ${html2.replace(/\s+/g, ' ').substring(0, 150)}`);
      return null;
    }

    const action2Url = new URL(action2, currentUrl).href;

    // Step 3: POST tokens from exact sub-page
    let step3 = await fetchWithCookies(action2Url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': currentUrl },
      body: new URLSearchParams({ '_wp_http2': wp_http2, token: token || '' }).toString()
    }, cookieMap);
    
    let matchUrl = getMatch(step3.html, /href=["']([^"']*\?go=[^"']+)["']/i) || 
                   getMatch(step3.html, /window\.open\(['"]([^'"]*\?go=[^'"]+)['"]/i) || 
                   getMatch(step3.html, /setAttribute\("href",\s*"([^"]+)"\)/) || 
                   getMatch(step3.html, /window\.location\.replace\("([^"]+)"\)/);

    if (!matchUrl) {
       logs.push(`[SID] ✗ No jump link generated in payload. Snippet: ${step3.html.replace(/\s+/g, ' ').substring(0, 150)}`);
       return null;
    }
    
    const goUrl = new URL(matchUrl, step3.url).href;
    logs.push(`[SID] Final ?go URL: ${goUrl}`);
    logs.push(`[Cookies] Mapped: ${Array.from(cookieMap.keys()).join(', ')}`);
    logs.push(`[SID] Waiting exactly 10s...`);

    // Force 10s delay to completely bypass the backend "Double Click" velocity anti-bot trap
    await new Promise(r => setTimeout(r, 10000));

    // Step 4: Access ?go link FROM the exact sub-page Reference
    let step4 = await fetchWithCookies(goUrl, {
      method: 'GET',
      headers: { 'Referer': step3.url, 'Upgrade-Insecure-Requests': '1' }
    }, cookieMap);

    let finalUrl = step4.url;

    // Validate that finalUrl moved off the ?go endpoint. If it didn't, parse error state.
    if (finalUrl === goUrl || finalUrl.includes('?go=')) {
      if (step4.html.includes("Bad Request") || step4.html.includes("Generate Link Again")) {
        logs.push(`[SID] ✗ Target returned Bad Request.`);
        logs.push(`[SID] Error Snippet: ${step4.html.replace(/\s+/g, ' ').substring(0, 180)}`);
        return null;
      }
      
      let dsMatch = step4.html.match(/(https?:\/\/(?:www\.)?driveseed\.org\/[^\s'"]+)/i);
      if (dsMatch) {
         logs.push(`[SID] Extracted DriveSeed from raw body directly.`);
         finalUrl = dsMatch[1];
      } else {
         const jsRedirectMatch = getMatch(step4.html, /window\.location(?:\.replace|\.href)?\s*(?:\(\s*|=\s*)["']([^"']+)["']/i);
         if (jsRedirectMatch) {
             finalUrl = new URL(jsRedirectMatch, goUrl).href;
         } else {
             logs.push(`[SID] ✗ Target failed to provide JS redirect. Snippet: ${step4.html.replace(/\s+/g, ' ').substring(0, 180)}`);
             return null;
         }
      }
    }

    if (finalUrl.includes('driveseed.org')) {
       logs.push(`[SID] ✓ Redirected securely to DriveSeed: ${finalUrl}`);
       return finalUrl;
    } else {
       logs.push(`[SID] ✗ Path led somewhere else: ${finalUrl}`);
       return null;
    }
  } catch (error) {
    logs.push(`[SID] ✗ Exception: ${error.message}`);
    return null;
  }
}

async function resolveIntermediateLink(initialUrl, refererUrl, quality, logs) {
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
      if (episodePageLink) return await resolveIntermediateLink(episodePageLink, initialUrl, quality, logs);
    } else if (urlObject.hostname.includes('episodes.modpro.blog') || urlObject.hostname.includes('cinematickit.org')) {
      const response = await fetchWithRetry(initialUrl, { headers: { 'Referer': refererUrl } });
      const html = await response.text();
      const finalLinks = [];
      let match;
      while ((match = linkRegex.exec(html)) !== null) {
        if (match[1].includes('driveseed')) finalLinks.push({ server: stripTags(match[2]) || 'Driveseed', url: match[1] });
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
        if (url && (url.includes('driveseed') || url.includes('drive') || url.includes('cloud') || url.includes('unblockedgames') || url.includes('urlflix'))) {
          if (!text.toLowerCase().includes('comment')) finalLinks.push({ server: text || 'Direct Link', url });
        }
      }
      logs.push(`[ModRefer] Found ${finalLinks.length} routing links.`);
      return finalLinks;
    }
    return [];
  } catch (error) {
    return [];
  }
}

async function resolveDriveseedLink(driveseedUrl, logs) {
  try {
    logs.push(`[Driveseed] Resolving: ${driveseedUrl}`);
    const response = await fetchWithRetry(driveseedUrl);
    let finalHtml = await response.text();

    const redirectMatch = getMatch(finalHtml, /window\.location(?:\.replace|\.href)?\s*(?:\(\s*|=\s*)["']([^"']+)["']/i);
    if (redirectMatch) {
      const finalUrl = redirectMatch.startsWith('http') ? redirectMatch : `https://driveseed.org${redirectMatch.startsWith('/') ? '' : '/'}${redirectMatch}`;
      const finalResponse = await fetchWithRetry(finalUrl);
      finalHtml = await finalResponse.text();
    }

    const downloadOptions = [];
    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = linkRegex.exec(finalHtml)) !== null) {
      const href = match[1];
      const text = stripTags(match[2]).toLowerCase();

      if (href.includes('instant') || href.includes('video-seed')) {
        if (text.includes('instant')) downloadOptions.push({ title: 'Instant Download', type: 'instant', url: href, priority: 1 });
      } else if (href.includes('resume')) {
        downloadOptions.push({ title: 'Resume Cloud', type: 'resume', url: href, priority: 2 });
      } else if (href.includes('worker')) {
        downloadOptions.push({ title: 'Resume Worker Bot', type: 'worker', url: href, priority: 3 });
      }
    }

    const size = getMatch(finalHtml, /Size\s*:\s*([0-9.,]+\s*[KMGT]B)/i);
    const fileName = getMatch(finalHtml, /Name\s*:\s*([^<]+)/i, 1)?.trim() || null;

    downloadOptions.sort((a, b) => a.priority - b.priority);
    logs.push(`[Driveseed] ✓ Found ${downloadOptions.length} download options`);
    return { downloadOptions, size, fileName };
  } catch (error) {
    logs.push(`[Driveseed] ✗ Error: ${error.message}`);
    return { downloadOptions: [], size: null, fileName: null };
  }
}

async function extractAllDownloadableLinks(moviePageUrl) {
  const logs = [];
  logs.push(`[Main] Getting all downloadable links from: ${moviePageUrl}`);
  try {
    const downloadLinks = await extractDownloadLinks(moviePageUrl, logs);
    if (downloadLinks.length === 0) return { links: [], logs };

    const allDownloadableLinks = [];

    // LIMIT TO EXACTLY 1 QUALITY to guarantee completion
    for (const link of downloadLinks.slice(0, 1)) {
      try {
        logs.push(`[Main] Evaluating quality layer: ${link.quality}`);
        const finalLinks = await resolveIntermediateLink(link.url, moviePageUrl, link.quality, logs);
        
        const primaryTarget = finalLinks.find(l => l.server.includes('Fast Server') || l.server.includes('G-Drive')) || finalLinks[0];
        const targetsToProcess = primaryTarget ? [primaryTarget] : [];

        for (const targetLink of targetsToProcess) {
          try {
            let currentUrl = targetLink.url;

            if (currentUrl.includes('unblockedgames') || currentUrl.includes('creativeexpressions')) {
              const resolvedSid = await resolveTechUnblockedLink(currentUrl, logs);
              if (resolvedSid) currentUrl = resolvedSid;
            }

            if (currentUrl.includes('driveseed.org') || currentUrl.includes('driveseed')) {
              const { downloadOptions, size, fileName } = await resolveDriveseedLink(currentUrl, logs);
              for (const option of downloadOptions) {
                allDownloadableLinks.push({ quality: link.quality, server: targetLink.server, method: option.title, url: option.url, size, fileName });
              }
            } else {
              // Valid catch if it failed to bypass or was a direct link
              if (!currentUrl.includes('?go=')) {
                  allDownloadableLinks.push({ quality: link.quality, server: targetLink.server, method: 'Direct Link', url: currentUrl });
              }
            }
          } catch (e) {
             logs.push(`[Main] ✗ TargetLink Error (${targetLink.server}): ${e.message}`);
          }
        }
      } catch (e) {
        logs.push(`[Main] ✗ Quality Parse Error (${link.quality}): ${e.message}`);
      }
    }

    logs.push(`[Main] ✓ Finished. Total links extracted: ${allDownloadableLinks.length}`);
    return { links: allDownloadableLinks, logs };
  } catch (error) {
    logs.push(`[Main] ✗ Fatal Error: ${error.message}`);
    return { links: [], logs };
  }
}

async function handleRequest(request) {
  const url = new URL(request.url);
  let path = url.pathname || '/';

  if (path === '/' || path === '/search') {
    return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MoviesMod Enhanced Scraper</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
    .container { background: white; border-radius: 12px; padding: 40px; max-width: 1200px; margin: 0 auto; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3); }
    h1 { color: #333; margin-bottom: 10px; text-align: center; }
    .subtitle { color: #666; text-align: center; margin-bottom: 30px; font-size: 14px; }
    .search-box { display: flex; gap: 10px; margin-bottom: 30px; }
    input { flex: 1; padding: 12px 16px; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 16px; }
    button { padding: 12px 30px; background: #667eea; color: white; border: none; border-radius: 8px; cursor: pointer; }
    .two-column { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 30px; }
    @media (max-width: 768px) { .two-column { grid-template-columns: 1fr; } }
    .section { background: #f9f9f9; padding: 20px; border-radius: 8px; border: 1px solid #e0e0e0; }
    .section-title { font-weight: 600; color: #667eea; margin-bottom: 15px; font-size: 14px; text-transform: uppercase; }
    .result-item { background: white; padding: 12px; border-radius: 6px; margin-bottom: 10px; border-left: 3px solid #667eea; word-break: break-word; }
    .result-title { font-weight: 600; color: #333; margin-bottom: 6px; font-size: 13px; }
    .result-url { font-size: 11px; color: #666; font-family: monospace; background: #f0f0f0; padding: 6px; border-radius: 4px; margin-bottom: 6px; display: block; overflow-x: auto; }
    .copy-btn { font-size: 10px; padding: 4px 12px; background: #e0e0e0; color: #333; border: none; border-radius: 4px; cursor: pointer; }
    .loading { text-align: center; color: #666; padding: 20px; }
    .error { background: #fee; color: #c33; padding: 15px; border-radius: 8px; border-left: 4px solid #c33; margin-top: 20px; }
    .empty { text-align: center; color: #999; padding: 30px 20px; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎬 MoviesMod Enhanced Scraper</h1>
    <p class="subtitle">Search & Extract Direct Download Links (Targeted Quality + Anti-Bot Bypass)</p>
    
    <div class="search-box">
      <input type="text" id="searchInput" placeholder="Search movie or series..." onkeypress="if(event.key==='Enter') search()" autofocus>
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

      document.getElementById('alert').style.display = 'none';
      document.getElementById('pageResults').innerHTML = '<div class="loading">Searching movies...</div>';
      document.getElementById('downloadResults').innerHTML = '';
      document.getElementById('debugLogs').innerHTML = '<div class="loading">Awaiting trace logs...</div>';

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
            <button class="copy-btn" onclick="copyText('\${r.url}')">Copy URL</button>
          </div>
        \`).join('');

        document.getElementById('downloadResults').innerHTML = '<div class="loading">Bypassing Safelink (takes 10-15 seconds)...</div>';
        
        const firstResult = pageData.results[0];
        const linksResponse = await fetch(\`/extract-links?url=\${encodeURIComponent(firstResult.url)}\`);
        const linksData = await linksResponse.json();

        if (linksData.logs) {
          document.getElementById('debugLogs').innerHTML = linksData.logs.map(log => {
             const isErr = log.includes('✗');
             const isPass = log.includes('✓') || log.includes('⚠️');
             const color = isErr ? '#c33' : isPass ? '#2a9d8f' : '#444';
             return \`<div style="color: \${color}; border-bottom: 1px solid #eee; padding-bottom: 2px; margin-bottom: 4px;">\${log}</div>\`;
          }).join('');
        }

        if (!linksData.links || linksData.links.length === 0) {
          document.getElementById('downloadResults').innerHTML = '<div class="empty">No downloadable links found</div>';
          return;
        }

        const grouped = {};
        linksData.links.forEach(link => {
          if (!grouped[link.quality]) grouped[link.quality] = [];
          grouped[link.quality].push(link);
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
      } catch (error) {
        document.getElementById('alert').textContent = \`Error: \${error.message}\`;
        document.getElementById('alert').style.display = 'block';
      }
    }

    function copyText(text) {
      navigator.clipboard.writeText(text);
      alert('Copied to clipboard!');
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
    if (!query) return new Response(JSON.stringify({ results: [] }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

    try {
      const results = await searchMoviesMod(query);
      return new Response(JSON.stringify({ results: results.slice(0, 10) }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    } catch (error) {
      return new Response(JSON.stringify({ results: [], error: error.message }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }
  }

  if (path === '/extract-links') {
    const pageUrl = url.searchParams.get('url');
    if (!pageUrl) return new Response(JSON.stringify({ links: [], logs: ['✗ No URL provided'] }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

    try {
      const result = await extractAllDownloadableLinks(pageUrl);
      return new Response(JSON.stringify({ links: result.links, logs: result.logs }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    } catch (error) {
      return new Response(JSON.stringify({ links: [], logs: [`✗ Fatal error: ${error.message}`] }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }
  }

  return new Response('Not Found', { status: 404 });
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

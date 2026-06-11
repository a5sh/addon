const MANIFEST = {
  id: 'moviesmod.addon',
  version: '0.4.0',
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
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          ...options.headers,
        },
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

  while (maxRedirects > 0) {
    const headers = new Headers(options.headers || {});
    if (cookieMap.size > 0) {
      headers.set('Cookie', Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join('; '));
    }

    const res = await fetch(currentUrl, {
      ...options,
      headers,
      redirect: 'manual', // Prevent native fetch from dropping intermediate Set-Cookie headers
      cache: 'no-store'
    });

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
        const k = pair.slice(0, splitIndex).trim();
        const v = pair.slice(splitIndex + 1).trim();
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
        const k = pair.slice(0, splitIndex).trim();
        const v = pair.slice(splitIndex + 1).trim();
        if (k) cookieMap.set(k, v);
      }
    }

    // 3. Follow Redirect Manually
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      let location = res.headers.get('location');
      if (location) {
        if (location.startsWith('/')) location = new URL(location, currentUrl).href;
        else location = new URL(location).href;
        currentUrl = location;
        
        // POST to GET transition on 302
        if (res.status !== 307 && res.status !== 308) {
          options.method = 'GET';
          delete options.body;
          if (options.headers) {
             const newHeaders = { ...options.headers };
             delete newHeaders['Content-Type'];
             delete newHeaders['Origin'];
             options.headers = newHeaders;
          }
        }
        maxRedirects--;
        continue;
      }
    }

    return { response: res, url: currentUrl, html, cookieMap };
  }
  throw new Error("Too many redirects");
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
    logs.push(`[Extract] ✗ Error extracting download links: ${error.message}`);
    return [];
  }
}

// Complete Safelink Bypass resolving Sub-Page Redirections and strict Referers
async function resolveTechUnblockedLink(sidUrl, logs) {
  logs.push(`[SID] Resolving payload for: ${sidUrl}`);
  const { origin } = new URL(sidUrl);
  const cookieMap = new Map();
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  try {
    // Step 1: Initial Load (Follows any 302 to root automatically)
    let step1 = await fetchWithCookies(sidUrl, {
      method: 'GET',
      headers: { 'User-Agent': userAgent, 'Upgrade-Insecure-Requests': '1' }
    }, cookieMap);

    let wp_http = getMatch(step1.html, /name=["']_wp_http["']\s+value=["']([^"']+)["']/i) || getMatch(step1.html, /value=["']([^"']+)["']\s+name=["']_wp_http["']/i);
    let action1 = getMatch(step1.html, /<form[^>]+action=["']([^"']+)["']/i);
    
    if (!wp_http || !action1) {
      logs.push(`[SID] ✗ Missing initial token. Map size: ${cookieMap.size}`);
      return null;
    }
    const action1Url = new URL(action1, step1.url).href;

    // Step 2: POST to root (Follows 302 redirecting to sub-page automatically)
    const formData1 = new URLSearchParams({ '_wp_http': wp_http });
    let step2 = await fetchWithCookies(action1Url, {
      method: 'POST',
      headers: { 
        'User-Agent': userAgent, 
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': step1.url,
        'Origin': origin
      },
      body: formData1.toString()
    }, cookieMap);

    // After step2 fetches, it will land exactly on the sub-page.
    logs.push(`[SID] Successfully landed on Sub-Page: ${step2.url}`);

    let wp_http2 = getMatch(step2.html, /name=["']_wp_http2["']\s+value=["']([^"']+)["']/i) || getMatch(step2.html, /value=["']([^"']+)["']\s+name=["']_wp_http2["']/i);
    let token = getMatch(step2.html, /name=["']token["']\s+value=["']([^"']+)["']/i) || getMatch(step2.html, /value=["']([^"']+)["']\s+name=["']token["']/i);
    let action2 = getMatch(step2.html, /<form[^>]+action=["']([^"']+)["']/i);

    if (!wp_http2 || !token || !action2) {
      logs.push(`[SID] ✗ Missing secondary tokens on Sub-Page.`);
      return null;
    }
    const action2Url = new URL(action2, step2.url).href;

    // Step 3: POST tokens from sub-page to generate ?go link
    const formData2 = new URLSearchParams({ '_wp_http2': wp_http2, token });
    let step3 = await fetchWithCookies(action2Url, {
      method: 'POST',
      headers: { 
        'User-Agent': userAgent, 
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': step2.url,
        'Origin': origin
      },
      body: formData2.toString()
    }, cookieMap);
    
    let matchUrl = getMatch(step3.html, /setAttribute\("href",\s*"([^"]+)"\)/);
    if (!matchUrl) {
      matchUrl = getMatch(step3.html, /window\.location\.replace\("([^"]+)"\)/);
      if(!matchUrl) {
         logs.push(`[SID] ✗ No jump link generated in payload.`);
         return null;
      }
    }
    
    const intermediateUrl = new URL(matchUrl, step3.url).href;
    logs.push(`[SID] Final ?go URL: ${intermediateUrl}. Waiting 8s...`);

    // Force 8s delay to completely bypass Double-Click Velocity Server Traps
    await new Promise(r => setTimeout(r, 8000));

    // Step 4: Access ?go link FROM the sub-page (Step 3 URL) utilizing the filled Cookie Map
    let step4 = await fetchWithCookies(intermediateUrl, {
      method: 'GET',
      headers: { 
        'User-Agent': userAgent, 
        'Referer': step3.url, // CRITICAL: Referer explicitly set to the sub-page
        'Upgrade-Insecure-Requests': '1'
      }
    }, cookieMap);

    let finalUrl = step4.url;

    // If fetchWithCookies failed to follow via header, parse inline JavaScript replacement
    if (finalUrl === intermediateUrl || finalUrl.includes('?go=')) {
      if (step4.html.includes("Bad Request")) {
        logs.push(`[SID] ✗ Bad Request. Session failed. Map size: ${cookieMap.size}`);
        return null;
      }
      const jsRedirectMatch = getMatch(step4.html, /window\.location(?:\.replace|\.href)?\s*(?:\(\s*|=\s*)["']([^"']+)["']/i);
      if (jsRedirectMatch) finalUrl = new URL(jsRedirectMatch, intermediateUrl).href;
    }

    logs.push(`[SID] ✓ Redirected securely to DriveSeed: ${finalUrl}`);
    return finalUrl;
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
      const seasonMatch = quality.match(/Season\s+(\d+)/i);
      const targetQuality = getMatch(quality, /(1080p|720p|480p|2160p)/i, 1)?.toLowerCase() || '';
      
      let match;
      while ((match = linkRegex.exec(html)) !== null) {
        const link = match[1];
        const text = stripTags(match[2]).toLowerCase();
        
        if (link.includes('episodes.modpro') || link.includes('cinematickit')) {
          if (!episodePageLink) episodePageLink = link; 
          if (seasonMatch && targetQuality) {
            const seasonId = seasonMatch[0].toLowerCase();
            const headerRegex = new RegExp(seasonId + '[^<]*', 'i');
            if (text.includes(targetQuality) && html.match(headerRegex)) {
              episodePageLink = link;
              break;
            }
          }
        }
      }

      if (episodePageLink) return await resolveIntermediateLink(episodePageLink, initialUrl, quality, logs);
    } else if (urlObject.hostname.includes('episodes.modpro.blog') || urlObject.hostname.includes('cinematickit.org')) {
      const response = await fetchWithRetry(initialUrl, { headers: { 'Referer': refererUrl } });
      const html = await response.text();

      const finalLinks = [];
      let match;
      while ((match = linkRegex.exec(html)) !== null) {
        const link = match[1];
        if (link.includes('driveseed')) finalLinks.push({ server: stripTags(match[2]) || 'Driveseed', url: link });
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
      return finalLinks;
    }
    return [];
  } catch (error) {
    logs.push(`[Intermediate] ✗ Error: ${error.message}`);
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
      logs.push(`[Driveseed] Following inner JS redirect to ${finalUrl}`);
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
    
    if (downloadLinks.length === 0) {
      logs.push(`[Main] ✗ No initial download links found`);
      return { links: [], logs };
    }

    const allDownloadableLinks = [];

    // LIMIT TO EXACTLY 1 QUALITY to guarantee the wait timeout completes before Cloudflare drops the worker
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

            if (currentUrl.includes('urlflix')) {
              logs.push(`[URLFlix] Resolving bypass for: ${currentUrl}`);
              let step = await fetchWithCookies(currentUrl, { method: 'GET' }, new Map());
              const ufJsMatch = getMatch(step.html, /window\.location(?:\.replace)?\s*\+?=\s*["']([^"']+)["']/i);
              currentUrl = ufJsMatch ? new URL(ufJsMatch, step.url).href : step.url;
              logs.push(`[URLFlix] ✓ Link followed to: ${currentUrl}`);
            }

            if (currentUrl.includes('driveseed.org') || currentUrl.includes('driveseed')) {
              const { downloadOptions, size, fileName } = await resolveDriveseedLink(currentUrl, logs);
              
              for (const option of downloadOptions) {
                allDownloadableLinks.push({ quality: link.quality, server: targetLink.server, method: option.title, url: option.url, size, fileName });
              }
            } else {
              allDownloadableLinks.push({ quality: link.quality, server: targetLink.server, method: 'Direct Link', url: currentUrl });
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
    <p class="subtitle">Search & Extract Direct Download Links (Custom Cookie Engine)</p>
    
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

        document.getElementById('downloadResults').innerHTML = '<div class="loading">Bypassing Safelink using Cookie Engine (takes 10-15 seconds)...</div>';
        
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

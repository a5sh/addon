const MANIFEST = {
  id: 'moviesmod.addon',
  version: '0.3.3',
  name: 'MoviesMod',
  description: 'Extracts HTTP streams from MoviesMod (Stateful Cookies & Redirect Follow)',
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
      
      if (response.status === 403 || response.status === 429) {
        throw new Error(`Blocked: HTTP ${response.status}`);
      }
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.message.includes('Blocked')) throw error;
      if (attempt === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}

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
          links.push({
            quality: quality,
            url: url.startsWith('http') ? url : `${MOVIESMOD_BASE}${url}`,
          });
          logs.push(`[Extract] ✓ Captured link for quality: ${quality}`);
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

async function resolveTechUnblockedLink(sidUrl, logs) {
  logs.push(`[TechUnblocked] Resolving payload for: ${sidUrl}`);
  const { origin } = new URL(sidUrl);

  const cookieMap = new Map();
  // Pre-seed a PHP session ID
  cookieMap.set('PHPSESSID', Math.random().toString(36).substring(2, 15));

  function buildCookieHeader() {
    return Array.from(cookieMap.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  function extractCookies(res) {
    try {
      let headerCookies = [];
      if (typeof res.headers.getSetCookie === 'function') {
        headerCookies = res.headers.getSetCookie();
      } else {
        const sc = res.headers.get('set-cookie');
        if (sc) headerCookies = sc.split(/,(?=\s*[A-Za-z0-9_-]+\s*=)/);
      }
      if (Array.isArray(headerCookies)) {
        headerCookies.forEach(c => {
          const pair = c.split(';')[0].trim();
          const idx = pair.indexOf('=');
          if (idx !== -1) {
            const k = pair.slice(0, idx).trim();
            const v = pair.slice(idx + 1).trim();
            if (k && !['path','expires','domain','samesite','secure','httponly','max-age'].includes(k.toLowerCase())) {
              cookieMap.set(k, v);
            }
          }
        });
      }
      logs.push(`[TechUnblocked] Cookies after extract: ${Array.from(cookieMap.keys()).join(', ')}`);
    } catch (e) {
      logs.push(`[TechUnblocked] Cookie parse warning: ${e.message}`);
    }
  }

  async function doFetch(url, opts = {}) {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Upgrade-Insecure-Requests': '1',
      ...(opts.headers || {}),
    };
    if (cookieMap.size > 0) {
      headers['Cookie'] = buildCookieHeader();
    }
    return await fetchWithRetry(url, { ...opts, headers, redirect: 'manual' });
  }

  try {
    // -------------------------------------------------
    // STEP 1: Initial landing — submit #landing form
    // -------------------------------------------------
    logs.push(`[TechUnblocked] Step 1 — Loading SID page`);
    let resp = await doFetch(sidUrl);
    let html = await resp.text();
    extractCookies(resp);
    
    // Find the #landing form and POST it
    const landingAction = getMatch(html, /<form[^>]+id=["']landing["'][^>]*action=["']([^"']+)["']/i)
                       || getMatch(html, /<form[^>]+action=["']([^"']+)["'][^>]*id=["']landing["']/i);
    const wpHttp = getMatch(html, /name=["']_wp_http["']\s+value=["']([^"']+)["']/i);

    if (!landingAction || !wpHttp) {
      logs.push(`[TechUnblocked] ✗ Could not find landing form or _wp_http token`);
      return null;
    }

    logs.push(`[TechUnblocked] Submitting #landing form to: ${landingAction}`);
    const landingUrl = new URL(landingAction, origin).href;
    resp = await doFetch(landingUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': sidUrl },
      body: new URLSearchParams({ '_wp_http': wpHttp }).toString(),
    });
    html = await resp.text();
    extractCookies(resp);

    // -------------------------------------------------
    // STEP 2: Click #verify_button
    // -------------------------------------------------
    logs.push(`[TechUnblocked] Step 2 — Looking for #verify_button`);

    const verifyAction = getMatch(html, /<form[^>]+id=["']verify["'][^>]*action=["']([^"']+)["']/i)
                       || getMatch(html, /<form[^>]+action=["']([^"']+)["'][^>]*id=["']verify["']/i);
    const wpHttp2 = getMatch(html, /name=["']_wp_http2["']\s+value=["']([^"']+)["']/i);
    const token = getMatch(html, /name=["']token["']\s+value=["']([^"']+)["']/i);

    if (!verifyAction || !wpHttp2 || !token) {
      logs.push(`[TechUnblocked] Could not find verify form / tokens`);
      return null;
    }

    logs.push(`[TechUnblocked] Submitting verify form to: ${verifyAction}`);
    const verifyUrl = new URL(verifyAction, origin).href;
    resp = await doFetch(verifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': landingUrl },
      body: new URLSearchParams({ '_wp_http2': wpHttp2, token }).toString(),
    });
    html = await resp.text();
    extractCookies(resp);

    // -------------------------------------------------
    // STEP 3: Read #two_steps_btn href (the ?go= link)
    // -------------------------------------------------
    logs.push(`[TechUnblocked] Step 3 — Looking for #two_steps_btn href`);

    // The href may be injected by JS, but sometimes it's embedded in the HTML
    let goUrl = getMatch(html, /<a[^>]+id=["']two_steps_btn["'][^>]+href=["']([^"']+)["']/i)
             || getMatch(html, /id=["']two_steps_btn["'][^>]+href=["']([^"']+)["']/i)
             || getMatch(html, /<a[^>]+id=["']two_steps_btn["']/i); // Check if element exists

    if (!goUrl || goUrl === '' || html.includes('id="two_steps_btn"')) {
      // The href might be empty and populated via JS; try to find the go URL embedded in the page
      logs.push(`[TechUnblocked] #two_steps_btn href empty or not found, searching JS for go URL`);
      
      // Look for the ?go= link in inline JS or data attributes
      goUrl = getMatch(html, /setAttribute\("href",\s*"([^"]+\?go=[^"]+)"\)/i)
           || getMatch(html, /href\s*=\s*"([^"]+\?go=[^"]+)"[^>]*id="two_steps_btn"/i)
           || getMatch(html, /"([^"]+\?go=[^"]+)"[^>]*id="two_steps_btn"/i)
           || getMatch(html, /data-href\s*=\s*"([^"]+\?go=[^"]+)"[^>]*id="two_steps_btn"/i);
      
      // If still nothing, try to find ANY ?go= link on the page
      if (!goUrl) {
        goUrl = getMatch(html, /\?go=([a-zA-Z0-9-]+)/);
        if (goUrl) {
          goUrl = origin + '/?go=' + goUrl;
        }
      }

      if (!goUrl) {
        logs.push(`[TechUnblocked] ✗ Could not extract go URL`);
        return null;
      }
    }

    const fullGoUrl = goUrl.startsWith('http') ? goUrl : new URL(goUrl, origin).href;
    logs.push(`[TechUnblocked] ✓ Go URL extracted: ${fullGoUrl}`);

    // -------------------------------------------------
    // STEP 4: Follow the ?go= redirect to driveseed
    // -------------------------------------------------
    logs.push(`[TechUnblocked] Step 4 — Following go URL to final destination`);
    
    const goResp = await doFetch(fullGoUrl, { redirect: 'follow' });
    let finalUrl = goResp.url;

    // If we landed back on unblockedgames (JS redirect), try to find the real destination
    if (finalUrl.includes('unblockedgames') && !finalUrl.includes('driveseed')) {
      const goHtml = await goResp.text();
      const jsRedirect = getMatch(goHtml, /window\.location(?:\.replace|\.href)?\s*(?:\(\s*|=\s*)["']([^"']+)["']/i)
                      || getMatch(goHtml, /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?[^"']*url=([^"']+)["']?/i);
      if (jsRedirect) {
        finalUrl = new URL(jsRedirect, finalUrl).href;
      } else {
        logs.push(`[TechUnblocked] No redirect found after go URL`);
        return null;
      }
    }

    logs.push(`[TechUnblocked] ✓ Final destination: ${finalUrl}`);
    return finalUrl;
  } catch (error) {
    logs.push(`[TechUnblocked] ✗ Exception: ${error.message}`);
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

      if (episodePageLink) {
        return await resolveIntermediateLink(episodePageLink, initialUrl, quality, logs);
      }
    } else if (urlObject.hostname.includes('episodes.modpro.blog') || urlObject.hostname.includes('cinematickit.org')) {
      const response = await fetchWithRetry(initialUrl, { headers: { 'Referer': refererUrl } });
      const html = await response.text();

      const finalLinks = [];
      let match;
      while ((match = linkRegex.exec(html)) !== null) {
        const link = match[1];
        if (link.includes('driveseed')) {
          finalLinks.push({ server: stripTags(match[2]) || 'Driveseed', url: link });
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
        
        if (url && (url.includes('driveseed') || url.includes('drive') || url.includes('cloud') || url.includes('unblockedgames') || url.includes('urlflix'))) {
          if (!text.toLowerCase().includes('comment')) {
            finalLinks.push({ server: text || 'Direct Link', url });
          }
        }
      }
      
      logs.push(`[ModRefer] Found ${finalLinks.length} routing links for ${quality}`);
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

    // Check if Driveseed wrapped the page in a JS redirect, otherwise parse the raw page body
    const redirectMatch = getMatch(finalHtml, /window\.location(?:\.replace|\.href)?\s*(?:\(\s*|=\s*)["']([^"']+)["']/i);
    if (redirectMatch) {
      const finalUrl = redirectMatch.startsWith('http') ? redirectMatch : `https://driveseed.org${redirectMatch.startsWith('/') ? '' : '/'}${redirectMatch}`;
      logs.push(`[Driveseed] Following inner JS redirect to ${finalUrl}`);
      const finalResponse = await fetchWithRetry(finalUrl);
      finalHtml = await finalResponse.text();
    } else {
      logs.push(`[Driveseed] No inner redirect found, parsing root Driveseed body.`);
    }

    const downloadOptions = [];
    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = linkRegex.exec(finalHtml)) !== null) {
      const href = match[1];
      const text = stripTags(match[2]).toLowerCase();

      if (href.includes('instant') || href.includes('video-seed')) {
        if (text.includes('instant')) {
          downloadOptions.push({ title: 'Instant Download', type: 'instant', url: href, priority: 1 });
        }
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

    // STRICT: Limit to 1 Quality, 1 Target to bypass execution timeouts entirely during tests
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
              const ufRes = await fetchWithRetry(currentUrl, {}, 2);
              const ufHtml = await ufRes.text();
              const ufJsMatch = getMatch(ufHtml, /window\.location(?:\.replace)?\s*\+?=\s*["']([^"']+)["']/i);
              currentUrl = ufJsMatch ? new URL(ufJsMatch, ufRes.url).href : ufRes.url;
              logs.push(`[URLFlix] ✓ Link followed to: ${currentUrl}`);
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
    <p class="subtitle">Search & Extract Direct Download Links</p>
    
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

        document.getElementById('downloadResults').innerHTML = '<div class="loading">Bypassing Tokens & Timers (approx ~12 seconds)...</div>';
        
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

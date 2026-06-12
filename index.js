const MANIFEST = {
  id: 'moviesmod.addon',
  version: '0.5.0',
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

// Target quality for extraction. Change this to retarget (e.g. '720p', '2160p').
const TARGET_QUALITY = '1080p';

// SID anti-bot wait. Old flow used a hardcoded 10s "velocity trap" delay.
// We try with NO wait first (cookie-jar fix may be sufficient); if the final
// hop returns "Bad Request", we retry once with a short wait.
const SID_RETRY_WAIT_MS = 4000;

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

// ================================================================================
// Real Cookie Jar
// ================================================================================
class SimpleCookieJar {
  constructor() {
    this.store = new Map();
  }

  _domainKey(url) {
    return new URL(url).hostname;
  }

  setFromResponse(response, url) {
    let setCookies = [];
    if (typeof response.headers.getSetCookie === 'function') {
      setCookies = response.headers.getSetCookie();
    } else {
      const sc = response.headers.get('set-cookie');
      if (sc) setCookies = sc.split(/,(?=\s*[A-Za-z0-9_-]+\s*=)/);
    }

    const domain = this._domainKey(url);
    if (!this.store.has(domain)) this.store.set(domain, new Map());
    const domainCookies = this.store.get(domain);

    for (const c of setCookies) {
      if (!c) continue;
      const pair = c.split(';')[0].trim();
      const splitIndex = pair.indexOf('=');
      if (splitIndex !== -1) {
        const k = pair.substring(0, splitIndex).trim();
        const v = pair.substring(splitIndex + 1).trim();
        if (k) domainCookies.set(k, v);
      }
    }
  }

  setFromHtml(html, url) {
    const domain = this._domainKey(url);
    if (!this.store.has(domain)) this.store.set(domain, new Map());
    const domainCookies = this.store.get(domain);

    const jsRegex = /document\.cookie\s*=\s*(['"`])([^`'"]+)\1/gi;
    let match;
    while ((match = jsRegex.exec(html)) !== null) {
      const pair = match[2].split(';')[0].trim();
      const splitIndex = pair.indexOf('=');
      if (splitIndex !== -1) {
        const k = pair.substring(0, splitIndex).trim();
        const v = pair.substring(splitIndex + 1).trim();
        if (k) domainCookies.set(k, v);
      }
    }
  }

  setCookie(name, value, url) {
    const domain = this._domainKey(url);
    if (!this.store.has(domain)) this.store.set(domain, new Map());
    this.store.get(domain).set(name, value);
  }

  getCookieHeader(url) {
    const domain = this._domainKey(url);
    const domainCookies = this.store.get(domain);
    if (!domainCookies || domainCookies.size === 0) return '';
    return Array.from(domainCookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  describe() {
    const parts = [];
    for (const [domain, cookies] of this.store.entries()) {
      parts.push(`${domain}: ${Array.from(cookies.keys()).join(', ')}`);
    }
    return parts.join(' | ');
  }
}

// Fetch through the jar: attaches Cookie header from jar, stores Set-Cookie + JS cookies back into jar.
async function jarFetch(url, options = {}, jar, refererOverride = null) {
  let currentUrl = url;
  let currentReferer = refererOverride;
  let maxRedirects = 5;
  let html = '';
  let finalRes = null;
  let finalUrl = url;

  while (maxRedirects > 0) {
    const headers = new Headers(options.headers || {});
    headers.set('User-Agent', USER_AGENT);

    const cookieHeader = jar.getCookieHeader(currentUrl);
    if (cookieHeader) headers.set('Cookie', cookieHeader);
    if (currentReferer) headers.set('Referer', currentReferer);

    const res = await fetch(currentUrl, {
      method: options.method || 'GET',
      headers,
      body: options.body,
      redirect: 'manual',
      cache: 'no-store',
    });

    finalRes = res;
    html = await res.text();
    finalUrl = currentUrl;

    jar.setFromResponse(res, currentUrl);
    jar.setFromHtml(html, currentUrl);

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      let location = res.headers.get('location');
      if (location) {
        location = new URL(location, currentUrl).href;

        let nextOptions = { ...options };
        if (res.status === 302 || res.status === 303) {
          nextOptions.method = 'GET';
          delete nextOptions.body;
        }

        currentReferer = currentUrl;
        currentUrl = location;
        options = nextOptions;
        maxRedirects--;
        continue;
      }
    }
    break;
  }
  return { response: finalRes, url: finalUrl, html, jar };
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

// ================================================================================
// SID Resolution
// ================================================================================
async function resolveTechUnblockedLink(sidUrl, logs, waitMs = 0) {
  logs.push(`[SID] Resolving payload for: ${sidUrl}`);
  const { origin } = new URL(sidUrl);
  const jar = new SimpleCookieJar();

  try {
    // Step 0: Initial Load
    let step0 = await jarFetch(sidUrl, { method: 'GET' }, jar);

    let wp_http = getMatch(step0.html, /name=["']_wp_http["']\s+value=["']([^"']+)["']/i)
                || getMatch(step0.html, /value=["']([^"']+)["']\s+name=["']_wp_http["']/i);
    let action0 = getMatch(step0.html, /<form[^>]+action=["']([^"']+)["']/i) || step0.url;

    if (!wp_http) {
      logs.push(`[SID] ✗ Missing initial token (_wp_http). Snippet: ${step0.html.replace(/\s+/g, ' ').substring(0, 150)}`);
      return null;
    }

    const action0Url = new URL(action0, step0.url).href;
    logs.push(`[SID] Step 0 OK. Cookies: ${jar.describe()}`);

    // Step 1: POST _wp_http to action0
    let step1 = await jarFetch(action0Url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ '_wp_http': wp_http }).toString(),
    }, jar, sidUrl);

    let html2 = step1.html;
    let currentUrl = step1.url;

    let bridgeMatch = getMatch(html2, /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?[0-9]+;\s*url=([^"']+)["']?/i)
                   || getMatch(html2, /window\.location(?:\.replace|\.href)?\s*(?:\(\s*|=\s*)["']([^"']+)["']/i);

    if (bridgeMatch) {
      const bridgeUrl = new URL(bridgeMatch, currentUrl).href;
      if (bridgeUrl !== currentUrl) {
        logs.push(`[SID] Following bridge redirect to: ${bridgeUrl}`);
        const stepBridge = await jarFetch(bridgeUrl, { method: 'GET' }, jar, currentUrl);
        currentUrl = stepBridge.url;
        html2 = stepBridge.html;
      }
    }

    logs.push(`[SID] Landed on verification page: ${currentUrl}`);

    let wp_http2 = getMatch(html2, /name=["']_wp_http2["']\s+value=["']([^"']+)["']/i)
                 || getMatch(html2, /value=["']([^"']+)["']\s+name=["']_wp_http2["']/i);
    let token = getMatch(html2, /name=["']token["']\s+value=["']([^"']+)["']/i)
              || getMatch(html2, /value=["']([^"']+)["']\s+name=["']token["']/i);
    let action1 = getMatch(html2, /<form[^>]+action=["']([^"']+)["']/i) || currentUrl;

    if (!wp_http2) {
      logs.push(`[SID] ✗ Missing secondary token (_wp_http2). Snippet: ${html2.replace(/\s+/g, ' ').substring(0, 150)}`);
      return null;
    }

    const action1Url = new URL(action1, currentUrl).href;

    // Step 2: POST _wp_http2 + token
    let step2 = await jarFetch(action1Url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ '_wp_http2': wp_http2, token: token || '' }).toString(),
    }, jar, currentUrl);

    const scriptContent = step2.html;

    const cookieMatch = scriptContent.match(/s_343\('([^']+)',\s*'([^']+)'/);
    let linkMatchVal = getMatch(scriptContent, /c\.setAttribute\("href",\s*"([^"]+)"\)/)
                    || getMatch(scriptContent, /href=["']([^"']*\?go=[^"']+)["']/i)
                    || getMatch(scriptContent, /window\.open\(['"]([^'"]*\?go=[^'"]+)['"]/);

    if (cookieMatch) {
      const cookieName = cookieMatch[1].trim();
      const cookieValue = cookieMatch[2].trim();
      jar.setCookie(cookieName, cookieValue, origin);
      logs.push(`[SID] Set dynamic cookie: ${cookieName}`);
    }

    if (!linkMatchVal) {
      logs.push(`[SID] ✗ No dynamic link found in step 2 response. Snippet: ${scriptContent.replace(/\s+/g, ' ').substring(0, 180)}`);
      return null;
    }

    const goUrl = new URL(linkMatchVal, step2.url).href;
    logs.push(`[SID] Final ?go URL: ${goUrl}`);

    if (waitMs > 0) {
      logs.push(`[SID] Waiting ${waitMs}ms before final hop...`);
      await new Promise(r => setTimeout(r, waitMs));
    }

    // Step 3: Access ?go link
    let step3 = await jarFetch(goUrl, {
      method: 'GET',
      headers: { 'Upgrade-Insecure-Requests': '1' },
    }, jar, step2.url);

    let finalUrl = step3.url;
    let finalHtml = step3.html;

    if (finalUrl === goUrl || finalUrl.includes('?go=')) {
      if (finalHtml.includes('Bad Request') || finalHtml.includes('Generate Link Again')) {
        logs.push(`[SID] ✗ Target returned Bad Request on final hop (waitMs=${waitMs}).`);
        return { badRequest: true };
      }

      let dsMatch = finalHtml.match(/(https?:\/\/(?:www\.)?driveseed\.org\/[^\s'"]+)/i);
      if (dsMatch) {
        logs.push(`[SID] Extracted DriveSeed from raw body directly.`);
        finalUrl = dsMatch[1];
      } else {
        let goRedirect = getMatch(finalHtml, /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?[0-9]+;\s*url=([^"']+)["']?/i)
                       || getMatch(finalHtml, /window\.location(?:\.replace|\.href)?\s*(?:\(\s*|=\s*)["']([^"']+)["']/i);

        if (goRedirect) {
          const redirectUrl = new URL(goRedirect, goUrl).href;
          logs.push(`[SID] Following redirect from ?go page to: ${redirectUrl}`);
          const step4 = await jarFetch(redirectUrl, { method: 'GET' }, jar, goUrl);
          finalUrl = step4.url;
          finalHtml = step4.html;

          if (finalUrl.includes('?go=') || finalHtml.includes('Bad Request') || finalHtml.includes('Generate Link Again')) {
            logs.push(`[SID] ✗ Redirect target failed/looped.`);
            return { badRequest: true };
          }

          dsMatch = finalHtml.match(/(https?:\/\/(?:www\.)?driveseed\.org\/[^\s'"]+)/i);
          if (dsMatch) finalUrl = dsMatch[1];
        } else {
          logs.push(`[SID] ✗ ?go page produced no recognizable redirect. Snippet: ${finalHtml.replace(/\s+/g, ' ').substring(0, 180)}`);
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

// Wrapper that tries with no wait, then retries once with a short wait if a "Bad Request"
// anti-bot response is hit. Avoids the old blanket 10s delay on every single request.
async function resolveTechUnblockedLinkSmart(sidUrl, logs) {
  let result = await resolveTechUnblockedLink(sidUrl, logs, 0);
  if (result && result.badRequest) {
    logs.push(`[SID] Retrying with ${SID_RETRY_WAIT_MS}ms wait...`);
    result = await resolveTechUnblockedLink(sidUrl, logs, SID_RETRY_WAIT_MS);
  }
  if (result && result.badRequest) return null;
  return result;
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

      if (href.includes('instant') || href.includes('video-seed') || href.includes('video-gen')) {
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

// ================================================================================
// Final hop resolution: Instant Download links resolve to an intermediate host
// (e.g. instant.video-gen.xyz/<token>::<id>) which redirects to
// https://video-seed.dev/?url=<encoded gdrive url> (or similar *.dev/*.xyz host).
// We follow that redirect and extract the `url` query parameter directly,
// returning the raw googleusercontent.com link as the final playable URL.
// ================================================================================
async function resolveFinalVideoUrl(instantUrl, logs) {
  try {
    logs.push(`[Final] Resolving instant link: ${instantUrl}`);

    let response = await fetch(instantUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT },
    });

    let location = response.headers.get('location');
    let finalUrl = instantUrl;

    let hops = 0;
    let currentUrl = instantUrl;
    while (location && hops < 5) {
      const resolvedLocation = new URL(location, currentUrl).href;
      logs.push(`[Final] Redirect ${hops + 1}: ${resolvedLocation}`);

      try {
        const u = new URL(resolvedLocation);
        const embeddedUrl = u.searchParams.get('url');
        if (embeddedUrl && embeddedUrl.includes('googleusercontent.com')) {
          const decoded = decodeURIComponent(embeddedUrl);
          logs.push(`[Final] ✓ Extracted Google Drive URL from redirect param.`);
          return decoded;
        }
      } catch (_) { /* not a valid URL with searchParams, continue */ }

      currentUrl = resolvedLocation;
      response = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'User-Agent': USER_AGENT, 'Referer': instantUrl },
      });
      location = response.headers.get('location');
      finalUrl = currentUrl;
      hops++;
    }

    try {
      const u = new URL(finalUrl);
      const embeddedUrl = u.searchParams.get('url');
      if (embeddedUrl && embeddedUrl.includes('googleusercontent.com')) {
        const decoded = decodeURIComponent(embeddedUrl);
        logs.push(`[Final] ✓ Extracted Google Drive URL from final URL param.`);
        return decoded;
      }
    } catch (_) {}

    try {
      const bodyRes = await fetchWithRetry(finalUrl, { headers: { 'Referer': instantUrl } });
      const html = await bodyRes.text();
      const gMatch = html.match(/https?:\/\/[^\s'"]*googleusercontent\.com[^\s'"]*/i);
      if (gMatch) {
        logs.push(`[Final] ✓ Extracted Google Drive URL from page body.`);
        return gMatch[0];
      }
    } catch (e) {
      logs.push(`[Final] Body scan failed: ${e.message}`);
    }

    logs.push(`[Final] ✗ Could not extract Google Drive URL. Returning intermediate URL.`);
    return finalUrl;
  } catch (error) {
    logs.push(`[Final] ✗ Exception: ${error.message}`);
    return instantUrl;
  }
}

async function extractAllDownloadableLinks(moviePageUrl) {
  const logs = [];
  logs.push(`[Main] Getting all downloadable links from: ${moviePageUrl}`);
  try {
    const downloadLinks = await extractDownloadLinks(moviePageUrl, logs);
    if (downloadLinks.length === 0) return { links: [], logs };

    // Filter for target quality only (e.g. 1080p)
    const targetLinks = downloadLinks.filter(l => l.quality.toLowerCase().includes(TARGET_QUALITY.toLowerCase()));
    const linksToProcess = targetLinks.length > 0 ? targetLinks.slice(0, 1) : [];

    if (linksToProcess.length === 0) {
      logs.push(`[Main] ✗ No "${TARGET_QUALITY}" quality link found. Available: ${downloadLinks.map(l => l.quality).join(', ')}`);
      return { links: [], logs };
    }

    const allDownloadableLinks = [];

    for (const link of linksToProcess) {
      try {
        logs.push(`[Main] Evaluating quality layer: ${link.quality}`);
        const finalLinks = await resolveIntermediateLink(link.url, moviePageUrl, link.quality, logs);

        const primaryTarget = finalLinks.find(l => l.server.includes('Fast Server') || l.server.includes('G-Drive')) || finalLinks[0];
        const targetsToProcess = primaryTarget ? [primaryTarget] : [];

        for (const targetLink of targetsToProcess) {
          try {
            let currentUrl = targetLink.url;

            if (currentUrl.includes('unblockedgames') || currentUrl.includes('creativeexpressions')) {
              const resolvedSid = await resolveTechUnblockedLinkSmart(currentUrl, logs);
              if (resolvedSid) currentUrl = resolvedSid;
            }

            if (currentUrl.includes('driveseed.org') || currentUrl.includes('driveseed')) {
              const { downloadOptions, size, fileName } = await resolveDriveseedLink(currentUrl, logs);
              for (const option of downloadOptions) {
                let finalUrl = option.url;

                // Resolve Instant Download links through to the final googleusercontent URL
                if (option.type === 'instant') {
                  finalUrl = await resolveFinalVideoUrl(option.url, logs);
                }

                allDownloadableLinks.push({ quality: link.quality, server: targetLink.server, method: option.title, url: finalUrl, size, fileName });
              }
            } else {
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
  <title>MoviesMod Extractor</title>
  <style>
    :root {
      --bg: #0f1117;
      --panel: #171a23;
      --panel-2: #1d2230;
      --border: #2a2f3f;
      --accent: #7c8cff;
      --accent-2: #9b6cff;
      --text: #e6e8f0;
      --muted: #8b93a7;
      --good: #4ade80;
      --bad: #f87171;
      --warn: #fbbf24;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: radial-gradient(circle at top left, #1a1d2b 0%, var(--bg) 60%);
      color: var(--text);
      min-height: 100vh;
      padding: 24px;
    }
    .container { max-width: 1100px; margin: 0 auto; }
    header { text-align: center; margin-bottom: 28px; }
    header h1 {
      font-size: 28px;
      font-weight: 700;
      letter-spacing: -0.02em;
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
      display: inline-flex;
      align-items: center;
      gap: 10px;
    }
    header p { color: var(--muted); margin-top: 6px; font-size: 13px; }
    .badge {
      display: inline-block;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(124, 140, 255, 0.15);
      color: var(--accent);
      border: 1px solid rgba(124, 140, 255, 0.3);
      margin-top: 8px;
    }
    .search-box {
      display: flex;
      gap: 10px;
      margin-bottom: 24px;
      background: var(--panel);
      padding: 8px;
      border-radius: 14px;
      border: 1px solid var(--border);
    }
    input {
      flex: 1;
      padding: 12px 16px;
      border: none;
      border-radius: 10px;
      font-size: 15px;
      background: var(--panel-2);
      color: var(--text);
      outline: none;
    }
    input::placeholder { color: var(--muted); }
    input:focus { box-shadow: 0 0 0 2px var(--accent); }
    button.search-btn {
      padding: 12px 26px;
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      color: #fff;
      border: none;
      border-radius: 10px;
      cursor: pointer;
      font-weight: 600;
      font-size: 14px;
      transition: opacity 0.15s, transform 0.1s;
    }
    button.search-btn:hover { opacity: 0.9; }
    button.search-btn:active { transform: scale(0.98); }
    button.search-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    @media (max-width: 820px) { .grid { grid-template-columns: 1fr; } }

    .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 18px;
    }
    .panel-title {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--accent);
      margin-bottom: 14px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .result-item {
      background: var(--panel-2);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px;
      margin-bottom: 10px;
    }
    .result-title { font-weight: 600; font-size: 13.5px; margin-bottom: 8px; line-height: 1.4; }
    .result-meta { font-size: 12px; color: var(--muted); margin-bottom: 6px; line-height: 1.5; }
    .result-url {
      font-size: 11.5px;
      color: var(--muted);
      font-family: 'JetBrains Mono', 'SF Mono', monospace;
      background: rgba(0,0,0,0.25);
      padding: 8px 10px;
      border-radius: 8px;
      margin-bottom: 8px;
      display: block;
      overflow-x: auto;
      white-space: nowrap;
      border: 1px solid var(--border);
    }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .pill-btn {
      font-size: 12px;
      font-weight: 600;
      padding: 6px 14px;
      background: rgba(124, 140, 255, 0.12);
      color: var(--accent);
      border: 1px solid rgba(124, 140, 255, 0.3);
      border-radius: 999px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .pill-btn:hover { background: rgba(124, 140, 255, 0.22); }
    .pill-btn.primary {
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      color: #fff;
      border: none;
    }
    .quality-tag {
      display: inline-block;
      font-size: 11px;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 6px;
      background: rgba(155, 108, 255, 0.18);
      color: var(--accent-2);
      border: 1px solid rgba(155, 108, 255, 0.35);
      margin-bottom: 8px;
    }

    .loading {
      text-align: center;
      color: var(--muted);
      padding: 30px 10px;
      font-size: 13px;
    }
    .spinner {
      display: inline-block;
      width: 16px; height: 16px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
      margin-right: 8px;
      vertical-align: middle;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .error {
      background: rgba(248, 113, 113, 0.1);
      color: var(--bad);
      padding: 14px 16px;
      border-radius: 10px;
      border: 1px solid rgba(248, 113, 113, 0.3);
      margin-bottom: 18px;
      font-size: 13px;
    }
    .empty { text-align: center; color: var(--muted); padding: 30px 10px; font-size: 13px; }

    .debug-panel { margin-top: 18px; }
    .debug-log {
      font-family: 'JetBrains Mono', 'SF Mono', monospace;
      font-size: 11.5px;
      background: rgba(0,0,0,0.3);
      padding: 14px;
      border-radius: 10px;
      border: 1px solid var(--border);
      max-height: 320px;
      overflow-y: auto;
      line-height: 1.7;
      color: var(--muted);
    }
    .debug-log div { padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,0.03); white-space: pre-wrap; word-break: break-all; }
    .log-err { color: var(--bad); }
    .log-ok { color: var(--good); }
    .log-warn { color: var(--warn); }

    .toast {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: var(--panel-2);
      color: var(--text);
      padding: 10px 20px;
      border-radius: 999px;
      border: 1px solid var(--border);
      font-size: 13px;
      opacity: 0;
      transition: opacity 0.2s, transform 0.2s;
      pointer-events: none;
      z-index: 100;
    }
    .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🎬 MoviesMod Extractor</h1>
      <p>Search &amp; resolve direct streaming links with anti-bot bypass</p>
      <div class="badge">Target quality: ${TARGET_QUALITY}</div>
    </header>

    <div class="search-box">
      <input type="text" id="searchInput" placeholder="Search movie or series..." onkeypress="if(event.key==='Enter') search()" autofocus>
      <button class="search-btn" id="searchBtn" onclick="search()">Search</button>
    </div>

    <div id="alert"></div>

    <div class="grid">
      <div class="panel">
        <div class="panel-title">📽️ Movie Pages</div>
        <div id="pageResults" class="empty">Search to see results</div>
      </div>

      <div class="panel">
        <div class="panel-title">🔗 Final Links</div>
        <div id="downloadResults" class="empty">Links appear here</div>
      </div>
    </div>

    <div class="panel debug-panel">
      <div class="panel-title">🐛 Debug Logs</div>
      <div id="debugLogs" class="debug-log">Awaiting action...</div>
    </div>
  </div>

  <div class="toast" id="toast">Copied to clipboard!</div>

  <script>
    async function search() {
      const query = document.getElementById('searchInput').value.trim();
      if (!query) return;

      const btn = document.getElementById('searchBtn');
      btn.disabled = true;
      btn.textContent = 'Searching...';

      document.getElementById('alert').innerHTML = '';
      document.getElementById('pageResults').innerHTML = '<div class="loading"><span class="spinner"></span>Searching movies...</div>';
      document.getElementById('downloadResults').innerHTML = '<div class="empty">Links appear here</div>';
      document.getElementById('debugLogs').innerHTML = 'Awaiting trace logs...';

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
            <div class="actions">
              <button class="pill-btn" onclick="copyText('\${r.url}')">Copy URL</button>
            </div>
          </div>
        \`).join('');

        document.getElementById('downloadResults').innerHTML = '<div class="loading"><span class="spinner"></span>Bypassing safelink &amp; resolving final link...</div>';

        const firstResult = pageData.results[0];
        const linksResponse = await fetch(\`/extract-links?url=\${encodeURIComponent(firstResult.url)}\`);
        const linksData = await linksResponse.json();

        if (linksData.logs) {
          document.getElementById('debugLogs').innerHTML = linksData.logs.map(log => {
             const isErr = log.includes('✗');
             const isPass = log.includes('✓');
             const isWarn = log.includes('⚠️');
             let cls = '';
             if (isErr) cls = 'log-err';
             else if (isPass) cls = 'log-ok';
             else if (isWarn) cls = 'log-warn';
             return \`<div class="\${cls}">\${log}</div>\`;
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
          html += \`<div class="quality-tag">\${quality}</div>\`;
          grouped[quality].forEach(link => {
            html += \`<div class="result-item">
              <div class="result-meta">
                📌 \${link.method}\${link.server ? ' • ' + link.server : ''}
                \${link.fileName ? '<br/>📁 ' + link.fileName : ''}
                \${link.size ? '<br/>📊 ' + link.size : ''}
              </div>
              <span class="result-url">\${link.url}</span>
              <div class="actions">
                <button class="pill-btn primary" onclick="window.open('\${link.url}', '_blank')">Open</button>
                <button class="pill-btn" onclick="copyText('\${link.url}')">Copy</button>
              </div>
            </div>\`;
          });
        });

        document.getElementById('downloadResults').innerHTML = html;
      } catch (error) {
        document.getElementById('alert').innerHTML = \`<div class="error">Error: \${error.message}</div>\`;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Search';
      }
    }

    function copyText(text) {
      navigator.clipboard.writeText(text);
      const toast = document.getElementById('toast');
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 1500);
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

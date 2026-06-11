const MANIFEST = {
  id: 'moviesmod.addon',
  version: '0.4.0',
  name: 'MoviesMod',
  description: 'Extracts HTTP streams from MoviesMod (Multi-Provider Resolution)',
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

// ---------- COOKIE JAR ----------
class CookieJar {
  constructor() { this.cookies = new Map(); }

  extract(res) {
    try {
      let cookies = [];
      if (typeof res.headers.getSetCookie === 'function') {
        cookies = res.headers.getSetCookie();
      } else {
        const sc = res.headers.get('set-cookie');
        if (sc) cookies = sc.split(/,(?=\s*[A-Za-z0-9_-]+\s*=)/);
      }
      for (const c of cookies) {
        const pair = c.split(';')[0].trim();
        const idx = pair.indexOf('=');
        if (idx !== -1) {
          const k = pair.slice(0, idx).trim();
          const v = pair.slice(idx + 1).trim();
          if (k && !['path','expires','domain','samesite','secure','httponly','max-age'].includes(k.toLowerCase())) {
            this.cookies.set(k, v);
          }
        }
      }
    } catch (e) {}
  }

  get header() {
    if (this.cookies.size === 0) return '';
    return Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  clone() {
    const jar = new CookieJar();
    for (const [k, v] of this.cookies) jar.cookies.set(k, v);
    return jar;
  }
}

// ---------- FETCH WITH COOKIE JAR ----------
async function sjFetch(url, opts = {}, jar = new CookieJar()) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Upgrade-Insecure-Requests': '1',
    ...opts.headers,
  };
  const ch = jar.header;
  if (ch) headers['Cookie'] = ch;
  const resp = await fetchWithRetry(url, { ...opts, headers, redirect: 'manual' });
  jar.extract(resp);
  return resp;
}

// ---------- SEARCH ----------
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

// ---------- DOWNLOAD LINK EXTRACTION (from movie page) ----------
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
          links.push({
            quality,
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

// ---------- INTERMEDIATE LINK RESOLVER ----------
async function resolveIntermediateLink(initialUrl, refererUrl, quality, logs) {
  try {
    const urlObject = new URL(initialUrl);
    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    // ---------- DRAMADRIP (episodes page) ----------
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
    }

    // ---------- EPISODES.MODPRO / CINEMATICKIT ----------
    else if (urlObject.hostname.includes('episodes.modpro.blog') || urlObject.hostname.includes('cinematickit.org')) {
      const response = await fetchWithRetry(initialUrl, { headers: { 'Referer': refererUrl } });
      const html = await response.text();
      const finalLinks = [];
      let match;
      while ((match = linkRegex.exec(html)) !== null) {
        const link = match[1];
        if (link.includes('driveseed') || link.includes('driveleech') ||
            link.includes('video-seed') || link.includes('worker') ||
            link.includes('resume') || link.includes('instant') ||
            link.includes('cdn.') || link.includes('seed')) {
          finalLinks.push({ server: stripTags(match[2]) || 'Direct', url: link, type: 'direct' });
        } else if (link.includes('modrefer') || link.includes('links.modpro') || link.includes('cloud')) {
          finalLinks.push({ server: stripTags(match[2]) || 'SID', url: link, type: 'sid' });
        }
      }
      if (finalLinks.length > 0) return finalLinks;
    }

    // ---------- MODREFER.IN / LINKS.MODPRO.BLOG ----------
    else if (urlObject.hostname.includes('modrefer.in') || urlObject.hostname.includes('links.modpro.blog')) {
      const response = await fetchWithRetry(initialUrl, { headers: { 'Referer': refererUrl } });
      const html = await response.text();
      const finalLinks = [];
      let match;
      while ((match = linkRegex.exec(html)) !== null) {
        const url = match[1];
        const text = stripTags(match[2]);
        if (!url || text.toLowerCase().includes('comment') || text.toLowerCase().includes('report')) continue;

        // Direct download hosts — no verification needed
        if (url.includes('driveseed.org/r?') || url.includes('driveseed.org/file/') ||
            url.includes('driveseed.org/zfile/') || url.includes('driveleech.org/') ||
            url.includes('video-seed.') || url.includes('workerseed.') ||
            url.includes('seedtg.') || url.includes('instant.') ||
            url.includes('cdn.video-gen') || url.includes('resume')) {
          finalLinks.push({ server: text || 'Direct', url, type: 'direct', priority: 1 });
        }
        // Google Drive
        else if (url.includes('drive.google.com') || text.toLowerCase().includes('google drive') || text.toLowerCase().includes('g-drive')) {
          finalLinks.push({ server: text || 'GDrive', url, type: 'direct', priority: 2 });
        }
        // SID-based (needs cloud.unblockedgames)
        else if (url.includes('cloud.') || url.includes('unblockedgames') ||
                 url.includes('tech.sharpcornerr') || url.includes('examdegree') ||
                 url.includes('creativeexpressions') || url.includes('tech.')) {
          finalLinks.push({ server: text || 'Fast Server', url, type: 'sid', priority: 3 });
        }
        // Other (urlflix, etc)
        else if (url.includes('urlflix')) {
          finalLinks.push({ server: text || 'URLFlix', url, type: 'urlflix', priority: 4 });
        }
      }
      // Sort: direct first, then sid, then others
      finalLinks.sort((a, b) => (a.priority || 99) - (b.priority || 99));
      logs.push(`[ModRefer] Found ${finalLinks.length} links: ` +
        `${finalLinks.filter(l => l.type === 'direct').length} direct, ` +
        `${finalLinks.filter(l => l.type === 'sid').length} SID`);
      return finalLinks;
    }

    return [];
  } catch (error) {
    logs.push(`[Intermediate] ✗ Error: ${error.message}`);
    return [];
  }
}

// ---------- SID RESOLUTION (cloud.unblockedgames.world) ----------
// Uses a cookie jar + proper redirect chain to follow the SID -> go -> driveseed flow
async function resolveSidLink(sidUrl, logs) {
  logs.push(`[SID] Resolving: ${sidUrl}`);
  const origin = new URL(sidUrl).origin;
  const jar = new CookieJar();

  try {
    // Step 1: Navigate to SID page — wait, don't navigate directly
    // The SID is consumed on first GET. Instead, POST the landing form directly.
    // But first we need the _wp_http token.
    
    // Load the page to get initial cookies + tokens
    logs.push(`[SID] Step 1 — Loading page for cookies + tokens`);
    let resp = await sjFetch(sidUrl, {}, jar);
    let html = await resp.text();
    
    // If we got redirected to homepage, SID is already consumed
    if (!html.includes('#landing') && !html.includes('verify')) {
      logs.push(`[SID] ⚠ SID consumed or expired, page redirected to homepage`);
      // Try to extract go URL from whatever we got
      const goUrl = getMatch(html, /["']([^"']*\?go=[a-zA-Z0-9-]+)["']/i);
      if (goUrl) {
        logs.push(`[SID] Found go URL in redirect response: ${goUrl}`);
        return goUrl;
      }
      return null;
    }

    // Step 2: Submit #landing form
    let action = getMatch(html, /<form[^>]+action=["']([^"']+)["']/i);
    let wpHttp = getMatch(html, /name=["']_wp_http["'][^>]*value=["']([^"']+)["']/i);
    
    if (!action || !wpHttp) {
      // Maybe JS has already populated? Check the DOM more carefully
      wpHttp = getMatch(html, /value=["']([^"']+)["'][^>]*name=["']_wp_http["']/i);
      if (!wpHttp) {
        logs.push(`[SID] ✗ No landing form or _wp_http found`);
        return null;
      }
    }
    
    const landingUrl = new URL(action, origin).href;
    logs.push(`[SID] Step 2 — Submitting #landing form to: ${landingUrl}`);
    resp = await sjFetch(landingUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': sidUrl },
      body: new URLSearchParams({ '_wp_http': wpHttp }).toString(),
    }, jar);
    html = await resp.text();

    // Step 3: Submit #verify form  
    let action2 = getMatch(html, /<form[^>]+action=["']([^"']+)["']/i);
    let wpHttp2 = getMatch(html, /name=["']_wp_http2["'][^>]*value=["']([^"']+)["']/i)
               || getMatch(html, /value=["']([^"']+)["'][^>]*name=["']_wp_http2["']/i);
    let token = getMatch(html, /name=["']token["'][^>]*value=["']([^"']+)["']/i)
             || getMatch(html, /value=["']([^"']+)["'][^>]*name=["']token["']/i);
    
    if (action2 && wpHttp2 && token) {
      const verifyUrl = new URL(action2, origin).href;
      logs.push(`[SID] Step 3 — Submitting verify form to: ${verifyUrl}`);
      resp = await sjFetch(verifyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': landingUrl },
        body: new URLSearchParams({ '_wp_http2': wpHttp2, token }).toString(),
      }, jar);
      html = await resp.text();
      
      // Step 4: Extract #two_steps_btn href (the go URL)
      let goHref = getMatch(html, /id=["']two_steps_btn["'][^>]+href=["']([^"']+)["']/i);
      if (!goHref) {
        // Check if it's populated via setAttribute
        goHref = getMatch(html, /setAttribute\(["']href["'],\s*["']([^"']+)["']\)/i);
      }
      if (!goHref) {
        // Look for any go URL
        goHref = getMatch(html, /\?go=([a-zA-Z0-9-]+)/);
        if (goHref) goHref = `${origin}/?go=${goHref}`;
      }

      if (goHref) {
        const fullGoUrl = goHref.startsWith('http') ? goHref : new URL(goHref, origin).href;
        logs.push(`[SID] Step 4 — Following go URL: ${fullGoUrl}`);
        
        // Follow the go URL — this should redirect to driveseed.org/r?key=...&id=...
        resp = await sjFetch(fullGoUrl, { headers: { 'Referer': verifyUrl } }, jar);
        
        // Check if we got redirected
        if (resp.url && resp.url.includes('driveseed.org')) {
          logs.push(`[SID] ✓ Driveseed: ${resp.url}`);
          return resp.url;
        }
        
        // Check if the redirect was JS-based (need to extract from body)
        const body = await resp.text();
        const jsRedirect = getMatch(body, /window\.location(?:\.replace|\.href)?\s*(?:\(\s*|=\s*)["']([^"']+)["']/i);
        if (jsRedirect) {
          const finalUrl = new URL(jsRedirect, fullGoUrl).href;
          logs.push(`[SID] ✓ JS redirect to: ${finalUrl}`);
          return finalUrl;
        }
        
        // Check if driveseed URL is somewhere in the body
        const dlMatch = getMatch(body, /(https?:\/\/driveseed\.org\/[^\s"']+)/i);
        if (dlMatch) {
          logs.push(`[SID] ✓ Found driveseed URL: ${dlMatch}`);
          return dlMatch;
        }
        
        logs.push(`[SID] ⚠ go URL consumed but no driveseed found`);
        return null;
      }
    }

    logs.push(`[SID] ✗ Failed to resolve SID chain`);
    return null;

  } catch (error) {
    logs.push(`[SID] ✗ Exception: ${error.message}`);
    return null;
  }
}

// ---------- URLFLIX RESOLUTION ----------
async function resolveUrlFlix(url, logs) {
  logs.push(`[URLFlix] Resolving: ${url}`);
  try {
    const res = await fetchWithRetry(url, {}, 2);
    const html = await res.text();
    const jsMatch = getMatch(html, /window\.location(?:\.replace)?\s*\+?=\s*["']([^"']+)["']/i);
    return jsMatch ? new URL(jsMatch, res.url).href : res.url;
  } catch (e) {
    logs.push(`[URLFlix] ✗ ${e.message}`);
    return url;
  }
}

// ---------- DRIVESEED LINK PARSING ----------
async function resolveDriveseedLink(driveseedUrl, logs) {
  try {
    logs.push(`[Driveseed] Resolving: ${driveseedUrl}`);
    const response = await fetchWithRetry(driveseedUrl);
    const finalUrl = response.url; // May have been redirected from /r? to /file/
    let finalHtml = await response.text();

    // Check for JS redirect
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
    logs.push(`[Driveseed] ✓ ${downloadOptions.length} download options for: ${fileName || finalUrl}`);
    return { downloadOptions, size, fileName };
  } catch (error) {
    logs.push(`[Driveseed] ✗ Error: ${error.message}`);
    return { downloadOptions: [], size: null, fileName: null };
  }
}

// ---------- MAIN EXTRACTOR ----------
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

    // Process each quality (up to 2 to stay within timeout)
    for (const link of downloadLinks.slice(0, 2)) {
      try {
        logs.push(`[Main] Processing quality: ${link.quality}`);
        const finalLinks = await resolveIntermediateLink(link.url, moviePageUrl, link.quality, logs);
        
        // Pick the best target: direct > sid > other
        const directTarget = finalLinks.find(l => l.type === 'direct');
        const sidTarget = finalLinks.find(l => l.type === 'sid');
        const bestTarget = directTarget || sidTarget || finalLinks[0];
        
        if (!bestTarget) {
          logs.push(`[Main] ⚠ No targets for ${link.quality}`);
          continue;
        }

        const targetsToProcess = [bestTarget];
        logs.push(`[Main] Using target: ${bestTarget.server} (${bestTarget.type})`);

        for (const targetLink of targetsToProcess) {
          try {
            let currentUrl = targetLink.url;

            // SID resolution
            if (targetLink.type === 'sid') {
              const resolved = await resolveSidLink(currentUrl, logs);
              if (resolved) {
                currentUrl = resolved;
                logs.push(`[Main] SID resolved to: ${currentUrl}`);
              } else {
                logs.push(`[Main] ⚠ SID resolution failed for ${targetLink.server}`);
                continue;
              }
            }

            // URLFlix resolution
            if (currentUrl.includes('urlflix')) {
              currentUrl = await resolveUrlFlix(currentUrl, logs);
            }

            // Driveseed and direct download hosts
            if (currentUrl.includes('driveseed.org') || currentUrl.includes('driveleech.org')) {
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
            } else if (currentUrl.includes('video-seed') || currentUrl.includes('worker') || currentUrl.includes('cdn.')) {
              // Direct download link
              allDownloadableLinks.push({
                quality: link.quality,
                server: targetLink.server,
                method: 'Direct Link',
                url: currentUrl,
              });
            } else {
              // Fallback: just store the URL
              allDownloadableLinks.push({
                quality: link.quality,
                server: targetLink.server,
                method: 'Direct Link',
                url: currentUrl,
              });
            }
          } catch (e) {
            logs.push(`[Main] ✗ Target error (${targetLink.server}): ${e.message}`);
          }
        }
      } catch (e) {
        logs.push(`[Main] ✗ Quality error (${link.quality}): ${e.message}`);
      }
    }

    logs.push(`[Main] ✓ Done. Total links: ${allDownloadableLinks.length}`);
    return { links: allDownloadableLinks, logs };
  } catch (error) {
    logs.push(`[Main] ✗ Fatal: ${error.message}`);
    return { links: [], logs };
  }
}

// ---------- HTTP HANDLER ----------
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

async function handleRequest(request) {
  const url = new URL(request.url);
  let path = url.pathname || '/';

  // ---- UI PAGE ----
  if (path === '/' || path === '/search') {
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
    .loading { text-align: center; color: #666; padding: 20px; }
    .error { background: #fee; color: #c33; padding: 15px; border-radius: 8px; border-left: 4px solid #c33; margin-top: 20px; }
    .empty { text-align: center; color: #999; padding: 30px 20px; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎬 MoviesMod Scraper</h1>
    <p class="subtitle">Search & Extract Direct Download Links</p>
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
  </div>
  <script>
    async function search() {
      const query = document.getElementById('searchInput').value.trim();
      if (!query) return;
      document.getElementById('alert').style.display = 'none';
      document.getElementById('pageResults').innerHTML = '<div class="loading">Searching...</div>';
      document.getElementById('downloadResults').innerHTML = '';
      document.getElementById('debugLogs').innerHTML = '<div class="loading">Waiting...</div>';
      try {
        const pageResponse = await fetch(\`/search-api?q=\${encodeURIComponent(query)}\`);
        const pageData = await pageResponse.json();
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
        document.getElementById('downloadResults').innerHTML = '<div class="loading">Processing (may take ~15s)...</div>';
        const firstResult = pageData.results[0];
        const linksResponse = await fetch(\`/extract-links?url=\${encodeURIComponent(firstResult.url)}\`);
        const linksData = await linksResponse.json();
        if (linksData.logs) {
          document.getElementById('debugLogs').innerHTML = linksData.logs.map(log => {
            const isErr = log.includes('✗');
            const isPass = log.includes('✓') || log.includes('✔');
            const isWarn = log.includes('⚠');
            const color = isErr ? '#c33' : isPass ? '#2a9d8f' : isWarn ? '#e9c46a' : '#444';
            return \`<div style="color: \${color}; border-bottom: 1px solid #eee; padding-bottom: 2px; margin-bottom: 4px;">\${log}</div>\`;
          }).join('');
        }
        if (!linksData.links || linksData.links.length === 0) {
          document.getElementById('downloadResults').innerHTML = '<div class="empty">No links found</div>';
          return;
        }
        const grouped = {};
        linksData.links.forEach(l => {
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
      } catch (error) {
        document.getElementById('alert').textContent = \`Error: \${error.message}\`;
        document.getElementById('alert').style.display = 'block';
      }
    }
    function copyText(text) { navigator.clipboard.writeText(text); alert('Copied!'); }
  </script>
</body>
</html>`, { headers: { 'Content-Type': 'text/html' } });
  }

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

  // ---- EXTRACT LINKS API ----
  if (path === '/extract-links') {
    const pageUrl = url.searchParams.get('url');
    if (!pageUrl) return new Response(JSON.stringify({ links: [], logs: ['✗ No URL'] }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    try {
      const result = await extractAllDownloadableLinks(pageUrl);
      return new Response(JSON.stringify({ links: result.links, logs: result.logs }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    } catch (error) {
      return new Response(JSON.stringify({ links: [], logs: [`✗ Fatal: ${error.message}`] }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
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

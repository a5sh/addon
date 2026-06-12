import puppeteer from "@cloudflare/puppeteer";

const MANIFEST = {
  id: 'moviesmod.addon',
  version: '0.7.0',
  name: 'MoviesMod',
  description: 'Extracts HTTP streams using Cloudflare Headless Chromium',
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
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
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

async function extractDownloadLinks(moviePageUrl, logger) {
  try {
    await logger(`[Extract] Fetching movie page: ${moviePageUrl}`);
    const response = await fetchWithRetry(moviePageUrl);
    const html = await response.text();

    const links = [];
    const contentMatch = html.match(/class=["'][^"']*thecontent[^"']*["'][^>]*>([\s\S]*?)(?:<div class="post-navigation"|<h4 class="total-comments"|<\/article>|<div id="comments")/i);
    if (!contentMatch) {
      await logger('[Extract] ✗ No .thecontent div found');
      return links;
    }

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
    await logger(`[Extract] Found ${links.length} download links`);
    return links;
  } catch (error) {
    await logger(`[Extract] ✗ Error extracting download links: ${error.message}`);
    return [];
  }
}

// Use Puppeteer to follow the ?go= redirect and reach Driveseed
async function followGoRedirect(goUrl, env, logger) {
  await logger(`[GoRedirect] Following ?go= redirect via Puppeteer: ${goUrl.substring(0, 60)}...`);
  
  if (!env.MYBROWSER) {
    await logger(`[GoRedirect] ✗ Browser binding not found`);
    return null;
  }

  let browser;
  try {
    browser = await puppeteer.launch(env.MYBROWSER, { protocolTimeout: 100000 });
    const page = await browser.newPage();

    // Block heavy resources
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const rt = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(rt)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(goUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    
    // Wait for navigation or get current URL
    await new Promise(r => setTimeout(r, 2000));
    
    const finalUrl = page.url();
    await logger(`[GoRedirect] ✓ Landed on: ${finalUrl.substring(0, 80)}...`);

    // If it's driveseed, get the HTML
    if (finalUrl.includes('driveseed')) {
      const html = await page.content();
      await browser.close();
      return { url: finalUrl, html };
    }

    await browser.close();
    return { url: finalUrl, html: null };

  } catch (error) {
    await logger(`[GoRedirect] ✗ Error: ${error.message}`);
    if (browser) await browser.close();
    return null;
  }
}

async function resolveTechUnblockedLink(sidUrl, env, logger) {
  await logger(`[SID] Resolving via Puppeteer: ${sidUrl.substring(0, 60)}...`);
  
  if (!env.MYBROWSER) {
    await logger(`[SID] ✗ Browser binding not found`);
    return null;
  }

  let browser;
  try {
    browser = await puppeteer.launch(env.MYBROWSER, { protocolTimeout: 100000 });
    const page = await browser.newPage();
    
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const rt = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(rt)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await logger(`[SID] Navigating to SID page...`);
    await page.goto(sidUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

    // Auto-click buttons
    const domBypass = page.evaluate(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      
      for (let i = 0; i < 15; i++) {
        const elements = Array.from(document.querySelectorAll('a, button, input[type="submit"], .btn'));
        const keywords = ['start verification', 'verify to continue', 'click here to continue', 'go to download', 'continue'];
        
        for (const el of elements) {
          const text = (el.innerText || el.value || '').toLowerCase();
          const isVisible = el.offsetWidth > 0 && el.offsetHeight > 0 && window.getComputedStyle(el).display !== 'none';
          
          if (isVisible && keywords.some(k => text.includes(k))) {
            if (!text.includes('wait') && !text.includes('second')) {
              el.scrollIntoView();
              el.click();
              break; 
            }
          }
          
          if (isVisible && ['verify_button', 'generate_link', 'go_download', 'two_steps_btn'].includes(el.id)) {
            el.scrollIntoView();
            el.click();
            break;
          }
        }
        await sleep(1000);
      }
    }).catch(() => {});

    await logger(`[SID] Clicking buttons...`);
    
    // Wait for URL change or timeout
    let finalUrl = null;
    for (let i = 0; i < 18; i++) {
      const currentUrl = page.url();
      if (currentUrl.includes('?go=') || currentUrl.includes('driveseed')) {
        finalUrl = currentUrl;
        break;
      }

      const htmlContent = await page.content().catch(() => '');
      const domMatch = htmlContent.match(/(https?:\/\/[^\s'"]+\?go=[^\s'"]+)/i);
      if (domMatch) {
        finalUrl = domMatch[1];
        break;
      }

      await new Promise(r => setTimeout(r, 1000));
    }

    if (finalUrl) {
      await logger(`[SID] ✓ Extracted: ${finalUrl.substring(0, 80)}...`);
      await browser.close();
      return finalUrl;
    } else {
      await logger(`[SID] ✗ Could not find URL`);
      await browser.close();
      return null;
    }
  } catch (error) {
    await logger(`[SID] ✗ Exception: ${error.message}`);
    if (browser) await browser.close();
    return null;
  }
}

async function resolveIntermediateLink(initialUrl, refererUrl, quality, logger) {
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
      if (episodePageLink) return await resolveIntermediateLink(episodePageLink, initialUrl, quality, logger);
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
      await logger(`[ModRefer] Found ${finalLinks.length} routing links.`);
      return finalLinks;
    }
    return [];
  } catch (error) {
    return [];
  }
}

async function resolveDriveseedLink(driveseedUrl, logger) {
  try {
    await logger(`[Driveseed] Resolving: ${driveseedUrl}`);
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
    await logger(`[Driveseed] ✓ Found ${downloadOptions.length} download options`);
    return { downloadOptions, size, fileName };
  } catch (error) {
    await logger(`[Driveseed] ✗ Error: ${error.message}`);
    return { downloadOptions: [], size: null, fileName: null };
  }
}

async function extractAllDownloadableLinks(moviePageUrl, env, logger) {
  await logger(`[Main] Getting all downloadable links from: ${moviePageUrl}`);
  try {
    const downloadLinks = await extractDownloadLinks(moviePageUrl, logger);
    if (downloadLinks.length === 0) {
      await logger(`[Main] ✗ No initial download links found`);
      return { links: [] };
    }

    const allDownloadableLinks = [];

    for (const link of downloadLinks.slice(0, 1)) {
      try {
        await logger(`[Main] Evaluating quality layer: ${link.quality}`);
        const finalLinks = await resolveIntermediateLink(link.url, moviePageUrl, link.quality, logger);
        
        const primaryTarget = finalLinks.find(l => l.server.includes('Fast Server') || l.server.includes('G-Drive')) || finalLinks[0];
        const targetsToProcess = primaryTarget ? [primaryTarget] : [];

        for (const targetLink of targetsToProcess) {
          try {
            let currentUrl = targetLink.url;

            // Use Puppeteer for SID resolution
            if (currentUrl.includes('unblockedgames') || currentUrl.includes('creativeexpressions')) {
              const resolvedSid = await resolveTechUnblockedLink(currentUrl, env, logger);
              if (resolvedSid) currentUrl = resolvedSid;
            }

            // Use Puppeteer for ?go= redirect following
            if (currentUrl.includes('?go=')) {
              await logger(`[Main] Following ?go= redirect with browser...`);
              const redirectResult = await followGoRedirect(currentUrl, env, logger);
              if (redirectResult) {
                currentUrl = redirectResult.url;
                // If we got HTML and it's driveseed, use it
                if (redirectResult.html && currentUrl.includes('driveseed')) {
                  const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
                  const downloadOptions = [];
                  let match;

                  while ((match = linkRegex.exec(redirectResult.html)) !== null) {
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

                  if (downloadOptions.length > 0) {
                    downloadOptions.sort((a, b) => a.priority - b.priority);
                    for (const option of downloadOptions) {
                      allDownloadableLinks.push({ quality: link.quality, server: targetLink.server, method: option.title, url: option.url, size: null, fileName: null });
                    }
                    continue;
                  }
                }
              }
            }

            // Fallback: normal fetch for driveseed
            if (currentUrl.includes('driveseed.org') || currentUrl.includes('driveseed')) {
              const { downloadOptions, size, fileName } = await resolveDriveseedLink(currentUrl, logger);
              for (const option of downloadOptions) {
                allDownloadableLinks.push({ quality: link.quality, server: targetLink.server, method: option.title, url: option.url, size, fileName });
              }
            } else {
              allDownloadableLinks.push({ quality: link.quality, server: targetLink.server, method: 'Direct Link', url: currentUrl });
            }
          } catch (e) {
             await logger(`[Main] ✗ TargetLink Error (${targetLink.server}): ${e.message}`);
          }
        }
      } catch (e) {
        await logger(`[Main] ✗ Quality Parse Error (${link.quality}): ${e.message}`);
      }
    }

    await logger(`[Main] ✓ Finished. Total links extracted: ${allDownloadableLinks.length}`);
    return { links: allDownloadableLinks };
  } catch (error) {
    await logger(`[Main] ✗ Fatal Error: ${error.message}`);
    return { links: [] };
  }
}

async function handleRequest(request, env, ctx) {
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
    let activeStream = null;

    async function search() {
      const query = document.getElementById('searchInput').value.trim();
      if (!query) return;

      if (activeStream) activeStream.close();

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

        document.getElementById('downloadResults').innerHTML = '<div class="loading">Extracting links with browser automation...</div>';
        
        const firstResult = pageData.results[0];
        const eventSource = new EventSource(\`/extract-links?url=\${encodeURIComponent(firstResult.url)}\`);
        activeStream = eventSource;

        eventSource.onmessage = function(event) {
          const data = JSON.parse(event.data);
          
          if (data.type === 'log') {
             const log = data.message;
             const isErr = log.includes('✗');
             const isPass = log.includes('✓');
             const color = isErr ? '#c33' : isPass ? '#2a9d8f' : '#444';
             const debugDiv = document.getElementById('debugLogs');
             if (debugDiv.innerHTML.includes('Awaiting trace logs...')) debugDiv.innerHTML = '';
             debugDiv.innerHTML += \`<div style="color: \${color}; border-bottom: 1px solid #eee; padding-bottom: 2px; margin-bottom: 4px;">\${log}</div>\`;
             debugDiv.scrollTop = debugDiv.scrollHeight;
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
          }
        };

        eventSource.onerror = function() {
           eventSource.close();
           document.getElementById('alert').textContent = \`Stream error. Check logs for details.\`;
           document.getElementById('alert').style.display = 'block';
        };

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
        await streamLogger(`[Main] ✗ Fatal Error: ${error.message}`);
        await writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'result', links: [] })}\n\n`));
      } finally {
        await writer.close();
      }
    })());

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  return new Response('Not Found', { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
    }

    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  },
};

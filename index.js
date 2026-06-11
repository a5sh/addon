const MANIFEST = {
  id: 'moviesmod.addon',
  version: '0.2.3',
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

// Simple string similarity (Levenshtein distance)
function stringSimilarity(str1, str2) {
  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  
  if (longer.length === 0) return 1.0;
  
  const editDistance = getEditDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

function getEditDistance(s1, s2) {
  const costs = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else if (j > 0) {
        let newValue = costs[j - 1];
        if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[s2.length] = lastValue;
  }
  return costs[s2.length];
}

// Find best matching title
function findBestMatch(query, titles) {
  let bestMatch = { title: '', rating: 0, index: -1 };
  
  titles.forEach((title, index) => {
    const rating = stringSimilarity(query, title);
    if (rating > bestMatch.rating) {
      bestMatch = { title, rating, index };
    }
  });
  
  return bestMatch;
}

// Search for content on MoviesMod
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

    const results = [];
    const linkRegex = /href=["']([^"']*?)["'][^>]*title=["']([^"']*?)["']/gi;
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
      const url = match[1];
      const title = match[2];

      if (url && title && !url.includes('javascript')) {
        const fullUrl = url.startsWith('http') ? url : `${MOVIESMOD_BASE}${url}`;
        
        if (!results.some(r => r.url === fullUrl)) {
          results.push({
            url: fullUrl,
            title: title.trim(),
            source: 'moviesmod',
          });
        }
      }
    }

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
async function extractDownloadLinks(moviePageUrl) {
  try {
    const response = await fetchWithRetry(moviePageUrl);
    const html = await response.text();

    const links = [];
    
    // Extract from thecontent div
    const contentBox = html.match(/<div[^>]*class="[^"]*thecontent[^"]*"[^>]*>([\s\S]*?)(?=<div class="post-navigation"|<h4 class="total-comments"|$)/i);
    if (!contentBox || !contentBox[1]) {
      console.log('[Extract] No thecontent div found');
      return links;
    }

    const contentHtml = contentBox[1];

    // Match h4 headers with quality info followed by download links
    const h4Regex = /<h4[^>]*>([\s\S]*?)<\/h4>\s*<p[^>]*>\s*<a[^>]*href=["']([^"']*?)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let headerMatch;

    while ((headerMatch = h4Regex.exec(contentHtml)) !== null) {
      const headerText = headerMatch[1];
      const downloadUrl = headerMatch[2];
      
      // Extract quality info from header (480p, 720p, 1080p, 10Bit, etc)
      const qualityMatch = headerText.match(/\b(480p|720p|1080p|2160p|4K)\b/i);
      const bitMatch = headerText.match(/\b(10Bit|8Bit)\b/i);
      const sizeMatch = headerText.match(/\[([0-9.]+\s*[KMGT]B)\]/);
      
      let quality = headerText.replace(/<[^>]*>/g, '').trim();
      if (quality.length > 100) {
        // If too long, extract just quality and size
        quality = '';
        if (qualityMatch) quality += qualityMatch[1];
        if (bitMatch) quality += ' ' + bitMatch[1];
        if (sizeMatch) quality += ' [' + sizeMatch[1] + ']';
        if (!quality) quality = 'Unknown';
      }

      if (downloadUrl && downloadUrl.includes('modpro') || downloadUrl.includes('links')) {
        links.push({
          quality: quality,
          url: downloadUrl.startsWith('http') ? downloadUrl : `${MOVIESMOD_BASE}${downloadUrl}`,
        });
        console.log(`[Extract] Found link - Quality: ${quality} -> ${downloadUrl.substring(0, 80)}`);
      }
    }

    console.log(`[Extract] Found ${links.length} download links`);
    return links;
  } catch (error) {
    console.error(`Error extracting download links:`, error.message);
    return [];
  }
}

// Resolve SID (tech.unblockedgames.world / cloud.unblockedgames.world) links
async function resolveTechUnblockedLink(sidUrl) {
  console.log(`[SID] Resolving: ${sidUrl.substring(0, 80)}...`);
  const { origin } = new URL(sidUrl);

  try {
    // Step 1: Get initial form
    let response = await fetchWithRetry(sidUrl);
    let html = await response.text();
    let match = html.match(/name="_wp_http"\s+value="([^"]+)"/);
    if (!match) throw new Error('Could not find _wp_http in initial form');
    const wp_http = match[1];

    match = html.match(/action="([^"]+)"/);
    if (!match) throw new Error('Could not find form action');
    const action1 = new URL(match[1], origin).href;

    // Step 2: Submit first form
    const formData1 = new URLSearchParams({ '_wp_http': wp_http });
    response = await fetchWithRetry(action1, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': sidUrl,
      },
      body: formData1.toString(),
    });

    // Step 3: Get verification form
    html = await response.text();
    match = html.match(/name="_wp_http2"\s+value="([^"]+)"/);
    if (!match) throw new Error('Could not find _wp_http2');
    const wp_http2 = match[1];

    match = html.match(/name="token"\s+value="([^"]+)"/);
    if (!match) throw new Error('Could not find token');
    const token = match[1];

    match = html.match(/action="([^"]+)"/);
    if (!match) throw new Error('Could not find verification form action');
    const action2 = new URL(match[1], origin).href;

    // Step 4: Submit verification
    const formData2 = new URLSearchParams({ '_wp_http2': wp_http2, token });
    response = await fetchWithRetry(action2, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': action1,
      },
      body: formData2.toString(),
    });

    // Step 5: Extract final URL from JavaScript
    html = await response.text();
    match = html.match(/s_343\('([^']+)',\s*'([^']+)'/);
    if (!match) throw new Error('Could not extract dynamic values from JS');
    const cookieName = match[1];
    const cookieValue = match[2];

    match = html.match(/setAttribute\("href",\s*"([^"]+)"\)/);
    if (!match) throw new Error('Could not extract final URL from JS');
    const finalPath = match[1];

    const finalUrl = new URL(finalPath, origin).href;
    console.log(`[SID] ✓ Resolved to: ${finalUrl.substring(0, 80)}...`);
    return finalUrl;
  } catch (error) {
    console.error(`[SID] ✗ Error:`, error.message);
    return null;
  }
}

// Resolve intermediate links (dramadrip, modrefer, episodes.modpro.blog)
async function resolveIntermediateLink(initialUrl, refererUrl, quality) {
  try {
    const urlObject = new URL(initialUrl);

    if (urlObject.hostname.includes('dramadrip.com')) {
      console.log(`[Dramadrip] Processing: ${initialUrl}`);
      const response = await fetchWithRetry(initialUrl, { headers: { 'Referer': refererUrl } });
      const html = await response.text();

      let episodePageLink = null;
      const seasonMatch = quality.match(/Season\s+(\d+)/i);
      
      if (seasonMatch) {
        const seasonId = seasonMatch[0].toLowerCase();
        const qualityMatch = quality.match(/(1080p|720p|480p|2160p)/i);
        const targetQuality = qualityMatch ? qualityMatch[1].toLowerCase() : '';

        const linkRegex = /<a\s+href=["']([^"']*(?:episodes\.modpro|cinematickit)[^"']*)["'][^>]*>([^<]+)<\/a>/gi;
        let match;
        while ((match = linkRegex.exec(html)) !== null) {
          const link = match[1];
          const text = match[2].toLowerCase();
          const headerMatch = html.match(new RegExp(seasonId + '[^<]*', 'i'));
          
          if (targetQuality && text.includes(targetQuality) && headerMatch) {
            episodePageLink = link;
            break;
          }
        }
      }

      if (!episodePageLink) {
        const match = html.match(/<a\s+href=["']([^"']*(?:episodes\.modpro|cinematickit)[^"']*)/i);
        episodePageLink = match ? match[1] : null;
      }

      if (episodePageLink) {
        return await resolveIntermediateLink(episodePageLink, initialUrl, quality);
      }
    } else if (urlObject.hostname.includes('episodes.modpro.blog') || urlObject.hostname.includes('cinematickit.org')) {
      console.log(`[Episodes] Processing: ${initialUrl}`);
      const response = await fetchWithRetry(initialUrl, { headers: { 'Referer': refererUrl } });
      const html = await response.text();

      const finalLinks = [];
      const linkRegex = /<a\s+href=["']([^"']*driveseed[^"']*)["'][^>]*>([^<]+)<\/a>/gi;
      let match;
      
      while ((match = linkRegex.exec(html)) !== null) {
        finalLinks.push({
          server: match[2].trim(),
          url: match[1],
        });
      }
      return finalLinks;

    } else if (urlObject.hostname.includes('modrefer.in') || urlObject.hostname.includes('links.modpro.blog')) {
      console.log(`[ModRefer] Processing: ${initialUrl}`);
      const response = await fetchWithRetry(initialUrl, { headers: { 'Referer': refererUrl } });
      const html = await response.text();

      const finalLinks = [];
      
      // Captures all content up to the closing tag across lines, bypassing nested constraints
      const linkRegex = /<a\s+href=["']([^"']+?)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      
      while ((match = linkRegex.exec(html)) !== null) {
        const url = match[1];
        // Clean out child tags like <span> or <strong> to yield pure string descriptors
        const text = match[2].replace(/<[^>]*>/g, '').trim();
        
        // Filter for actual download services (driveseed, cloud, etc)
        if (url && (url.includes('driveseed') || url.includes('drive') || url.includes('cloud'))) {
          if (!text.toLowerCase().includes('comment')) {
            finalLinks.push({ 
              server: text || 'Direct Link', 
              url 
            });
          }
        }
      }
      
      console.log(`[ModRefer] Found ${finalLinks.length} links`);
      return finalLinks;
    }

    return [];
  } catch (error) {
    console.error(`Error resolving intermediate link:`, error.message);
    return [];
  }
}

// Resolve driveseed links
async function resolveDriveseedLink(driveseedUrl) {
  try {
    console.log(`[Driveseed] Resolving: ${driveseedUrl.substring(0, 80)}...`);
    const response = await fetchWithRetry(driveseedUrl);
    const html = await response.text();

    const redirectMatch = html.match(/window\.location\.replace\("([^"]+)"\)/);
    if (!redirectMatch) {
      console.log(`[Driveseed] No redirect found`);
      return { downloadOptions: [], size: null, fileName: null };
    }

    const finalUrl = `https://driveseed.org${redirectMatch[1]}`;
    const finalResponse = await fetchWithRetry(finalUrl);
    const finalHtml = await finalResponse.text();

    const downloadOptions = [];
    
    // Extract download buttons
    const instantMatch = finalHtml.match(/<a[^>]*href=["']([^"']*(?:instant|video-seed)[^"']*)["'][^>]*>([^<]*Instant[^<]*)/i);
    if (instantMatch) {
      downloadOptions.push({
        title: 'Instant Download',
        type: 'instant',
        url: instantMatch[1],
        priority: 1,
      });
    }

    const resumeMatch = finalHtml.match(/<a[^>]*href=["']([^"']*resume[^"']*)["'][^>]*>([^<]*Resume[^<]*)/i);
    if (resumeMatch) {
      downloadOptions.push({
        title: 'Resume Cloud',
        type: 'resume',
        url: resumeMatch[1],
        priority: 2,
      });
    }

    const workerMatch = finalHtml.match(/<a[^>]*href=["']([^"']*worker[^"']*)["'][^>]*>([^<]*Worker[^<]*)/i);
    if (workerMatch) {
      downloadOptions.push({
        title: 'Resume Worker Bot',
        type: 'worker',
        url: workerMatch[1],
        priority: 3,
      });
    }

    // Extract size
    const sizeMatch = finalHtml.match(/Size\s*:\s*([0-9.,]+\s*[KMGT]B)/i);
    const size = sizeMatch ? sizeMatch[1] : null;

    // Extract filename
    const fileMatch = finalHtml.match(/Name\s*:\s*([^<]+)/i);
    const fileName = fileMatch ? fileMatch[1].trim() : null;

    downloadOptions.sort((a, b) => a.priority - b.priority);
    return { downloadOptions, size, fileName };
  } catch (error) {
    console.error(`[Driveseed] Error:`, error.message);
    return { downloadOptions: [], size: null, fileName: null };
  }
}

// Extract all downloadable links from a movie page
async function extractAllDownloadableLinks(moviePageUrl) {
  try {
    console.log(`[Extract] Getting all downloadable links from: ${moviePageUrl}`);
    const downloadLinks = await extractDownloadLinks(moviePageUrl);
    
    if (downloadLinks.length === 0) {
      console.log(`[Extract] No download links found`);
      return [];
    }

    const allDownloadableLinks = [];

    for (const link of downloadLinks.slice(0, 10)) {
      try {
        console.log(`[Extract] Processing quality: ${link.quality}`);
        
        // Skip 480p if you want (optional)
        // if (link.quality.toLowerCase().includes('480p')) {
        //   console.log(`[Extract] Skipping 480p: ${link.quality}`);
        //   continue;
        // }

        const finalLinks = await resolveIntermediateLink(link.url, moviePageUrl, link.quality);
        
        for (const targetLink of finalLinks) {
          try {
            let currentUrl = targetLink.url;

            // Handle SID links safely across subdomain transitions (tech -> cloud)
            if (currentUrl.includes('unblockedgames.world') || currentUrl.includes('tech.creativeexpressions')) {
              console.log(`[Extract] Resolving SID link...`);
              const resolvedSid = await resolveTechUnblockedLink(currentUrl);
              if (resolvedSid) {
                currentUrl = resolvedSid;
              }
            }

            // Resolve driveseed
            if (currentUrl.includes('driveseed.org')) {
              const { downloadOptions, size, fileName } = await resolveDriveseedLink(currentUrl);
              
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
              // Direct link
              allDownloadableLinks.push({
                quality: link.quality,
                server: targetLink.server,
                method: 'Direct Link',
                url: currentUrl,
              });
            }
          } catch (e) {
            console.error(`[Extract] Error with ${targetLink.server}:`, e.message);
          }
        }
      } catch (e) {
        console.error(`[Extract] Error with quality ${link.quality}:`, e.message);
      }
    }

    console.log(`[Extract] ✓ Found ${allDownloadableLinks.length} total downloadable links`);
    return allDownloadableLinks;
  } catch (error) {
    console.error(`[Extract] ✗ Error:`, error.message);
    return [];
  }
}

// Stremio stream handler
async function handleRequest(request) {
  const url = new URL(request.url);
  let path = url.pathname;
  
  if (!path || path === '') path = '/';

  // Root / search page
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
    h1 {
      color: #333;
      margin-bottom: 10px;
      text-align: center;
    }
    .subtitle {
      color: #666;
      text-align: center;
      margin-bottom: 30px;
      font-size: 14px;
    }
    .search-box {
      display: flex;
      gap: 10px;
      margin-bottom: 30px;
    }
    input {
      flex: 1;
      padding: 12px 16px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 16px;
    }
    input:focus {
      outline: none;
      border-color: #667eea;
    }
    button {
      padding: 12px 30px;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 8px;
      cursor: pointer;
    }
    button:hover {
      background: #764ba2;
    }
    .two-column {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      margin-top: 30px;
    }
    @media (max-width: 768px) {
      .two-column {
        grid-template-columns: 1fr;
      }
    }
    .section {
      background: #f9f9f9;
      padding: 20px;
      border-radius: 8px;
      border: 1px solid #e0e0e0;
    }
    .section-title {
      font-weight: 600;
      color: #667eea;
      margin-bottom: 15px;
      font-size: 14px;
      text-transform: uppercase;
    }
    .result-item {
      background: white;
      padding: 12px;
      border-radius: 6px;
      margin-bottom: 10px;
      border-left: 3px solid #667eea;
      word-break: break-word;
    }
    .result-title {
      font-weight: 600;
      color: #333;
      margin-bottom: 6px;
      font-size: 13px;
    }
    .result-url {
      font-size: 11px;
      color: #666;
      font-family: monospace;
      background: #f0f0f0;
      padding: 6px;
      border-radius: 4px;
      margin-bottom: 6px;
      display: block;
      overflow-x: auto;
    }
    .result-meta {
      font-size: 11px;
      color: #999;
      margin-top: 6px;
    }
    .copy-btn {
      font-size: 10px;
      padding: 4px 12px;
      background: #e0e0e0;
      color: #333;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    .copy-btn:hover {
      background: #d0d0d0;
    }
    .loading {
      text-align: center;
      color: #666;
      padding: 20px;
    }
    .error {
      background: #fee;
      color: #c33;
      padding: 15px;
      border-radius: 8px;
      border-left: 4px solid #c33;
      margin-top: 20px;
    }
    .empty {
      text-align: center;
      color: #999;
      padding: 30px 20px;
      font-size: 14px;
    }
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
  </div>

  <script>
    async function search() {
      const query = document.getElementById('searchInput').value.trim();
      if (!query) return;

      const pageDiv = document.getElementById('pageResults');
      const downloadDiv = document.getElementById('downloadResults');
      const alertDiv = document.getElementById('alert');
      
      alertDiv.style.display = 'none';
      pageDiv.innerHTML = '<div class="loading">Searching movies...</div>';
      downloadDiv.innerHTML = '';

      try {
        // Get movie pages
        const pageResponse = await fetch(\`/search-api?q=\${encodeURIComponent(query)}\`);
        const pageData = await pageResponse.json();

        if (!pageData.results || pageData.results.length === 0) {
          pageDiv.innerHTML = '<div class="empty">No results found</div>';
          return;
        }

        // Display movie pages
        pageDiv.innerHTML = pageData.results.map((r, i) => \`
          <div class="result-item">
            <div class="result-title">\${i + 1}. \${r.title}</div>
            <span class="result-url">\${r.url}</span>
            <button class="copy-btn" onclick="copyText('\${r.url}')">Copy URL</button>
          </div>
        \`).join('');

        // Extract download links
        downloadDiv.innerHTML = '<div class="loading">Extracting download links...</div>';
        
        const firstResult = pageData.results[0];
        const linksResponse = await fetch(\`/extract-links?url=\${encodeURIComponent(firstResult.url)}\`);
        const linksData = await linksResponse.json();

        if (!linksData.links || linksData.links.length === 0) {
          downloadDiv.innerHTML = '<div class="empty">No downloadable links found</div>';
          return;
        }

        // Group links by quality
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

  // Manifest
  if (path === '/manifest.json') {
    return new Response(JSON.stringify(MANIFEST), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  // Search API
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

  // Extract links API
  if (path === '/extract-links') {
    const pageUrl = url.searchParams.get('url');
    if (!pageUrl) {
      return new Response(JSON.stringify({ links: [] }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    try {
      const links = await extractAllDownloadableLinks(pageUrl);
      return new Response(JSON.stringify({ links }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    } catch (error) {
      console.error(`Error extracting links:`, error.message);
      return new Response(JSON.stringify({ links: [], error: error.message }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  }

  // Stremio stream endpoint
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

      // For production, would need title from TMDB API
      return new Response(JSON.stringify({ streams: [] }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    } catch (error) {
      console.error(`Stream error:`, error.message);
      return new Response(JSON.stringify({ streams: [] }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  }

  return new Response('Not Found', { status: 404 });
}

// Cloudflare Workers entry
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

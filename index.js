const MANIFEST = {
  id: 'moviesmod.addon',
  version: '0.2.1',
  name: 'MoviesMod',
  description: 'Extracts HTTP streams from MoviesMod with advanced resolution',
  types: ['movie', 'series'],
  catalogs: [],
  resources: ['stream'],
  idPrefixes: ['tt', 'tmdb:'],
  behaviorHints: {
    p2p: false,
    configurable: false,
  },
};

const MOVIESMOD_BASE = 'https://moviesmod.money';

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
    const contentBox = html.match(/<div[^>]*class="[^"]*thecontent[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (!contentBox) return links;

    // Extract quality headers and their content
    const headerRegex = /<h3[^>]*>Season\s+(\d+)([\s\S]*?)<h3|<h4[^>]*>([\s\S]*?)<h[34]/gi;
    let headerMatch;

    while ((headerMatch = headerRegex.exec(contentBox[1])) !== null) {
      const seasonNum = headerMatch[1];
      const seasonContent = headerMatch[2] || headerMatch[3];
      
      if (seasonNum) {
        // TV show
        const episodeRegex = /href=["']([^"']*?)["'][^>]*>([^<]*Episode[^<]*)</gi;
        let episodeMatch;
        while ((episodeMatch = episodeRegex.exec(seasonContent)) !== null) {
          const url = episodeMatch[1];
          const title = episodeMatch[2];
          if (url) {
            links.push({
              quality: `Season ${seasonNum} - ${title.trim()}`,
              url: url.startsWith('http') ? url : `${MOVIESMOD_BASE}${url}`,
            });
          }
        }
      } else {
        // Movie - extract quality from h4
        const qualityMatch = seasonContent.match(/^([^<]*)/);
        const quality = qualityMatch ? qualityMatch[1].trim() : 'Unknown';
        
        const urlMatch = seasonContent.match(/href=["']([^"']*modrefer[^"']*)["']/i);
        if (urlMatch && urlMatch[1]) {
          links.push({
            quality,
            url: urlMatch[1].startsWith('http') ? urlMatch[1] : `${MOVIESMOD_BASE}${urlMatch[1]}`,
          });
        }
      }
    }

    return links;
  } catch (error) {
    console.error(`Error extracting download links:`, error.message);
    return [];
  }
}

// Resolve SID (tech.unblockedgames.world) links
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

    } else if (urlObject.hostname.includes('modrefer.in')) {
      console.log(`[ModRefer] Decoding: ${initialUrl}`);
      const encodedUrl = urlObject.searchParams.get('url');
      if (!encodedUrl) return [];

      const decodedUrl = Buffer.from(encodedUrl, 'base64').toString('utf8');
      const response = await fetchWithRetry(decodedUrl, { headers: { 'Referer': refererUrl } });
      const html = await response.text();

      const finalLinks = [];
      const linkRegex = /<a\s+href=["']([^"']+?)["'][^>]*>([^<]*)<\/a>/gi;
      let match;
      
      while ((match = linkRegex.exec(html)) !== null) {
        const url = match[1];
        const text = match[2];
        if (url && text && !text.toLowerCase().includes('comment')) {
          finalLinks.push({ server: text.trim(), url });
        }
      }
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

// Resolve final download URL
async function resolveFinalDownloadUrl(downloadOption) {
  try {
    if (downloadOption.type === 'instant') {
      const response = await fetchWithRetry(downloadOption.url);
      const html = await response.text();

      // Check if it's a direct CDN link
      if (downloadOption.url.includes('workers.dev') || downloadOption.url.includes('cdn.')) {
        return downloadOption.url;
      }

      // Try API extraction for video-seed.pro
      const urlParams = new URL(downloadOption.url).searchParams;
      const keys = urlParams.get('url');
      if (keys) {
        const apiUrl = new URL(downloadOption.url).origin + '/api';
        const formData = new URLSearchParams({ keys });
        const apiResponse = await fetchWithRetry(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'x-token': new URL(downloadOption.url).hostname,
          },
          body: formData.toString(),
        });
        const result = await apiResponse.json();
        if (result && result.url) return result.url;
      }
    } else if (downloadOption.type === 'resume') {
      const response = await fetchWithRetry(downloadOption.url);
      const html = await response.text();
      
      const linkMatch = html.match(/href=["']([^"']*(?:workers\.dev|\.r2\.dev)[^"']*)["']/);
      if (linkMatch) return linkMatch[1];
    } else if (downloadOption.type === 'worker') {
      const response = await fetchWithRetry(downloadOption.url);
      const html = await response.text();

      const tokenMatch = html.match(/formData\.append\('token',\s*'([^']+)'\)/);
      const idMatch = html.match(/fetch\('\/download\?id=([^']+)',/);

      if (tokenMatch && idMatch) {
        const token = tokenMatch[1];
        const id = idMatch[1];
        const apiUrl = `${new URL(downloadOption.url).origin}/download?id=${id}`;
        const formData = new URLSearchParams({ token });
        
        const apiResponse = await fetchWithRetry(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': downloadOption.url,
          },
          body: formData.toString(),
        });
        const result = await apiResponse.json();
        if (result && result.url) return result.url;
      }
    }

    return null;
  } catch (error) {
    console.error(`Error resolving final URL:`, error.message);
    return null;
  }
}

// Extract quality from text
function parseQualityForSort(qualityString) {
  if (!qualityString) return 0;
  const match = qualityString.match(/(\d{3,4})p/i);
  return match ? parseInt(match[1], 10) : 0;
}

// Main stream extraction
async function extractStreamsFromMoviesMod(tmdbId, mediaType, seasonNum = null, episodeNum = null, title = null, year = null) {
  try {
    if (!title) throw new Error('Title is required');

    console.log(`[MoviesMod] Fetching for: ${title} (${year})`);

    // Search
    const searchResults = await searchMoviesMod(title);
    if (searchResults.length === 0) throw new Error(`No search results for "${title}"`);

    // Find best match
    const titles = searchResults.map(r => r.title);
    const bestMatch = findBestMatch(title, titles);
    
    if (bestMatch.rating < 0.3) throw new Error(`No suitable match found (best similarity: ${bestMatch.rating})`);

    const selectedResult = searchResults[bestMatch.index];
    console.log(`[MoviesMod] Selected: ${selectedResult.title} (similarity: ${bestMatch.rating.toFixed(2)})`);

    // Extract links
    const downloadLinks = await extractDownloadLinks(selectedResult.url);
    if (downloadLinks.length === 0) throw new Error('No download links found');

    // Filter and process
    let relevantLinks = downloadLinks.filter(l => !l.quality.toLowerCase().includes('480p'));
    if (mediaType === 'tv' && seasonNum !== null) {
      relevantLinks = relevantLinks.filter(l => 
        l.quality.toLowerCase().includes(`season ${seasonNum}`) ||
        l.quality.toLowerCase().includes(`s${seasonNum}`)
      );
    }

    const streams = [];
    
    for (const link of relevantLinks.slice(0, 5)) {
      try {
        const finalLinks = await resolveIntermediateLink(link.url, selectedResult.url, link.quality);
        
        for (const targetLink of finalLinks) {
          try {
            let currentUrl = targetLink.url;

            // Handle SID links
            if (currentUrl.includes('tech.unblockedgames') || currentUrl.includes('tech.creativeexpressions')) {
              currentUrl = await resolveTechUnblockedLink(currentUrl);
              if (!currentUrl) continue;
            }

            // Resolve driveseed
            if (currentUrl.includes('driveseed.org')) {
              const { downloadOptions, size, fileName } = await resolveDriveseedLink(currentUrl);
              
              for (const option of downloadOptions) {
                const finalUrl = await resolveFinalDownloadUrl(option);
                if (finalUrl) {
                  const quality = link.quality.match(/(\d{3,4})p/i)?.[1] || 'Unknown';
                  streams.push({
                    name: `MoviesMod\n${quality}p`,
                    title: `${fileName || title}\n${size || 'Unknown size'}`,
                    url: finalUrl,
                    quality,
                  });
                  break; // Use first successful download method
                }
              }
            }
          } catch (e) {
            console.error(`Error processing ${targetLink.server}:`, e.message);
          }
        }
      } catch (e) {
        console.error(`Error processing quality ${link.quality}:`, e.message);
      }
    }

    // Sort by quality
    streams.sort((a, b) => parseInt(b.quality) - parseInt(a.quality));
    console.log(`[MoviesMod] ✓ Extracted ${streams.length} streams`);
    return streams;
  } catch (error) {
    console.error(`[MoviesMod] ✗ Error:`, error.message);
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
  <title>MoviesMod Debug</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 12px;
      padding: 40px;
      max-width: 900px;
      width: 100%;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      margin: auto;
    }
    h1 {
      color: #333;
      margin-bottom: 10px;
      text-align: center;
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
    .results {
      margin-top: 30px;
    }
    .result-item {
      background: #f5f5f5;
      padding: 15px;
      border-radius: 8px;
      margin-bottom: 12px;
      border-left: 4px solid #667eea;
    }
    .result-title {
      font-weight: 600;
      color: #333;
      margin-bottom: 6px;
    }
    .result-url {
      font-size: 12px;
      color: #666;
      word-break: break-all;
      font-family: monospace;
      background: #eee;
      padding: 6px;
      border-radius: 4px;
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
      margin-top: 20px;
      border-left: 4px solid #c33;
    }
    .empty {
      text-align: center;
      color: #999;
      padding: 40px 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎬 MoviesMod Enhanced Scraper</h1>
    
    <div class="search-box">
      <input 
        type="text" 
        id="searchInput" 
        placeholder="Search movie title..." 
        onkeypress="if(event.key==='Enter') search()"
        autofocus
      >
      <button onclick="search()">Search</button>
    </div>

    <div id="alert" class="error" style="display: none;"></div>
    <div id="results" class="results"></div>
  </div>

  <script>
    async function search() {
      const query = document.getElementById('searchInput').value.trim();
      if (!query) return;

      const resultsDiv = document.getElementById('results');
      const alertDiv = document.getElementById('alert');
      
      alertDiv.style.display = 'none';
      resultsDiv.innerHTML = '<div class="loading">Searching...</div>';

      try {
        const response = await fetch(\`/search-api?q=\${encodeURIComponent(query)}\`);
        const data = await response.json();

        if (!data.results || data.results.length === 0) {
          resultsDiv.innerHTML = '<div class="empty">No results found</div>';
          return;
        }

        resultsDiv.innerHTML = data.results.map((r, i) => \`
          <div class="result-item">
            <div class="result-title">\${i + 1}. \${r.title}</div>
            <div class="result-url">\${r.url}</div>
          </div>
        \`).join('');
      } catch (error) {
        alertDiv.textContent = \`Error: \${error.message}\`;
        alertDiv.style.display = 'block';
      }
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

      // For demo purposes - would need title from TMDB API in production
      const streams = await extractStreamsFromMoviesMod(id, type, null, null, 'Movie Title', '2024');

      return new Response(JSON.stringify({ streams: streams.map(s => ({
        name: s.name,
        title: s.title,
        url: s.url,
        type: 'url',
        availability: 2,
        behaviorHints: { notWebReady: true },
      })) }), {
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

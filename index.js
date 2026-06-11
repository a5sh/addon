const MANIFEST = {
  id: 'moviesmod.addon',
  version: '0.1.0',
  name: 'MoviesMod',
  description: 'Extracts HTTP streams from MoviesMod',
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
        return response;
      } catch (error) {
        if (attempt === retries - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

async function searchMoviesMod(query) {
  try {
    const searchUrl = new URL(MOVIESMOD_BASE);
    searchUrl.pathname = '/';
    searchUrl.searchParams.set('s', query);

    const response = await fetchWithRetry(searchUrl.toString());
    const html = await response.text();

    const results = [];
    const linkRegex = /href=["']([^"']*?)["'][^>]*>([^<]*)<\/a>/gi;
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
      const url = match[1];
      const title = match[2];

      if (url && title && !url.includes('javascript')) {
        results.push({
          url: url.startsWith('http') ? url : `${MOVIESMOD_BASE}${url}`,
          title: title.trim(),
        });
      }
    }

    return results;
  } catch (error) {
    console.error(`MoviesMod search error: ${error.message}`);
    return [];
  }
}

async function extractStreamsFromPage(html, pageUrl) {
  const streams = [];

  const iframeRegex = /iframe[^>]*src=["']([^"']*?)["']/gi;
  let match;
  while ((match = iframeRegex.exec(html)) !== null) {
    const url = match[1];
    if (url && url.startsWith('http') && !url.includes('moviesmod')) {
      streams.push(url);
    }
  }

  const embedRegex = /(?:data-src|src)=["']([^"']*?(?:mp4|m3u8|mkv)[^"']*)["']/gi;
  while ((match = embedRegex.exec(html)) !== null) {
    const url = match[1];
    if (url && url.startsWith('http') && !url.includes('moviesmod')) {
      streams.push(url);
    }
  }

  const dataRegex = /(?:data-link|data-video|data-src)=["']([^"']+)["']/gi;
  while ((match = dataRegex.exec(html)) !== null) {
    let url = match[1];
    if (url.includes('%')) {
      try {
        url = decodeURIComponent(url);
      } catch {}
    }
    if (url && url.startsWith('http') && !url.includes('moviesmod')) {
      streams.push(url);
    }
  }

  return [...new Set(streams)].slice(0, 10);
}

async function handleRequest(request) {
  const url = new URL(request.url);
  let path = url.pathname;
  
  // Normalize empty path
  if (!path || path === '') path = '/';

  // Debug search & test page (root)
  if (path === '/' || path === '/search') {
    return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MoviesMod Debug Search</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
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
      transition: border-color 0.3s;
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
      font-size: 16px;
      cursor: pointer;
      transition: background 0.3s;
    }
    button:hover {
      background: #764ba2;
    }
    button:disabled {
      background: #ccc;
      cursor: not-allowed;
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
      color: #333;
      margin-bottom: 15px;
      font-size: 14px;
      text-transform: uppercase;
      color: #667eea;
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
      font-family: 'Courier New', monospace;
      margin-bottom: 6px;
      overflow-x: auto;
      background: #f0f0f0;
      padding: 6px;
      border-radius: 4px;
    }
    
    .copy-btn {
      font-size: 11px;
      padding: 4px 12px;
      background: #e0e0e0;
      color: #333;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      transition: background 0.2s;
    }
    
    .copy-btn:hover {
      background: #d0d0d0;
    }
    
    .copy-btn.copied {
      background: #4caf50;
      color: white;
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
      margin-bottom: 10px;
    }
    
    .empty {
      text-align: center;
      color: #999;
      padding: 30px 20px;
      font-size: 14px;
    }
    
    .help {
      background: #f0f4ff;
      padding: 15px;
      border-radius: 8px;
      color: #555;
      font-size: 13px;
      line-height: 1.6;
      margin-bottom: 30px;
      border-left: 4px solid #667eea;
    }
    
    .debug-info {
      background: #fff3cd;
      border: 1px solid #ffc107;
      padding: 10px;
      border-radius: 6px;
      font-size: 12px;
      color: #856404;
      margin-top: 10px;
      font-family: 'Courier New', monospace;
      max-height: 150px;
      overflow-y: auto;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎬 MoviesMod Debug Search</h1>
    <p class="subtitle">Test scraper before Stremio deployment</p>
    
    <div class="help">
      <strong>How to use:</strong> Enter a movie/series title, click Search, and view extracted streams and matched results.
    </div>

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
        <div class="section-title">📋 Search Results</div>
        <div id="searchResults" class="empty">No results yet</div>
      </div>
      
      <div class="section">
        <div class="section-title">🎥 Extracted Streams</div>
        <div id="streamResults" class="empty">No streams yet</div>
      </div>
    </div>

    <div id="debugInfo"></div>
  </div>

  <script>
    const searchInput = document.getElementById('searchInput');
    const searchResultsDiv = document.getElementById('searchResults');
    const streamResultsDiv = document.getElementById('streamResults');
    const alertDiv = document.getElementById('alert');
    const debugInfoDiv = document.getElementById('debugInfo');

    function showAlert(message, type = 'error') {
      alertDiv.textContent = message;
      alertDiv.style.display = 'block';
      alertDiv.className = type === 'error' ? 'error' : 'success';
    }

    function copyToClipboard(text, button) {
      navigator.clipboard.writeText(text).then(() => {
        const original = button.textContent;
        button.textContent = 'Copied!';
        button.classList.add('copied');
        setTimeout(() => {
          button.textContent = original;
          button.classList.remove('copied');
        }, 2000);
      });
    }

    async function search() {
      const query = searchInput.value.trim();
      if (!query) {
        showAlert('Enter a search term', 'warning');
        return;
      }

      alertDiv.style.display = 'none';
      searchResultsDiv.innerHTML = '<div class="loading">Searching...</div>';
      streamResultsDiv.innerHTML = '';
      debugInfoDiv.innerHTML = '';

      try {
        // Step 1: Search for movies
        const searchResponse = await fetch(\`/search-api?q=\${encodeURIComponent(query)}\`);
        const searchData = await searchResponse.json();

        if (!searchData.results || searchData.results.length === 0) {
          searchResultsDiv.innerHTML = '<div class="empty">No results found on MoviesMod</div>';
          return;
        }

        // Display search results
        searchResultsDiv.innerHTML = searchData.results.slice(0, 5).map((result, idx) => \`
          <div class="result-item">
            <div class="result-title">\${idx + 1}. \${result.title}</div>
            <div class="result-url">\${result.url}</div>
            <button class="copy-btn" onclick="copyToClipboard('\${result.url}', this)">Copy URL</button>
          </div>
        \`).join('');

        // Step 2: Extract streams from first result
        streamResultsDiv.innerHTML = '<div class="loading">Extracting streams...</div>';
        
        const firstResult = searchData.results[0];
        const streamResponse = await fetch(\`/extract-streams?url=\${encodeURIComponent(firstResult.url)}\`);
        const streamData = await streamResponse.json();

        if (!streamData.streams || streamData.streams.length === 0) {
          streamResultsDiv.innerHTML = '<div class="empty">No streams found on page</div>';
        } else {
          streamResultsDiv.innerHTML = streamData.streams.map((stream, idx) => \`
            <div class="result-item">
              <div class="result-title">\${idx + 1}. Stream Link</div>
              <div class="result-url">\${stream.url}</div>
              <button class="copy-btn" onclick="copyToClipboard('\${stream.url}', this)">Copy Link</button>
            </div>
          \`).join('');
        }

        // Debug info
        if (streamData.debug) {
          debugInfoDiv.innerHTML = \`
            <div style="margin-top: 20px;">
              <div class="section">
                <div class="section-title">🔍 Debug Info</div>
                <div class="debug-info">\${streamData.debug}</div>
              </div>
            </div>
          \`;
        }

      } catch (error) {
        showAlert(\`Error: \${error.message}\`);
        console.error('Search error:', error);
      }
    }

    searchInput.focus();
  </script>
</body>
</html>`, {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  if (path === '/manifest.json') {
    return new Response(JSON.stringify(MANIFEST), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // Extract streams from URL (for debugging)
  if (path === '/extract-streams') {
    const pageUrl = url.searchParams.get('url');
    if (!pageUrl) {
      return new Response(JSON.stringify({ streams: [], error: 'No URL provided' }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    try {
      const pageResponse = await fetchWithRetry(pageUrl);
      const pageHtml = await pageResponse.text();
      const streamUrls = await extractStreamsFromPage(pageHtml, pageUrl);

      const streams = streamUrls.map((url, index) => ({
        url,
        title: `Stream ${index + 1}`,
      }));

      return new Response(JSON.stringify({ 
        streams,
        debug: \`Fetched: \${pageUrl}\\nFound: \${streamUrls.length} streams\`
      }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    } catch (error) {
      return new Response(JSON.stringify({ 
        streams: [], 
        error: error.message,
        debug: \`Error extracting streams: \${error.message}\`
      }), {
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
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      const results = await searchMoviesMod(id);
      if (!results.length) {
        return new Response(JSON.stringify({ streams: [] }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      const pageResponse = await fetchWithRetry(results[0].url);
      const pageHtml = await pageResponse.text();
      const streamUrls = await extractStreamsFromPage(pageHtml, results[0].url);

      const streams = streamUrls.map((url, index) => ({
        url,
        title: \`\${results[0].title} [\${index + 1}]\`,
      }));

      return new Response(JSON.stringify({ streams }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (error) {
      console.error(\`Stream error: \${error.message}\`);
      return new Response(JSON.stringify({ streams: [] }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  }

  if (path === '/search-api') {
    const query = url.searchParams.get('q');
    if (!query) {
      return new Response(JSON.stringify({ results: [] }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    try {
      const results = await searchMoviesMod(query);
      return new Response(JSON.stringify({ results: results.slice(0, 10) }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (error) {
      console.error(\`Search error: \${error.message}\`);
      return new Response(JSON.stringify({ results: [], error: error.message }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  }

  if (path === '/configure') {
    return new Response(\`<!DOCTYPE html>
<html>
<head>
  <title>MoviesMod Addon</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      padding: 40px;
      max-width: 600px;
      margin: 0 auto;
      background: #f5f5f5;
    }
    h1 { color: #333; }
    p { color: #666; line-height: 1.6; }
    code { background: #eee; padding: 2px 6px; border-radius: 3px; }
    a { color: #667eea; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>MoviesMod Stremio Addon</h1>
  <p>Stream extraction addon for MoviesMod</p>
  <p><strong>Manifest URL:</strong></p>
  <code>\${url.origin}/manifest.json</code>
  <p><strong>Features:</strong></p>
  <ul>
    <li>Search movies and series</li>
    <li>Extract streams from MoviesMod</li>
    <li>Multiple source support</li>
  </ul>
  <p><a href="/">← Back to Debug Search</a></p>
</body>
</html>\`, {
      headers: { 'Content-Type': 'text/html' },
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

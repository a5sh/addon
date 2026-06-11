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
  const path = url.pathname;

  if (path === '/' || path === '/search' || path === '') {
    return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MoviesMod Search</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 12px;
      padding: 40px;
      max-width: 600px;
      width: 100%;
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
      margin-bottom: 8px;
    }
    .result-url {
      font-size: 12px;
      color: #666;
      word-break: break-all;
      font-family: monospace;
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
    .help {
      background: #f0f4ff;
      padding: 15px;
      border-radius: 8px;
      color: #555;
      font-size: 13px;
      line-height: 1.6;
      margin-bottom: 30px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎬 MoviesMod Search</h1>
    <p class="subtitle">Search for movies and series</p>
    
    <div class="help">
      <strong>How to use:</strong><br>
      • Enter a movie or series title<br>
      • Click Search to find streams<br>
      • Results show available links from MoviesMod
    </div>

    <div class="search-box">
      <input 
        type="text" 
        id="searchInput" 
        placeholder="Search movie or series..." 
        onkeypress="if(event.key==='Enter') search()"
      >
      <button onclick="search()">Search</button>
    </div>

    <div id="results" class="results"></div>
  </div>

  <script>
    const resultsDiv = document.getElementById('results');
    const searchInput = document.getElementById('searchInput');

    async function search() {
      const query = searchInput.value.trim();
      if (!query) {
        resultsDiv.innerHTML = '<div class="empty">Enter a search term</div>';
        return;
      }

      resultsDiv.innerHTML = '<div class="loading">Searching...</div>';

      try {
        const response = await fetch(\`\${window.location.origin}/search-api?q=\${encodeURIComponent(query)}\`);
        const data = await response.json();

        if (!data.results || data.results.length === 0) {
          resultsDiv.innerHTML = '<div class="empty">No results found</div>';
          return;
        }

        resultsDiv.innerHTML = data.results.map((result, idx) => \`
          <div class="result-item">
            <div class="result-title">\${idx + 1}. \${result.title}</div>
            <div class="result-url">\${result.url}</div>
          </div>
        \`).join('');
      } catch (error) {
        resultsDiv.innerHTML = \`<div class="error">Error: \${error.message}</div>\`;
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
        title: `${results[0].title} [${index + 1}]`,
      }));

      return new Response(JSON.stringify({ streams }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (error) {
      console.error(`Stream error: ${error.message}`);
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
      console.error(`Search error: ${error.message}`);
      return new Response(JSON.stringify({ results: [], error: error.message }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  }

  if (path === '/configure') {
    return new Response(`<!DOCTYPE html>
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
    code { background: #eee; padding: 2px 6px; }
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
</body>
</html>`, {
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

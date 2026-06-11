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

const TMDB_API_BASE = 'https://api.themoviedb.org/3';
const MOVIESMOD_BASE = 'https://moviesmod.money'; // adjust domain as needed

/**
 * Fetch from external API with timeout and retries
 */
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

/**
 * Convert IMDb ID to TMDB ID
 */
async function getIMDBtoTMDB(imdbId) {
  const tmdbKey = 'TMDB_KEY'; // Set via environment variable
  if (!tmdbKey) {
    throw new Error('TMDB_KEY not configured');
  }

  try {
    const url = `${TMDB_API_BASE}/find/${imdbId}?external_source=imdb_id&api_key=${tmdbKey}`;
    const response = await fetchWithRetry(url);
    const data = await response.json();

    const results = data.movie_results || data.tv_results || [];
    if (results.length === 0) {
      return null;
    }
    return results[0].id;
  } catch (error) {
    console.error(`Failed to convert IMDb to TMDB: ${imdbId}`, error);
    return null;
  }
}

/**
 * Search MoviesMod for a movie/series
 */
async function searchMoviesMod(title, year, isSeries = false) {
  try {
    const searchQuery = `${title}${year ? ` ${year}` : ''}`;
    const searchUrl = new URL(`${MOVIESMOD_BASE}/?s=${encodeURIComponent(searchQuery)}`);

    const response = await fetchWithRetry(searchUrl.toString());
    const html = await response.text();

    // Simple regex-based HTML parsing for search results
    const matches = html.matchAll(
      /href=["']([^"']*?)["'][^>]*>([^<]+)<\/a>/gi
    );

    const results = [];
    for (const match of matches) {
      const link = match[1];
      const text = match[2];

      // Filter by type and relevance
      if (
        (isSeries && link.includes('/series/')) ||
        (!isSeries && !link.includes('/series/'))
      ) {
        results.push({
          url: link,
          title: text,
        });
      }
    }

    return results.length > 0 ? results[0] : null;
  } catch (error) {
    console.error(`MoviesMod search failed for: ${title}`, error);
    return null;
  }
}

/**
 * Extract stream URLs from MoviesMod page
 */
async function extractStreamsFromMoviesMod(pageUrl, meta = {}) {
  try {
    const response = await fetchWithRetry(pageUrl);
    const html = await response.text();

    const streams = [];

    // Look for common video embed patterns
    // Pattern 1: iframe sources
    const iframeMatches = html.matchAll(
      /iframe[^>]*src=["']([^"']*?)["']/gi
    );
    for (const match of iframeMatches) {
      const embedUrl = match[1];
      if (embedUrl && !embedUrl.includes('moviesmod')) {
        streams.push({
          url: embedUrl,
          title: meta.title || 'MoviesMod Stream',
        });
      }
    }

    // Pattern 2: Direct video links
    const videoMatches = html.matchAll(
      /(?:href|src)=["']([^"']*?\.(?:mp4|mkv|m3u8)[^"']*?)["']/gi
    );
    for (const match of videoMatches) {
      const videoUrl = match[1];
      if (videoUrl && !videoUrl.includes('moviesmod')) {
        streams.push({
          url: videoUrl,
          title: meta.title || 'MoviesMod Stream',
        });
      }
    }

    // Pattern 3: Data attributes with URLs
    const dataMatches = html.matchAll(
      /data-(?:link|video|src)=["']([^"']+)["']/gi
    );
    for (const match of dataMatches) {
      let linkUrl = match[1];
      // Decode if needed
      if (linkUrl.startsWith('http')) {
        streams.push({
          url: linkUrl,
          title: meta.title || 'MoviesMod Stream',
        });
      }
    }

    return streams;
  } catch (error) {
    console.error(`Failed to extract streams from: ${pageUrl}`, error);
    return [];
  }
}

/**
 * Main handler for requests
 */
async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  // Manifest endpoint
  if (path === '/manifest.json') {
    return new Response(JSON.stringify(MANIFEST), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // Stream endpoint: /stream/:type/:id.json
  const streamMatch = path.match(/^\/stream\/([^\/]+)\/([^\/]+)\.json$/);
  if (streamMatch) {
    const type = streamMatch[1]; // 'movie' or 'series'
    const rawId = streamMatch[2]; // IMDb or TMDB ID

    try {
      let imdbId, tmdbId, title, year, isSeries;

      // Parse ID
      if (rawId.startsWith('tt')) {
        imdbId = rawId;
        tmdbId = await getIMDBtoTMDB(imdbId);
      } else if (rawId.startsWith('tmdb:')) {
        tmdbId = rawId.substring(5);
      } else {
        return jsonError('Unsupported ID format', 400);
      }

      // For now, we'll use a simple search
      // In production, you'd fetch from TMDB to get proper metadata
      isSeries = type === 'series';

      // Search MoviesMod
      const searchResult = await searchMoviesMod(title || 'Unknown', year, isSeries);
      if (!searchResult) {
        return jsonResponse({ streams: [] });
      }

      // Extract streams
      const movieStreams = await extractStreamsFromMoviesMod(searchResult.url, {
        title: searchResult.title,
      });

      // Format for Stremio
      const streams = movieStreams.map(stream => ({
        url: stream.url,
        title: `${stream.title} (MoviesMod)`,
        behaviorHints: {
          notWebReady: !stream.url.includes('.mp4'),
        },
      }));

      return jsonResponse({ streams });
    } catch (error) {
      console.error('Stream resolution error:', error);
      return jsonResponse({ streams: [] });
    }
  }

  // Configure endpoint (optional)
  if (path === '/configure') {
    return new Response(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>MoviesMod Addon</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 20px; }
          .container { max-width: 600px; margin: 0 auto; }
          h1 { color: #333; }
          p { color: #666; line-height: 1.6; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>MoviesMod Stremio Addon</h1>
          <p>This addon extracts HTTP streams from MoviesMod.</p>
          <p><strong>Installation URL:</strong></p>
          <code>${url.origin}/manifest.json</code>
          <p><strong>Features:</strong></p>
          <ul>
            <li>Stream extraction from MoviesMod</li>
            <li>Support for movies and series</li>
            <li>IMDb and TMDB ID support</li>
          </ul>
        </div>
      </body>
      </html>
    `, {
      headers: {
        'Content-Type': 'text/html',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // Root redirect
  if (path === '/') {
    return new Response('Redirect', {
      status: 301,
      headers: { Location: '/configure' },
    });
  }

  return new Response('Not Found', { status: 404 });
}

/**
 * Helper: JSON response
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

/**
 * Helper: JSON error response
 */
function jsonError(message, status = 500) {
  return jsonResponse({ error: message }, status);
}

/**
 * Cloudflare Worker entry point
 */
export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    try {
      return await handleRequest(request);
    } catch (error) {
      console.error('Worker error:', error);
      return jsonError('Internal server error', 500);
    }
  },
};

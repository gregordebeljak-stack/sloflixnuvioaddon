'use strict';

const http = require('http');
const https = require('https');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const renderConfigurePage = require('./lib/configurePage');
const { SloFlixClient, DEFAULT_API_URL } = require('./lib/sloflixClient');
const { TTLCache } = require('./lib/cache');
const { toCatalogPreview, toMovieMeta, toSeriesMeta, fromId, pickGenres, pickYear } = require('./lib/mappers');

const PORT = process.env.PORT || 7860;
const API_URL = process.env.SLOFLIX_API_URL || DEFAULT_API_URL;
const CATALOG_TTL_MS = 30 * 60 * 1000; // 30 min
const STREAM_TTL_MS = 5 * 60 * 1000; // 5 min (SloFlix source links can expire)

// Fallback base URL, used only when there is no incoming HTTP request to read
// (e.g. the startup log line below). Real /play/ links are built from the
// actual request instead — see requestContext/getPublicUrl() — so this never
// causes the "stuck on nalaganje" bug even if left unset or wrong.
const FALLBACK_PUBLIC_URL = (
  process.env.PUBLIC_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://127.0.0.1:${PORT}`
).replace(/\/+$/, '');

// Per-request storage so buildPlayUrl() (called from inside
// defineStreamHandler, which the stremio-addon-sdk invokes without giving us
// access to the Express `req`) can still recover the base URL the *current*
// request actually came in on. AsyncLocalStorage keeps this correctly scoped
// per concurrent request (unlike a plain module-level variable, which would
// be a race condition under concurrent requests).
const requestContext = new AsyncLocalStorage();

function detectBaseUrl(req) {
  // req.protocol honors X-Forwarded-Proto once 'trust proxy' is enabled
  // below (needed behind Render's proxy, Docker reverse proxies, Cloudflare,
  // etc.). req.get('host'), however, always returns the RAW Host header
  // regardless of the trust proxy setting, so we check X-Forwarded-Host
  // ourselves (first entry, in case of a comma-separated proxy chain).
  const forwardedHost = req.headers['x-forwarded-host'];
  const host = (forwardedHost ? forwardedHost.split(',')[0].trim() : '') || req.get('host');
  if (!host) return FALLBACK_PUBLIC_URL;
  return `${req.protocol}://${host}`.replace(/\/+$/, '');
}

function getPublicUrl() {
  // Explicit PUBLIC_URL env var still wins if the operator set one on
  // purpose (e.g. addon reachable at a different public address than the
  // Host header it sees, such as behind a tunnel with URL rewriting).
  // Otherwise use the address the current request actually arrived on.
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  const store = requestContext.getStore();
  return (store && store.baseUrl) || FALLBACK_PUBLIC_URL;
}

const catalogCache = new TTLCache(CATALOG_TTL_MS);
const streamCache = new TTLCache(STREAM_TTL_MS);
const clientCache = new Map(); // username -> SloFlixClient (keeps the login token warm)

// Reused keep-alive agents for the /play/ proxy's upstream requests to the
// SloFlix CDN. Without these, every Range request a player makes while
// seeking opens a brand-new TCP+TLS connection from scratch; keeping
// connections alive per-host cuts that latency substantially.
const keepAliveHttpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 32 });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 32 });

const manifest = {
  id: 'com.jellysloflix.stremio',
  version: '1.1.0',
  name: 'SloFlix',
  description:
    'Glej Sloflix neposredno preko Nuvio ali Stremio, z vašim lastnim računom Sloflix.',
  logo: '/icon.png', // placeholder; rewritten to an absolute URL per-request in the manifest.json override below
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  catalogs: [
    {
      type: 'movie',
      id: 'sloflix-movies',
      name: 'SloFlix Filmi',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      type: 'series',
      id: 'sloflix-series',
      name: 'SloFlix Serije',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      type: 'movie',
      id: 'sloflix-slovenski',
      name: 'SloFlix Slovenski filmi',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      type: 'movie',
      id: 'sloflix-slosinh',
      name: 'SloFlix SLOSiNH (risanke in risani filmi)',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    }
  ],
  idPrefixes: ['sloflix:'],
  config: [
    { key: 'username', type: 'text', title: 'SloFlix uporabniško ime (e-pošta)' },
    { key: 'password', type: 'password', title: 'SloFlix geslo' }
  ],
  behaviorHints: {
    configurable: true,
    configurationRequired: true
  }
};

function getClient(config) {
  const username = config && config.username;
  const password = config && config.password;
  if (!username || !password) {
    throw new Error('Ta addon zahteva SloFlix uporabniško ime in geslo. Uporabite gumb "Configure" ob namestitvi.');
  }
  let client = clientCache.get(username);
  if (!client) {
    client = new SloFlixClient({ apiUrl: API_URL, username, password });
    clientCache.set(username, client);
  }
  return client;
}

async function getCatalogData(client) {
  return catalogCache.getOrLoad(client.username, () => client.getCatalog());
}

function buildPlayUrl(config, mediaId, qualityIndex) {
  const configStr = encodeURIComponent(JSON.stringify(config));
  const base = `${getPublicUrl()}/${configStr}/play/${encodeURIComponent(mediaId)}`;
  return qualityIndex === undefined ? base : `${base}/${qualityIndex}`;
}

// Maps a custom catalog id to the SloFlix genre tag (as seen in the
// "Filtriraj in razvrsti" filter on sloflix.com, e.g. media_genres containing
// "Slovenski" or "SLOSiNH") it should be restricted to.
const GENRE_CATALOGS = {
  'sloflix-slovenski': 'Slovenski',
  'sloflix-slosinh': 'SLOSiNH'
};

// ==========================================
// Stremio addon resource handlers
// ==========================================
const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra, config }) => {
  const client = getClient(config);
  const search = extra && extra.search;
  const skip = (extra && parseInt(extra.skip, 10)) || 0;
  const pageSize = 100;
  const genreFilter = GENRE_CATALOGS[id];

  let items;
  if (search) {
    const results = await client.searchCatalog(search);
    items = results.filter((item) =>
      type === 'movie'
        ? item.media_type === 1 || (!item.media_type && !item.seasons)
        : item.media_type === 2 || item.seasons
    );
  } else {
    const { movies, shows } = await getCatalogData(client);
    items = type === 'movie' ? movies : shows;
  }

  if (genreFilter) {
    items = items.filter((item) => pickGenres(item).includes(genreFilter));
  }

  // Sort newest year first (same as SloFlix's own "Leto: najprej novejše"
  // sort option). Items with no parseable year sink to the bottom instead of
  // interrupting the year ordering.
  items = [...items].sort((a, b) => {
    const yearA = parseInt(pickYear(a), 10);
    const yearB = parseInt(pickYear(b), 10);
    return (isNaN(yearB) ? -Infinity : yearB) - (isNaN(yearA) ? -Infinity : yearA);
  });

  if (!search) {
    // Only paginate the browse view; search results are typically few and
    // Stremio doesn't send `skip` for them anyway.
    items = items.slice(skip, skip + pageSize);
  }

  return { metas: items.map((item) => toCatalogPreview(item, type)) };
});

builder.defineMetaHandler(async ({ type, id, config }) => {
  const client = getClient(config);
  const mediaId = fromId(id);
  const item = await client.getSingle(mediaId);

  if (type === 'movie') {
    return { meta: toMovieMeta(item) };
  }

  const episodes = await client.getShowEpisodes(mediaId);
  return { meta: toSeriesMeta(item, episodes) };
});

builder.defineStreamHandler(async ({ type, id, config }) => {
  const mediaId = fromId(id);
  const client = getClient(config);

  // Resolve now (not lazily on first /play/ hit) so Stremio/Nuvio can show
  // every available quality up front, sorted best-first, and so the actual
  // /play/ request that follows is an instant cache hit instead of doing a
  // fresh SloFlix API round-trip right when the user presses play.
  try {
    const resolved = await streamCache.getOrLoad(`${client.username}:${mediaId}`, () => client.resolveStream(mediaId));

    return {
      streams: resolved.streams.map((s, idx) => ({
        url: buildPlayUrl(config, mediaId, idx),
        // Show the detected quality whenever we found one (e.g. "SloFlix -
        // 1080p"), even for a single remaining stream - not just when there
        // are several to tell apart. Falls back to plain "SloFlix" only if
        // no quality hint could be parsed from this source at all.
        title: s.score ? `SloFlix - ${s.label}` : 'SloFlix',
        behaviorHints: { notWebReady: false, bingeGroup: `sloflix-${mediaId}` }
      }))
    };
  } catch (err) {
    // Resolution failed (e.g. transient SloFlix API issue) — fall back to a
    // single lazily-resolved stream, same as before, so the title still
    // shows a playable option instead of none. /play/ will retry resolution
    // and surface a clear 502 if it still fails.
    return {
      streams: [
        {
          url: buildPlayUrl(config, mediaId),
          title: 'SloFlix',
          behaviorHints: { notWebReady: false }
        }
      ]
    };
  }
});

// ==========================================
// HTTP app: Stremio addon router + /play/ streaming proxy
// ==========================================
const addonInterface = builder.getInterface();
const app = express();

// Required so req.protocol / req.get('host') reflect the ORIGINAL public
// request (via X-Forwarded-Proto / X-Forwarded-Host) rather than the
// internal proxy hop's own scheme/host — Render and most other hosts sit
// behind such a proxy.
app.set('trust proxy', true);

// Capture the base URL of the incoming request BEFORE handing off to the
// addon router, so buildPlayUrl() (invoked later, deep inside
// defineStreamHandler) can read it back via requestContext/getPublicUrl().
app.use((req, _res, next) => {
  requestContext.run({ baseUrl: detectBaseUrl(req) }, next);
});

// Serve the actual icon file, and override the SDK's default manifest.json
// route to inject its full, request-detected absolute URL. We can't just put
// a data: URI or absolute URL straight in the static `manifest` object above:
// a data URI pushes the manifest over the SDK's hard 8kb size limit, and a
// hardcoded absolute URL would break as soon as the addon is reachable at a
// different host (same reasoning as the /play/ URL auto-detection above).
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');
app.get('/icon.png', (_req, res) => res.sendFile(ICON_PATH));

app.get('/:config?/manifest.json', (req, res) => {
  const manifestResp = JSON.parse(JSON.stringify(manifest));
  manifestResp.logo = `${detectBaseUrl(req)}/icon.png`;
  if (req.params.config && manifestResp.behaviorHints) {
    // Same as the SDK's own manifestHandler: once configured, drop these so
    // the addon is treated as already installed rather than needing setup.
    delete manifestResp.behaviorHints.configurationRequired;
    delete manifestResp.behaviorHints.configurable;
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.json(manifestResp);
});

app.use(getRouter(addonInterface));

app.get('/', (_req, res) => res.redirect('/configure'));
app.get('/configure', (_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(renderConfigurePage(manifest));
});

app.get('/:config/play/:mediaId/:qualityIndex?', async (req, res) => {
  try {
    const config = JSON.parse(decodeURIComponent(req.params.config));
    const client = getClient(config);
    const mediaId = req.params.mediaId;

    const resolved = await streamCache.getOrLoad(`${client.username}:${mediaId}`, () =>
      client.resolveStream(mediaId)
    );

    const requestedIndex = parseInt(req.params.qualityIndex, 10);
    const stream =
      (!isNaN(requestedIndex) && resolved.streams[requestedIndex]) || resolved.streams[0];

    await proxyStream(req, res, stream.streamUrl);
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).send('SloFlix proxy error: ' + err.message);
    } else {
      res.end();
    }
  }
});

/**
 * Streams the upstream SloFlix video URL back to the client, adding the
 * Referer/Origin headers the SloFlix CDN requires, following redirects, and
 * forwarding Range requests so seeking works. Adapted from the original
 * JellySloFlix server.js proxyStreamNode().
 */
function proxyStream(req, res, targetUrl, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Too many redirects');
      return resolve();
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid upstream URL');
      return resolve();
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const httpLib = isHttps ? https : http;
    const agent = isHttps ? keepAliveHttpsAgent : keepAliveHttpAgent;

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: 'https://player.sloflix.com/',
      Origin: 'https://player.sloflix.com',
      // Video is already compressed; asking for gzip/br just burns CPU on
      // both ends for zero size benefit and can add latency to first byte.
      'Accept-Encoding': 'identity'
    };
    if (req.headers['range']) headers.range = req.headers['range'];

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: req.method || 'GET',
      headers,
      agent
    };

    const upstreamReq = httpLib.request(options, (upstreamRes) => {
      if ([301, 302, 303, 307, 308].includes(upstreamRes.statusCode) && upstreamRes.headers.location) {
        const redirectUrl = new URL(upstreamRes.headers.location, targetUrl).toString();
        upstreamRes.resume();
        return resolve(proxyStream(req, res, redirectUrl, redirectCount + 1));
      }

      const forwardHeaders = {};
      ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'].forEach((h) => {
        if (upstreamRes.headers[h]) forwardHeaders[h] = upstreamRes.headers[h];
      });

      res.writeHead(upstreamRes.statusCode, forwardHeaders);
      upstreamRes.pipe(res);
      upstreamRes.on('end', resolve);
      upstreamRes.on('error', reject);
    });

    // Lower first-byte latency slightly by not waiting to coalesce small
    // outgoing packets (irrelevant once the body is flowing, but helps the
    // initial request/headers go out immediately).
    upstreamReq.on('socket', (socket) => socket.setNoDelay(true));

    upstreamReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Upstream request error: ' + err.message);
      }
      reject(err);
    });

    req.on('close', () => upstreamReq.destroy());
    upstreamReq.end();
  });
}

app.listen(PORT, () => {
  console.log(`SloFlix Stremio addon posluša na vratih ${PORT}`);
  console.log(
    `Javni naslov za /play/ povezave se samodejno zazna iz vsake zahteve` +
      (process.env.PUBLIC_URL ? ` (ročno prepisan s PUBLIC_URL=${process.env.PUBLIC_URL})` : '') +
      '.'
  );
  console.log(`Odprite ${FALLBACK_PUBLIC_URL}/configure za konfiguracijo in namestitev.`);
});

'use strict';

const http = require('http');
const https = require('https');
const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const landingTemplate = require('stremio-addon-sdk/src/landingTemplate');
const { SloFlixClient, DEFAULT_API_URL } = require('./lib/sloflixClient');
const { TTLCache } = require('./lib/cache');
const { toCatalogPreview, toMovieMeta, toSeriesMeta, fromId } = require('./lib/mappers');

const PORT = process.env.PORT || 7860;
const API_URL = process.env.SLOFLIX_API_URL || DEFAULT_API_URL;
const CATALOG_TTL_MS = 30 * 60 * 1000; // 30 min
const STREAM_TTL_MS = 5 * 60 * 1000; // 5 min (SloFlix source links can expire)

// Public base URL used to build the /play/... proxy links returned to
// Stremio/Nuvio. Render sets RENDER_EXTERNAL_URL automatically; for other
// hosts set PUBLIC_URL yourself (see README).
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${PORT}`).replace(
  /\/+$/,
  ''
);

const catalogCache = new TTLCache(CATALOG_TTL_MS);
const streamCache = new TTLCache(STREAM_TTL_MS);
const clientCache = new Map(); // username -> SloFlixClient (keeps the login token warm)

const manifest = {
  id: 'com.jellysloflix.stremio',
  version: '1.1.0',
  name: 'SloFlix',
  description:
    'Gleda vaš SloFlix katalog (filmi in serije) neposredno v Stremiu, z uporabo vašega lastnega SloFlix računa.',
  logo: 'https://sloflix.com/favicon.ico',
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

function buildPlayUrl(config, mediaId) {
  const configStr = encodeURIComponent(JSON.stringify(config));
  return `${PUBLIC_URL}/${configStr}/play/${encodeURIComponent(mediaId)}`;
}

// ==========================================
// Stremio addon resource handlers
// ==========================================
const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, extra, config }) => {
  const client = getClient(config);
  const search = extra && extra.search;
  const skip = (extra && parseInt(extra.skip, 10)) || 0;
  const pageSize = 100;

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

  // Point the player at OUR OWN /play/ proxy instead of the raw SloFlix CDN
  // URL: the SloFlix video source requires specific Referer/Origin headers
  // (https://player.sloflix.com/), which Stremio/Nuvio players cannot send
  // themselves. The proxy route below adds them server-side, same as the
  // original JellySloFlix server.js bridge did for Jellyfin.
  const stream = {
    url: buildPlayUrl(config, mediaId),
    title: 'SloFlix',
    behaviorHints: { notWebReady: false }
  };

  return { streams: [stream] };
});

// ==========================================
// HTTP app: Stremio addon router + /play/ streaming proxy
// ==========================================
const addonInterface = builder.getInterface();
const app = express();
app.use(getRouter(addonInterface));

app.get('/', (_req, res) => res.redirect('/configure'));
app.get('/configure', (_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(landingTemplate(manifest));
});

app.get('/:config/play/:mediaId', async (req, res) => {
  try {
    const config = JSON.parse(decodeURIComponent(req.params.config));
    const client = getClient(config);
    const mediaId = req.params.mediaId;

    const resolved = await streamCache.getOrLoad(`${client.username}:${mediaId}`, () =>
      client.resolveStream(mediaId)
    );

    await proxyStream(req, res, resolved.streamUrl);
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

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: 'https://player.sloflix.com/',
      Origin: 'https://player.sloflix.com'
    };
    if (req.headers['range']) headers.range = req.headers['range'];

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: req.method || 'GET',
      headers
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
  console.log(`Javni naslov (za /play/ povezave): ${PUBLIC_URL}`);
  console.log(`Odprite ${PUBLIC_URL}/configure za konfiguracijo in namestitev.`);
});

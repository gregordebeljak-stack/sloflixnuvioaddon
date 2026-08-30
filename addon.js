'use strict';

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const { SloFlixClient, DEFAULT_API_URL } = require('./lib/sloflixClient');
const { TTLCache } = require('./lib/cache');
const { toCatalogPreview, toMovieMeta, toSeriesMeta, fromId } = require('./lib/mappers');

const PORT = process.env.PORT || 7860;
const API_URL = process.env.SLOFLIX_API_URL || DEFAULT_API_URL;
const CATALOG_TTL_MS = 30 * 60 * 1000; // 30 min
const STREAM_TTL_MS = 5 * 60 * 1000; // 5 min (SloFlix source links can expire)

const catalogCache = new TTLCache(CATALOG_TTL_MS);
const streamCache = new TTLCache(STREAM_TTL_MS);
const clientCache = new Map(); // username -> SloFlixClient (keeps the login token warm)

const manifest = {
  id: 'com.jellysloflix.stremio',
  version: '1.0.0',
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

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra, config }) => {
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
  const client = getClient(config);
  const mediaId = fromId(id);

  const resolved = await streamCache.getOrLoad(`${client.username}:${mediaId}`, () => client.resolveStream(mediaId));

  const stream = {
    url: resolved.streamUrl,
    title: 'SloFlix' + (resolved.mediaName ? ` - ${resolved.mediaName}` : ''),
    behaviorHints: { notWebReady: false }
  };

  if (resolved.subtitleUrl) {
    stream.subtitles = [{ id: `${mediaId}-sl`, url: resolved.subtitleUrl, lang: 'slv' }];
  }

  return { streams: [stream] };
});

serveHTTP(builder.getInterface(), { port: PORT });

console.log(`SloFlix Stremio addon posluša na vratih ${PORT}`);
console.log(`Odprite http://127.0.0.1:${PORT}/configure za konfiguracijo in namestitev.`);

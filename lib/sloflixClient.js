'use strict';

/**
 * Minimal SloFlix API client, adapted from the JellySloFlix project
 * (sync.js / server.js) for use inside a Stremio addon.
 */

const DEFAULT_API_URL = 'https://api.sloflix.com';

function buildHeaders(extra = {}) {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Referer: 'https://sloflix.com/',
    Origin: 'https://sloflix.com',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9,sl;q=0.8',
    ...extra
  };
}

class SloFlixClient {
  constructor({ apiUrl = DEFAULT_API_URL, username, password, token } = {}) {
    this.baseUrl = apiUrl.replace(/\/+$/, '');
    this.username = username;
    this.password = password;
    this.token = token || null;
    this.headers = buildHeaders();
  }

  async login() {
    if (!this.username || !this.password) {
      throw new Error('Manjkajo SloFlix poverilnice (username/password).');
    }
    const res = await fetch(`${this.baseUrl}/v1/user/login`, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.username, password: this.password })
    });
    const data = await res.json().catch(() => ({}));
    if (data.code === 200 && data.metadata && data.metadata.access_token) {
      this.token = data.metadata.access_token;
      return this.token;
    }
    throw new Error(
      `SloFlix prijava ni uspela: ${(data.error && data.error.message) || data.message || res.status}`
    );
  }

  async ensureToken() {
    if (!this.token) await this.login();
    return this.token;
  }

  async authedFetch(pathAndQuery, opts = {}) {
    await this.ensureToken();
    const url = `${this.baseUrl}${pathAndQuery.startsWith('/') ? '' : '/'}${pathAndQuery}`;
    let res = await fetch(url, {
      ...opts,
      headers: { ...this.headers, ...(opts.headers || {}), Authorization: `Bearer ${this.token}` }
    });

    if (res.status === 401 || res.status === 500) {
      // Token may have expired - re-login once and retry.
      this.token = null;
      await this.login();
      res = await fetch(url, {
        ...opts,
        headers: { ...this.headers, ...(opts.headers || {}), Authorization: `Bearer ${this.token}` }
      });
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} @ ${pathAndQuery}`);
    }
    return res.json();
  }

  /** Fetch the full movie+series catalog via pagination from /v1/media */
  async getCatalog({ sortBy = 1, pageSize = 100, maxItems = 4000 } = {}) {
    let allItems = [];
    let offset = 0;
    let totalAvailable = Infinity;

    while (allItems.length < totalAvailable && allItems.length < maxItems) {
      const response = await this.authedFetch(`/v1/media?sortBy=${sortBy}&limit=${pageSize}&offset=${offset}`);
      let batch = [];
      if (response && Array.isArray(response.data)) {
        batch = response.data;
        if (response.metadata && response.metadata.all_movies) {
          totalAvailable = response.metadata.all_movies;
        }
      } else if (Array.isArray(response)) {
        batch = response;
      }
      if (batch.length === 0) break;
      allItems.push(...batch);
      offset += batch.length;
      if (batch.length < pageSize) break;
    }

    const movies = allItems.filter(
      (item) => item.media_type === 1 || item.type === 'movie' || (!item.media_type && !item.seasons)
    );
    const shows = allItems.filter(
      (item) => item.media_type === 2 || item.type === 'series' || item.type === 'show' || item.seasons
    );
    return { movies, shows };
  }

  async searchCatalog(keyword) {
    const response = await this.authedFetch(`/v1/media/search?keyword=${encodeURIComponent(keyword)}`);
    if (response && Array.isArray(response.data)) return response.data;
    if (Array.isArray(response)) return response;
    return [];
  }

  async getSingle(mediaId) {
    const response = await this.authedFetch(`/v1/media/single/${mediaId}?dont_count_view=true`);
    return response && response.data ? response.data : response;
  }

  /** Fetch all episodes for a show across all its seasons */
  async getShowEpisodes(showId) {
    const single = await this.getSingle(showId);
    const seasons = (single && single.seasons) || [1];
    const allEpisodes = [];

    for (const seasonNum of seasons) {
      try {
        const epData = await this.authedFetch(`/v1/media/episodes/${showId}/${seasonNum}`);
        if (epData && Array.isArray(epData.data)) {
          for (const ep of epData.data) {
            allEpisodes.push({
              ...ep,
              season: seasonNum,
              episode: ep.episode_index || ep.episode || 1
            });
          }
        }
      } catch (err) {
        // skip missing season
      }
    }
    return allEpisodes;
  }

  /**
   * Best-effort quality score for a SloFlix source object, so we can pick the
   * highest-quality stream instead of just the first one the API happens to
   * list first. We don't know SloFlix's exact schema for this field across
   * accounts/content, so we check several common key names, then fall back
   * to parsing quality hints (e.g. "1080p", "4K") out of any label/URL text.
   */
  static scoreSource(sourceObj, rawSource) {
    const explicit =
      sourceObj.height ||
      sourceObj.resolution_height ||
      sourceObj.quality ||
      sourceObj.resolution ||
      sourceObj.label ||
      sourceObj.name;
    if (typeof explicit === 'number') return explicit;

    const text = String(explicit || sourceObj.label || sourceObj.name || rawSource || '').toLowerCase();
    const match = text.match(/(\d{3,4})\s*p\b/) || text.match(/\b(4k|2160|1440|1080|720|576|480|360|240)\b/);
    if (match) {
      const token = match[1];
      if (token === '4k') return 2160;
      const num = parseInt(token, 10);
      if (!isNaN(num)) return num;
    }
    return 0; // unknown quality: sorted last among sources with detected quality
  }

  static labelForScore(score) {
    if (!score) return 'SloFlix';
    if (score >= 2160) return '4K';
    return `${score}p`;
  }

  /**
   * Resolve ALL playable sources for a given media/episode id, sorted best
   * quality first. Each entry: { streamUrl, subtitleUrl, label, score }.
   */
  async resolveStream(mediaId) {
    const data = await this.getSingle(mediaId);
    const sources = (data && (data.media_sources || data.sources)) || [];

    const resolved = [];
    for (const sourceObj of sources) {
      const rawSource = sourceObj.media_source || sourceObj.source;
      if (!rawSource) continue;

      const match = rawSource.match(/[?&]source=([^&]+)/);
      const streamUrl = match ? decodeURIComponent(match[1]) : rawSource;
      let subtitleUrl = sourceObj.subtitle_location || sourceObj.subtitles || sourceObj.subtitle || null;
      if (subtitleUrl && !subtitleUrl.startsWith('http')) {
        subtitleUrl = `https://sloflix.com/subtitles/${subtitleUrl}`;
      }

      const score = SloFlixClient.scoreSource(sourceObj, rawSource);
      resolved.push({ streamUrl, subtitleUrl, score, label: SloFlixClient.labelForScore(score) });
    }

    if (resolved.length === 0) {
      throw new Error(`Ni bilo mogoče najti veljavne povezave za predvajanje (id ${mediaId}).`);
    }

    // Best quality first. Ties (including all-unknown-quality lists) keep
    // their original relative order via a stable sort.
    resolved.sort((a, b) => b.score - a.score);

    return {
      streams: resolved,
      mediaName: data.media_name,
      mediaNameEn: data.media_name_en
    };
  }
}

module.exports = { SloFlixClient, DEFAULT_API_URL };

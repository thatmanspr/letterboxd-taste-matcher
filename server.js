// When running under Electron, dotenv is not used — config comes via env vars set by main.js
if (!process.env.TM_DATA_DIR) {
  // fallback: plain node invocation, try .env
  try { require('dotenv').config(); } catch {}
}

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const app = express();
const PORT = process.env.PORT || 3000;

const TMDB_API_KEY  = process.env.TMDB_API_KEY;
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

if (!TMDB_API_KEY) {
  console.warn('⚠️  TMDB_API_KEY not set – TMDb requests will fail.');
}

// ─── In-memory state ─────────────────────────────────────────────────────────

let ratings      = [];  // all rated films
let watchlist    = [];  // watchlist after rewatches removed
let overlapItems = [];  // in both ratings + watchlist (rewatch candidates)
let failedItems  = [];  // items that couldn't be resolved on TMDb

const movieCache = new Map(); // TMDb detail cache

let cachedTasteModel       = null;
let cachedOverlapDetails   = null;
let cachedRecommendations  = null;
let cachedRewatchRanking   = null;

// ─── Paths ────────────────────────────────────────────────────────────────────
// When running under Electron, TM_DATA_DIR and TM_CACHE_DIR point to
// the user's app-data folder. In plain-node mode they fall back to ./data and ./cache.
const DATA_DIR              = process.env.TM_DATA_DIR  || path.join(__dirname, 'data');
const CACHE_DIR             = process.env.TM_CACHE_DIR || path.join(__dirname, 'cache');
const TMDB_CACHE_FILE       = path.join(CACHE_DIR, 'tmdb_cache.json');
const DERIVED_CACHE_FILE    = path.join(CACHE_DIR, 'derived_cache.json');
const STATE_FILE            = path.join(CACHE_DIR, 'data_state.json');
const HIDDEN_REWATCHES_FILE = path.join(CACHE_DIR, 'hidden_rewatches.json');
const USER_WEIGHTS_FILE     = path.join(CACHE_DIR, 'user_weights.json');

// ─── Default scoring weights (must sum to 1.00) ───────────────────────────────
const DEFAULT_WEIGHTS = {
  genre:      0.18,
  keyword:    0.22,
  director:   0.10,
  writer:     0.08,
  tmdb:       0.15,
  neighbour:  0.10,
  geo:        0.07,
  decade:     0.05,
  collection: 0.05
};

// Active weights (may be overridden by user priority ranking)
let activeWeights = { ...DEFAULT_WEIGHTS };

let hiddenRewatches = new Set();

// ─── User weight persistence ──────────────────────────────────────────────────

function loadUserWeightsFromDisk() {
  try {
    if (!fs.existsSync(USER_WEIGHTS_FILE)) return;
    const obj = JSON.parse(fs.readFileSync(USER_WEIGHTS_FILE, 'utf-8'));
    if (obj && typeof obj === 'object') {
      activeWeights = { ...DEFAULT_WEIGHTS, ...obj };
      console.log('User weights loaded from disk.');
    }
  } catch (e) { console.warn('Failed to load user weights:', e.message); }
}

function saveUserWeightsToDisk() {
  ensureCacheDir();
  try {
    fs.writeFileSync(USER_WEIGHTS_FILE, JSON.stringify(activeWeights, null, 2), 'utf-8');
  } catch (e) { console.warn('Failed to save user weights:', e.message); }
}

/**
 * Given a priority ranking (array of dimension keys, highest priority first),
 * redistribute weights using a geometric decay so rank 1 gets the most weight.
 */
function weightsFromPriorityRanking(ranking) {
  const decay = 0.75;
  const raw = ranking.map((_, i) => Math.pow(decay, i));
  const total = raw.reduce((s, v) => s + v, 0);
  const weights = {};
  ranking.forEach((key, i) => { weights[key] = parseFloat((raw[i] / total).toFixed(4)); });
  // Fix rounding: add any residual to the top-ranked key
  const sum = Object.values(weights).reduce((s, v) => s + v, 0);
  const residual = parseFloat((1 - sum).toFixed(4));
  if (residual !== 0) weights[ranking[0]] = parseFloat((weights[ranking[0]] + residual).toFixed(4));
  return weights;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeUrl(u) {
  if (!u) return '';
  return String(u).toLowerCase().replace(/\/+$/, '').trim();
}

function titleKey(title, year) {
  return `${(title || '').toLowerCase().trim()}|${year ?? ''}`;
}

// ─── Persistence ──────────────────────────────────────────────────────────────

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function loadHiddenRewatches() {
  ensureCacheDir();
  if (!fs.existsSync(HIDDEN_REWATCHES_FILE)) return;
  try {
    hiddenRewatches = new Set(JSON.parse(fs.readFileSync(HIDDEN_REWATCHES_FILE, 'utf8')));
    console.log(`Loaded ${hiddenRewatches.size} hidden rewatches.`);
  } catch (e) { console.warn('Failed to load hidden rewatches:', e.message); }
}

function saveHiddenRewatches() {
  ensureCacheDir();
  try { fs.writeFileSync(HIDDEN_REWATCHES_FILE, JSON.stringify([...hiddenRewatches], null, 2)); }
  catch (e) { console.warn('Failed to save hidden rewatches:', e.message); }
}

function loadMovieCacheFromDisk() {
  ensureCacheDir();
  if (!fs.existsSync(TMDB_CACHE_FILE)) return;
  try {
    const obj = JSON.parse(fs.readFileSync(TMDB_CACHE_FILE, 'utf-8'));
    Object.keys(obj).forEach(k => movieCache.set(k, obj[k]));
    console.log(`TMDb cache: ${movieCache.size} entries loaded.`);
  } catch (e) { console.warn('Failed to load TMDb cache:', e.message); }
}

function saveMovieCacheToDisk() {
  ensureCacheDir();
  try {
    const obj = {};
    for (const [k, v] of movieCache.entries()) obj[k] = v;
    fs.writeFileSync(TMDB_CACHE_FILE, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (e) { console.warn('Failed to save TMDb cache:', e.message); }
}

function loadDerivedCacheFromDisk() {
  ensureCacheDir();
  if (!fs.existsSync(DERIVED_CACHE_FILE)) return;
  try {
    const obj = JSON.parse(fs.readFileSync(DERIVED_CACHE_FILE, 'utf-8'));
    // Invalidate old cache format that's missing ratedItemsMeta
    cachedTasteModel       = (obj.tasteModel?.ratedItemsMeta) ? obj.tasteModel : null;
    cachedOverlapDetails   = obj.overlapDetails   || null;
    cachedRecommendations  = obj.recommendations  || null;
    cachedRewatchRanking   = obj.rewatchRanking   || null;
    console.log('Derived caches loaded from disk.');
  } catch (e) { console.warn('Failed to load derived cache:', e.message); }
}

function saveDerivedCacheToDisk() {
  ensureCacheDir();
  try {
    fs.writeFileSync(DERIVED_CACHE_FILE, JSON.stringify({
      tasteModel:      cachedTasteModel,
      overlapDetails:  cachedOverlapDetails,
      recommendations: cachedRecommendations,
      rewatchRanking:  cachedRewatchRanking
    }, null, 2), 'utf-8');
  } catch (e) { console.warn('Failed to save derived cache:', e.message); }
}

function loadDataStateFromDisk() {
  ensureCacheDir();
  if (!fs.existsSync(STATE_FILE)) return false;
  try {
    const obj = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    if (!obj?.ratings || !obj?.watchlist || !obj?.overlapItems) return false;
    ratings = obj.ratings; watchlist = obj.watchlist; overlapItems = obj.overlapItems;
    console.log(`State: ${ratings.length} ratings, ${watchlist.length} watchlist, ${overlapItems.length} rewatches.`);
    return true;
  } catch (e) { console.warn('Failed to load state:', e.message); return false; }
}

function saveDataStateToDisk() {
  ensureCacheDir();
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ratings, watchlist, overlapItems }, null, 2), 'utf-8');
  } catch (e) { console.warn('Failed to save state:', e.message); }
}

function invalidateAllDerivedCaches() {
  cachedTasteModel = null; cachedOverlapDetails = null;
  cachedRecommendations = null; cachedRewatchRanking = null;
  saveDerivedCacheToDisk();
}

function invalidateWatchlistCaches() {
  cachedOverlapDetails = null; cachedRecommendations = null;
  cachedRewatchRanking = null;
  saveDerivedCacheToDisk();
}

// ─── CSV Loaders ──────────────────────────────────────────────────────────────

function loadRatingsFromCsv() {
  const fp = path.join(DATA_DIR, 'ratings.csv');
  if (!fs.existsSync(fp)) { console.warn('⚠️  ratings.csv not found in', DATA_DIR); return []; }
  const records = parse(fs.readFileSync(fp, 'utf-8'), { columns: true, skip_empty_lines: true });
  const list = records.map(row => {
    const rating = parseFloat(row['Rating']);
    if (isNaN(rating)) return null;
    return { title: row['Name'], year: row['Year'] ? parseInt(row['Year'], 10) : null, rating, url: row['Letterboxd URI'] || null };
  }).filter(m => m?.title);
  console.log(`Ratings CSV: ${list.length} entries.`);
  return list;
}

function loadWatchlistFromCsv() {
  const fp = path.join(DATA_DIR, 'watchlist.csv');
  if (!fs.existsSync(fp)) { console.warn('⚠️  watchlist.csv not found in', DATA_DIR); return []; }
  const raw = fs.readFileSync(fp, 'utf-8');
  let records = null;

  try { records = parse(raw, { columns: true, skip_empty_lines: true }); } catch (e) {}

  if (!records?.length) {
    const lines = raw.split(/\r?\n/);
    let hi = -1, hp = -1;
    for (let i = 0; i < lines.length; i++) {
      const cells = lines[i].trim().split(',');
      const hasName = cells.some(c => /name|title/i.test(c));
      const hasUrl  = cells.some(c => /(url|uri|letterboxd)/i.test(c));
      const hasPos  = cells.some(c => /position/i.test(c));
      if (hasName && hasUrl) {
        const p = hasPos ? 2 : 1;
        if (p > hp) { hp = p; hi = i; }
      }
    }
    if (hi === -1) { console.warn('⚠️  Cannot detect watchlist header.'); return []; }
    try { records = parse(lines.slice(hi).join('\n'), { columns: true, skip_empty_lines: true }); } catch (e) { return []; }
  }

  if (!records?.length) return [];
  const header   = Object.keys(records[0]);
  const findCol  = pats => header.find(h => pats.some(re => re.test(h)));
  const titleCol = findCol([/name/i, /title/i]);
  const yearCol  = findCol([/year/i]);
  const urlCol   = findCol([/url/i, /uri/i, /letterboxd/i]);
  const posCol   = findCol([/position/i]);
  if (!titleCol) { console.warn('⚠️  No title column in watchlist.'); return []; }

  const list = records.map(row => {
    const title = String(row[titleCol] || '').trim();
    if (!title || /^letterboxd list export/i.test(title)) return null;
    if (posCol && row[posCol] && !/^\d+$/.test(String(row[posCol]).trim())) return null;
    const year = yearCol && row[yearCol] ? (parseInt(row[yearCol], 10) || null) : null;
    const url  = urlCol  && row[urlCol]  ? String(row[urlCol]).trim() : null;
    return { title, year, url };
  }).filter(Boolean);

  console.log(`Watchlist CSV: ${list.length} entries.`);
  return list;
}

// ─── FIX 1: Overlap detection using URL AND title+year fallback ───────────────

function computeOverlapAndClean(ratingList, watchList) {
  const byUrl   = new Map();
  const byTitle = new Map();

  ratingList.forEach(r => {
    const u = normalizeUrl(r.url);
    if (u  && !byUrl.has(u))               byUrl.set(u, r);
    const tk = titleKey(r.title, r.year);
    if (!byTitle.has(tk))                  byTitle.set(tk, r);
  });

  const overlapSet = new Set();
  const overlap    = [];

  watchList.forEach(w => {
    const u  = normalizeUrl(w.url);
    const tk = titleKey(w.title, w.year);
    let rated = (u && byUrl.get(u)) || byTitle.get(tk);
    if (!rated) return;

    const key = u || tk;
    if (overlapSet.has(key)) return;
    overlapSet.add(key);

    overlap.push({ url: rated.url || w.url, title: rated.title || w.title, year: rated.year ?? w.year ?? null, rating: rated.rating, tmdbId: rated.tmdbId || null });
  });

  const cleaned = watchList.filter(w => {
    const u  = normalizeUrl(w.url);
    const tk = titleKey(w.title, w.year);
    return !(u && overlapSet.has(u)) && !overlapSet.has(tk);
  });

  console.log(`Overlap: ${overlap.length}. Watchlist: ${cleaned.length}.`);
  return { cleanedWatchlist: cleaned, overlap };
}

function loadAllData() {
  if (loadDataStateFromDisk()) { console.log('Using persisted state.'); return; }
  const rawR = loadRatingsFromCsv();
  const rawW = loadWatchlistFromCsv();
  const { cleanedWatchlist, overlap } = computeOverlapAndClean(rawR, rawW);
  ratings = rawR; watchlist = cleanedWatchlist; overlapItems = overlap;
  invalidateAllDerivedCaches();
  saveDataStateToDisk();
}

function reloadWatchlistOnly() {
  const raw = loadWatchlistFromCsv();
  const { cleanedWatchlist, overlap } = computeOverlapAndClean(ratings, raw);
  watchlist = cleanedWatchlist; overlapItems = overlap;
  invalidateWatchlistCaches();
  saveDataStateToDisk();
}

function resetStateToCsv() {
  const rawR = loadRatingsFromCsv();
  const rawW = loadWatchlistFromCsv();
  const { cleanedWatchlist, overlap } = computeOverlapAndClean(rawR, rawW);
  ratings = rawR; watchlist = cleanedWatchlist; overlapItems = overlap;
  hiddenRewatches = new Set(); saveHiddenRewatches();
  invalidateAllDerivedCaches();
  saveDataStateToDisk();
}

// ─── Region mapping ───────────────────────────────────────────────────────────

function mapCountryToRegion(isoCode) {
  if (!isoCode) return 'Other';
  const code = isoCode.toUpperCase();
  const regions = {
    'Europe':        ['FR','DE','IT','ES','GB','UK','PL','SE','NO','DK','FI','NL','BE','CZ','RU','GR','IE','PT','HU','RO','BG','AT','CH','TR'],
    'Asia':          ['JP','CN','KR','IN','HK','TW','TH','VN','ID','MY','PH','SG','PK','BD','LK'],
    'North America': ['US','CA','MX'],
    'South America': ['BR','AR','CL','CO','PE','VE','UY','EC','BO','PY'],
    'Oceania':       ['AU','NZ'],
    'Africa':        ['ZA','NG','EG','MA','KE','GH','DZ','TN','ET']
  };
  for (const [r, codes] of Object.entries(regions)) if (codes.includes(code)) return r;
  return 'Other';
}

// ─── TMDb detail fetcher ──────────────────────────────────────────────────────

async function getMovieDetailsForItem(item) {
  if (!TMDB_API_KEY) throw new Error('TMDB_API_KEY missing');

  const idKey  = item.tmdbId ? `id_${item.tmdbId}` : null;
  const titleK = item.title  ? `${item.title}_${item.year ?? ''}`.toLowerCase() : null;

  if (idKey  && movieCache.has(idKey))           return movieCache.get(idKey);
  if (!idKey && titleK && movieCache.has(titleK)) return movieCache.get(titleK);

  const failKey = `${(item.title||'').toLowerCase()}|${item.year??''}`;
  if (failedItems.some(f => f._key === failKey)) {
    throw new Error(`Known unresolvable item: "${item.title}"`);
  }

  const buildMeta = async (detailUrl, creditsUrl, keywordsUrl, type, id) => {
    const [dR, cR, kR] = await Promise.all([
      axios.get(detailUrl,   { params: { api_key: TMDB_API_KEY, language: 'en-US' } }),
      axios.get(creditsUrl,  { params: { api_key: TMDB_API_KEY, language: 'en-US' } }).catch(() => ({ data: { cast:[], crew:[] } })),
      axios.get(keywordsUrl, { params: { api_key: TMDB_API_KEY } }).catch(() => ({ data: { keywords:[], results:[] } }))
    ]);

    const movie  = dR.data;
    movie.__type = type;

    const dateStr = movie.release_date || movie.first_air_date || '';
    let year = null, decade = null;
    if (dateStr.length >= 4) { year = parseInt(dateStr.slice(0,4), 10); if (!isNaN(year)) decade = Math.floor(year/10)*10; }

    const countries  = (movie.production_countries || []).map(c => ({ code: c.iso_3166_1, name: c.name, region: mapCountryToRegion(c.iso_3166_1) }));
    const crew       = (cR.data || {}).crew || [];
    const directors  = crew.filter(c => c.job === 'Director').map(c => c.name);
    const writers    = crew.filter(c => ['Writer','Screenplay','Screenwriter','Author','Story','Co-Writer'].includes(c.job)).map(c => c.name);
    const rawKw      = type === 'movie' ? (kR.data.keywords || []) : (kR.data.results || []);
    const keywords   = rawKw.map(k => k.name);
    const collection = movie.belongs_to_collection || null;

    movie.__meta = {
      id, type, year, decade, countries,
      collectionId:   collection?.id   || null,
      collectionName: collection?.name || null,
      directors, writers, keywords
    };

    movieCache.set(`id_${id}`, movie);
    if (titleK) movieCache.set(titleK, movie);
    saveMovieCacheToDisk();
    return movie;
  };

  if (item.tmdbId) {
    for (const t of ['movie','tv']) {
      try { return await buildMeta(`${TMDB_BASE_URL}/${t}/${item.tmdbId}`, `${TMDB_BASE_URL}/${t}/${item.tmdbId}/credits`, `${TMDB_BASE_URL}/${t}/${item.tmdbId}/keywords`, t, item.tmdbId); }
      catch (e) { /* next */ }
    }
    throw new Error(`No TMDb detail for id ${item.tmdbId}`);
  }

  // ─── Multi-strategy search ────────────────────────────────────────────────
  // Strategy 1: exact title + year (original behaviour)
  // Strategy 2: exact title, no year constraint (catches year-off-by-one issues)
  // Strategy 3: Letterboxd URL slug → extracted slug words (handles non-English titles
  //             like "Pather Panchali" whose TMDb canonical title includes Bengali script,
  //             and translated titles like "Guilty of Romance" / "Koi no tsumi")
  // Strategy 4: strip common subtitle suffixes and retry (e.g. "The Prestige" → already
  //             passes, but "Some Film: A Subtitle" → "Some Film")
  // Strategy 5: pick best result by year proximity when strict search returns nothing
  //             but a no-year search returns hits (handles off-by-one release year edge cases)

  const pickBestByYear = (results, year) => {
    if (!results || results.length === 0) return null;
    if (!year) return results[0];
    // prefer exact year match, fall back to ±1, then ±2, then first result
    for (const tolerance of [0, 1, 2, 3]) {
      const match = results.find(r => {
        const rYear = parseInt((r.release_date || r.first_air_date || '').slice(0, 4), 10);
        return !isNaN(rYear) && Math.abs(rYear - year) <= tolerance;
      });
      if (match) return match;
    }
    return results[0]; // last resort
  };

  const trySearchAndBuild = async (type, query, yearParam) => {
    const yp = type === 'movie' ? 'year' : 'first_air_date_year';
    const p = { api_key: TMDB_API_KEY, query };
    if (yearParam) p[yp] = yearParam;
    const resp = await axios.get(`${TMDB_BASE_URL}/search/${type}`, { params: p });
    const results = resp.data.results || [];
    const best = yearParam ? pickBestByYear(results, item.year) : results[0];
    if (!best) return null;
    return await buildMeta(
      `${TMDB_BASE_URL}/${type}/${best.id}`,
      `${TMDB_BASE_URL}/${type}/${best.id}/credits`,
      `${TMDB_BASE_URL}/${type}/${best.id}/keywords`,
      type, best.id
    );
  };

  // Extract a slug-based fallback query from the Letterboxd URL
  // e.g. https://letterboxd.com/film/pather-panchali/ → "pather panchali"
  const slugQuery = (() => {
    if (!item.url) return null;
    const m = item.url.match(/letterboxd\.com\/film\/([a-z0-9-]+)/i);
    if (!m) return null;
    const slug = m[1].replace(/-\d{4}$/, '').replace(/-/g, ' ').trim(); // strip trailing year
    return slug !== item.title?.toLowerCase().trim() ? slug : null;
  })();

  // Strip subtitle: "Some Title: A Subtitle" → "Some Title"
  const shortTitle = (() => {
    if (!item.title) return null;
    const stripped = item.title.replace(/\s*[:\u2013\u2014].+$/, '').trim();
    return stripped.length > 0 && stripped !== item.title ? stripped : null;
  })();

  // Punctuation-stripped title: removes commas, dots, apostrophes that confuse TMDb search
  // e.g. "Go, Go Second Time Virgin" → "Go Go Second Time Virgin"
  const cleanTitle = (() => {
    if (!item.title) return null;
    const stripped = item.title.replace(/[,.'"\u2018\u2019\u201C\u201D!?]/g, '').replace(/\s+/g, ' ').trim();
    return stripped !== item.title ? stripped : null;
  })();

  // Keyword-reduced query: drop leading short/common words (≤3 chars) or duplicate words
  // to expose the distinctive tail of the title to TMDB search.
  // e.g. "Go, Go Second Time Virgin" → "Second Time Virgin"
  // This handles titles where TMDB's search index chokes on repeated/punctuated leading words.
  const keywordQuery = (() => {
    if (!item.title) return null;
    const base = (cleanTitle || item.title).replace(/[,.'"'\u2018\u2019\u201C\u201D!?]/g, '');
    const words = base.split(/\s+/).filter(Boolean);
    let start = 0;
    while (start < words.length - 2) {
      const w = words[start].toLowerCase();
      const prev = start > 0 ? words[start - 1].toLowerCase() : null;
      if (w.length <= 3 || w === prev) { start++; } else { break; }
    }
    if (start === 0) return null;
    const kq = words.slice(start).join(' ').trim();
    return kq.length >= 3 ? kq : null;
  })();

  for (const type of ['movie', 'tv']) {
    // Strategy 1: title + year (strict)
    try { const r = await trySearchAndBuild(type, item.title, item.year); if (r) return r; } catch (_) {}

    // Strategy 2: title, no year
    try { const r = await trySearchAndBuild(type, item.title, null); if (r) return r; } catch (_) {}

    // Strategy 3: slug-derived query + year
    if (slugQuery) {
      try { const r = await trySearchAndBuild(type, slugQuery, item.year); if (r) return r; } catch (_) {}
      try { const r = await trySearchAndBuild(type, slugQuery, null);      if (r) return r; } catch (_) {}
    }

    // Strategy 4: stripped short title + year
    if (shortTitle) {
      try { const r = await trySearchAndBuild(type, shortTitle, item.year); if (r) return r; } catch (_) {}
      try { const r = await trySearchAndBuild(type, shortTitle, null);      if (r) return r; } catch (_) {}
    }

    // Strategy 5: punctuation-cleaned title (handles commas, apostrophes tripping search)
    if (cleanTitle) {
      try { const r = await trySearchAndBuild(type, cleanTitle, item.year); if (r) return r; } catch (_) {}
      try { const r = await trySearchAndBuild(type, cleanTitle, null);      if (r) return r; } catch (_) {}
    }

    // Strategy 6: keyword-reduced query — drop leading short/repeated words, search the
    // distinctive tail. Handles "Go, Go Second Time Virgin" → "Second Time Virgin",
    // where TMDB search returns 0 results on the full title but finds it on the tail.
    if (keywordQuery) {
      try { const r = await trySearchAndBuild(type, keywordQuery, item.year); if (r) return r; } catch (_) {}
      try { const r = await trySearchAndBuild(type, keywordQuery, null);      if (r) return r; } catch (_) {}
    }
  }

  // Record this item as unresolvable so the UI can show it
  if (!failedItems.some(f => f._key === failKey)) {
    failedItems.push({ _key: failKey, title: item.title, year: item.year, url: item.url || null, source: item._source || 'unknown' });
  }
  throw new Error(`No TMDb result for "${item.title}" (${item.year ?? '?'})`);
}

function extractTmdbId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const m = s.match(/themoviedb\.org\/(movie|tv)\/(\d+)/i);
  return m ? parseInt(m[2], 10) : null;
}

async function resolveTitleYearFromTmdb(tmdbInput) {
  const id = extractTmdbId(tmdbInput);
  if (!id || !TMDB_API_KEY) return null;
  for (const t of ['movie','tv']) {
    try {
      const { data: m } = await axios.get(`${TMDB_BASE_URL}/${t}/${id}`, { params: { api_key: TMDB_API_KEY, language: 'en-US' } });
      const rawDate = m.release_date || m.first_air_date || '';
      const year = rawDate.length >= 4 ? (parseInt(rawDate.slice(0,4), 10) || null) : null;
      return { title: m.title || m.name, year, tmdbId: id, tmdbType: t };
    } catch (e) { /* next */ }
  }
  return null;
}

// ─── Scoring utilities ────────────────────────────────────────────────────────

function normalizeUserRating(r) { return isNaN(r) || !r ? 0 : Math.max(0, Math.min(1, r / 5)); }
function normalizeTmdbRating(r) { return isNaN(r) || !r ? 0 : Math.max(0, Math.min(1, r / 10)); }

// Reliability-weighted affinity: keys with few observations count less
function affinityFromProfile(keys, profile, stats, smoothK = 3) {
  if (!keys?.length) return 0;
  let sum = 0, wSum = 0;
  keys.forEach(k => {
    const val  = profile[String(k)];
    if (val === undefined) return;
    const n = stats?.[String(k)]?.count ?? 0;
    const w = smoothK > 0 ? n / (n + smoothK) : 1;
    if (w <= 0) return;
    sum += val * w; wSum += w;
  });
  return wSum > 0 ? sum / wSum : 0;
}

// ─── Taste model ──────────────────────────────────────────────────────────────

async function buildTasteModel() {
  if (cachedTasteModel) return cachedTasteModel;

  const emptyModel = () => ({
    usedRatings: 0, globalMean: 3.0,
    genreStats:{}, genreProfile:{}, directorStats:{}, directorProfile:{},
    writerStats:{}, writerProfile:{}, countryStats:{}, countryProfile:{},
    regionStats:{}, regionProfile:{}, decadeStats:{}, decadeProfile:{},
    keywordStats:{}, keywordProfile:{}, collectionStats:{}, collectionProfile:{},
    ratedItemsMeta:[]
  });

  if (!ratings.length) {
    cachedTasteModel = emptyModel();
    saveDerivedCacheToDisk();
    return cachedTasteModel;
  }

  console.log(`Building taste model from ${ratings.length} ratings…`);

  const globalMean = ratings.reduce((s, r) => s + (r.rating || 0), 0) / ratings.length;
  const SMOOTH_K = 5;

  const gs={}, ds={}, ws={}, cs={}, rs={}, dec={}, ks={}, cols={};
  const meta = [];

  for (const item of ratings) {
    if (!item.rating) continue;
    try {
      const movie = await getMovieDetailsForItem(item);
      const m     = movie.__meta || {};
      const genres = movie.genres || [];
      const r = item.rating;

      genres.forEach(g => {
        if (!gs[g.id]) gs[g.id] = { name: g.name, totalRating:0, count:0 };
        gs[g.id].totalRating += r; gs[g.id].count++;
      });
      (m.directors || []).forEach(n => { if (!ds[n]) ds[n]={totalRating:0,count:0}; ds[n].totalRating+=r; ds[n].count++; });
      (m.writers   || []).forEach(n => { if (!ws[n]) ws[n]={totalRating:0,count:0}; ws[n].totalRating+=r; ws[n].count++; });
      (m.countries || []).forEach(c => {
        if (c.code) { if (!cs[c.code]) cs[c.code]={name:c.name,totalRating:0,count:0}; cs[c.code].totalRating+=r; cs[c.code].count++; }
        const reg = c.region||'Other'; if (!rs[reg]) rs[reg]={totalRating:0,count:0}; rs[reg].totalRating+=r; rs[reg].count++;
      });
      if (m.decade != null) { const d=m.decade; if (!dec[d]) dec[d]={totalRating:0,count:0}; dec[d].totalRating+=r; dec[d].count++; }
      (m.keywords || []).forEach(k => { const key=k.toLowerCase(); if (!ks[key]) ks[key]={totalRating:0,count:0}; ks[key].totalRating+=r; ks[key].count++; });
      if (m.collectionId) { const cid=m.collectionId; if (!cols[cid]) cols[cid]={name:m.collectionName||`#${cid}`,totalRating:0,count:0}; cols[cid].totalRating+=r; cols[cid].count++; }

      meta.push({ tmdbId: movie.id, title: movie.title||movie.name, year: m.year, decade: m.decade, genres: genres.map(g=>g.id), keywords: (m.keywords||[]).map(k=>k.toLowerCase()), directors: m.directors||[], regions: (m.countries||[]).map(c=>c.region), rating: r });
    } catch (e) { console.warn(`Taste model: skip "${item.title}": ${e.message}`); }
  }

  const buildProfile = statsObj => {
    const p = {};
    Object.keys(statsObj).forEach(k => { const s=statsObj[k]; p[k] = (s.totalRating + globalMean*SMOOTH_K) / (s.count + SMOOTH_K); });
    return p;
  };

  cachedTasteModel = {
    usedRatings: ratings.length, globalMean,
    genreStats:gs,      genreProfile:     buildProfile(gs),
    directorStats:ds,   directorProfile:  buildProfile(ds),
    writerStats:ws,     writerProfile:    buildProfile(ws),
    countryStats:cs,    countryProfile:   buildProfile(cs),
    regionStats:rs,     regionProfile:    buildProfile(rs),
    decadeStats:dec,    decadeProfile:    buildProfile(dec),
    keywordStats:ks,    keywordProfile:   buildProfile(ks),
    collectionStats:cols,collectionProfile:buildProfile(cols),
    ratedItemsMeta: meta
  };

  saveDerivedCacheToDisk();
  return cachedTasteModel;
}

// ─── Neighbour similarity ─────────────────────────────────────────────────────

function jaccardSim(a, b) {
  if (!a?.length || !b?.length) return 0;
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  A.forEach(v => { if (B.has(v)) inter++; });
  const union = A.size + B.size - inter;
  return union > 0 ? inter / union : 0;
}

function filmSim(cand, rated) {
  const genre   = jaccardSim(cand.genres,    rated.genres);
  const keyword = jaccardSim(cand.keywords,  rated.keywords);
  const mood    = 0.65*genre + 0.35*keyword;
  const region  = jaccardSim(cand.regions,   rated.regions);
  const dir     = (cand.directors||[]).some(d=>(rated.directors||[]).includes(d)) ? 1 : 0;
  let era = 0;
  if (cand.decade && rated.decade) {
    const diff = Math.abs(cand.decade - rated.decade);
    era = diff===0 ? 1 : diff===10 ? 0.5 : 0;
  }
  return Math.max(0, Math.min(1, 0.50*mood + 0.20*region + 0.15*era + 0.15*dir));
}

function neighborComponent(candMeta, ratedMeta) {
  if (!ratedMeta?.length) return 0;
  const sims = ratedMeta
    .filter(r => !(candMeta.tmdbId && r.tmdbId && candMeta.tmdbId===r.tmdbId))
    .map(r => ({ sim: filmSim(candMeta, r), rating: r.rating }))
    .filter(n => n.sim > 0.12)
    .sort((a,b) => b.sim-a.sim)
    .slice(0, 30);
  if (!sims.length) return 0;
  const simSum = sims.reduce((s,n)=>s+n.sim, 0);
  const wRating = sims.reduce((s,n)=>s+n.sim*n.rating, 0) / simSum;
  return normalizeUserRating(wRating) * Math.min(1, sims.length/8);
}

// ─── FIX 2: Single shared scoring function used everywhere ───────────────────

function scoreItem(movie, taste) {
  const m   = movie.__meta || {};
  const { genreProfile, genreStats, directorProfile, directorStats,
          writerProfile, writerStats, countryProfile, countryStats,
          regionProfile, regionStats, decadeProfile, decadeStats,
          keywordProfile, keywordStats, collectionProfile, collectionStats,
          ratedItemsMeta } = taste;

  const genreIds    = (movie.genres||[]).map(g=>g.id);
  const directors   = m.directors||[];
  const writers     = m.writers||[];
  const countries   = (m.countries||[]).map(c=>c.code).filter(Boolean);
  const regions     = (m.countries||[]).map(c=>c.region).filter(Boolean);
  const keywords    = (m.keywords||[]).map(k=>k.toLowerCase());
  const decadeKey   = m.decade!=null ? String(m.decade) : null;

  const genreAff   = normalizeUserRating(affinityFromProfile(genreIds,  genreProfile,    genreStats,    3));
  const dirAff     = normalizeUserRating(affinityFromProfile(directors, directorProfile, directorStats, 3));
  const writerAff  = normalizeUserRating(affinityFromProfile(writers,   writerProfile,   writerStats,   3));
  const countryAff = normalizeUserRating(affinityFromProfile(countries, countryProfile,  countryStats,  3));
  const regionAff  = normalizeUserRating(affinityFromProfile(regions,   regionProfile,   regionStats,   3));
  const geoAff     = (countryAff + regionAff) / 2;
  const decadeAff  = decadeKey ? normalizeUserRating(affinityFromProfile([decadeKey], decadeProfile, decadeStats, 4)) : 0;
  const kwAff      = normalizeUserRating(affinityFromProfile(keywords,  keywordProfile,  keywordStats,  3));
  const collAff    = m.collectionId ? normalizeUserRating(affinityFromProfile([m.collectionId], collectionProfile, collectionStats, 2)) : 0;
  const tmdbNorm   = normalizeTmdbRating(movie.vote_average||0);

  const candMeta = { tmdbId: movie.id, genres: genreIds, keywords, directors, decade: m.decade, regions };
  const neighbor  = neighborComponent(candMeta, ratedItemsMeta);

  // Weights use activeWeights (user-customisable; default sums to 1.00)
  const w = activeWeights;
  const score =
    w.genre      * genreAff  +
    w.director   * dirAff    +
    w.writer     * writerAff +
    w.keyword    * kwAff     +
    w.geo        * geoAff    +
    w.decade     * decadeAff +
    w.collection * collAff   +
    w.tmdb       * tmdbNorm  +
    w.neighbour  * neighbor;

  return {
    genreAff, dirAff, writerAff, geoAff, decadeAff,
    kwAff, collAff, tmdbNorm, neighbor,
    predictedScore: Number(score.toFixed(4)),
    directors,
    hasWatchedDirector: directors.some(d => directorProfile[d] !== undefined)
  };
}

// ─── Overlap details ──────────────────────────────────────────────────────────

async function buildOverlapDetails() {
  if (cachedOverlapDetails) return cachedOverlapDetails;
  const out = [];
  for (const item of overlapItems) {
    try {
      const movie = await getMovieDetailsForItem(item);
      out.push({ title: movie.title||movie.name, year: (movie.release_date||movie.first_air_date||'').slice(0,4)||null, tmdbId: movie.id, posterPath: movie.poster_path, genres: (movie.genres||[]).map(g=>g.name), tmdbRating: movie.vote_average, userRating: item.rating, letterboxdUrl: item.url });
    } catch (e) { console.warn(`Overlap: skip "${item.title}": ${e.message}`); }
  }
  cachedOverlapDetails = out;
  saveDerivedCacheToDisk();
  return out;
}

// ─── Recommendations ──────────────────────────────────────────────────────────

async function calculateRecommendations() {
  if (cachedRecommendations) return cachedRecommendations;
  if (!ratings.length || !watchlist.length) {
    cachedRecommendations = { recommendations:[], usedRatings:0, usedWatchlist:0 };
    saveDerivedCacheToDisk();
    return cachedRecommendations;
  }

  const taste = await buildTasteModel();
  console.log(`Scoring ${watchlist.length} watchlist items…`);

  const recs = [];
  for (const item of watchlist) {
    try {
      const movie  = await getMovieDetailsForItem(item);
      const s      = scoreItem(movie, taste);
      recs.push({
        title: movie.title||movie.name,
        year: (movie.release_date||movie.first_air_date||'').slice(0,4)||null,
        tmdbId: movie.id, posterPath: movie.poster_path,
        genres: (movie.genres||[]).map(g=>g.name),
        tmdbRating: movie.vote_average, overview: movie.overview,
        letterboxdUrl: item.url,
        directors: s.directors, hasWatchedDirector: s.hasWatchedDirector,
        predictedScore: s.predictedScore,
        breakdown: { genre: +s.genreAff.toFixed(3), director: +s.dirAff.toFixed(3), writer: +s.writerAff.toFixed(3), keyword: +s.kwAff.toFixed(3), geography: +s.geoAff.toFixed(3), decade: +s.decadeAff.toFixed(3), collection: +s.collAff.toFixed(3), tmdb: +s.tmdbNorm.toFixed(3), neighbor: +s.neighbor.toFixed(3) }
      });
    } catch (e) { console.warn(`Rec: skip "${item.title}": ${e.message}`); }
  }

  recs.sort((a,b) => b.predictedScore - a.predictedScore);
  cachedRecommendations = { recommendations: recs, usedRatings: ratings.length, usedWatchlist: watchlist.length };
  saveDerivedCacheToDisk();
  return cachedRecommendations;
}

// ─── FIX 3: Rewatch ranking — rating is the anchor, model is a modifier ───────
// rewatchScore = userRatingNorm × (0.70 + 0.30 × modelScore)
// •  5★ film that model also loves  → up to 1.00
// •  5★ film model disagrees with   → 0.70 (still high, but correctly penalised)
// •  2★ film model loves            → max ~0.50 (can't sneak above 3★ rated films)
// This preserves user taste while allowing slight model-driven reordering.

async function calculateRewatchRanking() {
  if (cachedRewatchRanking) return cachedRewatchRanking;
  if (!overlapItems.length) {
    cachedRewatchRanking = { rewatchRecommendations:[], usedRatings: ratings.length, count:0 };
    saveDerivedCacheToDisk();
    return cachedRewatchRanking;
  }

  const taste = await buildTasteModel();
  console.log(`Rewatch ranking for ${overlapItems.length} items…`);

  const recs = [];
  for (const item of overlapItems) {
    if (hiddenRewatches.has(normalizeUrl(item.url))) continue;
    try {
      const movie  = await getMovieDetailsForItem(item);
      const s      = scoreItem(movie, taste);
      const urNorm = normalizeUserRating(item.rating || 0);
      // Rating is the anchor; model nudges up or down by ±30%
      const rewatchScore = urNorm * (0.70 + 0.30 * s.predictedScore);

      recs.push({
        title: movie.title||movie.name,
        year: (movie.release_date||movie.first_air_date||'').slice(0,4)||null,
        tmdbId: movie.id, posterPath: movie.poster_path,
        genres: (movie.genres||[]).map(g=>g.name),
        tmdbRating: movie.vote_average, overview: movie.overview,
        letterboxdUrl: item.url,
        userRating: +( item.rating||0).toFixed(1),
        rewatchScore: +rewatchScore.toFixed(4),
        modelScore:   s.predictedScore,
        breakdown: { genre: +s.genreAff.toFixed(3), director: +s.dirAff.toFixed(3), keyword: +s.kwAff.toFixed(3), geography: +s.geoAff.toFixed(3), decade: +s.decadeAff.toFixed(3), tmdb: +s.tmdbNorm.toFixed(3), neighbor: +s.neighbor.toFixed(3) }
      });
    } catch (e) { console.warn(`Rewatch: skip "${item.title}": ${e.message}`); }
  }

  recs.sort((a,b) => b.rewatchScore - a.rewatchScore);
  cachedRewatchRanking = { rewatchRecommendations: recs, usedRatings: ratings.length, count: overlapItems.length };
  saveDerivedCacheToDisk();
  return cachedRewatchRanking;
}

// ─── Express setup ────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/api', (_, res) => res.json({ message: 'Taste Matcher v2', endpoints: [ 'GET /api/ratings', 'GET /api/watchlist', 'GET /api/overlap', 'GET /api/genre-profile', 'GET /api/genre-titles/:genreId', 'GET /api/recommendations', 'GET /api/rewatch-ranking', 'GET /api/export-ranked-watchlist?includeRewatches=true|false', 'POST /api/reload-watchlist', 'POST /api/reset-state', 'POST /api/mark-watched', 'POST /api/add-rating', 'POST /api/add-to-watchlist', 'POST /api/remove-from-watchlist', 'POST /api/hide-rewatch' ] }));

app.get('/api/ratings',   (_, res) => res.json(ratings));
app.get('/api/watchlist', (_, res) => res.json(watchlist));

// ─── Universal search across rated films ─────────────────────────────────────
app.get('/api/search-ratings', async (req, res) => {
  try {
    const q   = String(req.query.q || '').toLowerCase().trim();
    const all = req.query.all === 'true';
    if (!q && !all) return res.json({ items: [] });

    const matchedItems = [];
    for (const item of ratings) {
      if (all || (item.title || '').toLowerCase().includes(q)) {
        matchedItems.push(item);
        if (!all && matchedItems.length >= 30) break;
      }
    }

    const results = await Promise.all(matchedItems.map(async (item) => {
      try {
        const movie = await getMovieDetailsForItem(item);
        return {
          title: movie.title || movie.name,
          year: (movie.release_date || movie.first_air_date || '').slice(0, 4) || item.year,
          tmdbId: movie.id,
          posterPath: movie.poster_path,
          genres: (movie.genres || []).map(g => g.name),
          tmdbRating: movie.vote_average,
          userRating: item.rating,
          letterboxdUrl: item.url
        };
      } catch {
        return {
          title: item.title, year: item.year, tmdbId: null,
          posterPath: null, genres: [], tmdbRating: null,
          userRating: item.rating, letterboxdUrl: item.url
        };
      }
    }));

    res.json({ count: results.length, items: results });
  } catch (e) { res.status(500).json({ error: 'Search failed.' }); }
});

// ─── Failed / unresolved items ────────────────────────────────────────────────
app.get('/api/failed-items', (_, res) => {
  res.json({ count: failedItems.length, items: failedItems.map(f => ({ title: f.title, year: f.year, url: f.url, source: f.source })) });
});

// ─── TMDB key validation ──────────────────────────────────────────────────────
app.get('/api/validate-tmdb-key', async (req, res) => {
  const key = String(req.query.key || '').trim();
  if (!key) return res.json({ ok: false, error: 'No key provided' });
  try {
    const r = await axios.get(`${TMDB_BASE_URL}/configuration`, { params: { api_key: key }, timeout: 8000 });
    res.json({ ok: r.status === 200 });
  } catch (e) {
    const msg = e.response?.data?.status_message || e.message || 'Invalid key';
    res.json({ ok: false, error: msg });
  }
});

// ─── Settings info for the settings panel ────────────────────────────────────
app.get('/api/app-status', (_, res) => {
  res.json({
    ratingsCount: ratings.length,
    watchlistCount: watchlist.length,
    overlapCount: overlapItems.length,
    failedCount: failedItems.length,
    tmdbKeySet: !!TMDB_API_KEY
  });
});

app.post('/api/reload-watchlist', (req, res) => {
  try { reloadWatchlistOnly(); res.json({ ok:true, ratingsCount: ratings.length, watchlistCount: watchlist.length, overlapCount: overlapItems.length }); }
  catch (e) { res.status(500).json({ error: 'Failed to reload watchlist.' }); }
});

app.post('/api/reset-state', (req, res) => {
  try { resetStateToCsv(); res.json({ ok:true, ratingsCount: ratings.length, watchlistCount: watchlist.length, overlapCount: overlapItems.length }); }
  catch (e) { res.status(500).json({ error: 'Failed to reset state.' }); }
});

app.post('/api/invalidate-recommendations', (req, res) => {
  try {
    cachedRecommendations = null;
    cachedRewatchRanking  = null;
    saveDerivedCacheToDisk();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to invalidate.' }); }
});

// ─── User weight endpoints ────────────────────────────────────────────────────

app.get('/api/user-weights', (_, res) => {
  res.json({ weights: activeWeights, defaultWeights: DEFAULT_WEIGHTS });
});

app.post('/api/user-weights', (req, res) => {
  try {
    const { ranking } = req.body; // array of 9 dimension keys, highest priority first
    if (!Array.isArray(ranking) || ranking.length !== 9) {
      return res.status(400).json({ error: 'ranking must be an array of 9 dimension keys.' });
    }
    const validKeys = Object.keys(DEFAULT_WEIGHTS);
    if (!ranking.every(k => validKeys.includes(k))) {
      return res.status(400).json({ error: 'Unknown dimension key in ranking.' });
    }
    activeWeights = weightsFromPriorityRanking(ranking);
    saveUserWeightsToDisk();
    // Invalidate scored caches so the new weights take effect on next fetch
    cachedRecommendations = null;
    cachedRewatchRanking  = null;
    saveDerivedCacheToDisk();
    console.log('User weights updated:', JSON.stringify(activeWeights));
    res.json({ ok: true, weights: activeWeights });
  } catch (e) { res.status(500).json({ error: 'Failed to update weights.' }); }
});

app.post('/api/user-weights/reset', (_, res) => {
  try {
    activeWeights = { ...DEFAULT_WEIGHTS };
    saveUserWeightsToDisk();
    cachedRecommendations = null;
    cachedRewatchRanking  = null;
    saveDerivedCacheToDisk();
    res.json({ ok: true, weights: activeWeights });
  } catch (e) { res.status(500).json({ error: 'Failed to reset weights.' }); }
});

app.get('/api/overlap', async (req, res) => {
  try { const items = await buildOverlapDetails(); res.json({ count: overlapItems.length, totalRatings: ratings.length, totalWatchlistAfterRemoval: watchlist.length, items }); }
  catch (e) { res.status(500).json({ error: 'Failed to build overlap details' }); }
});

app.get('/api/genre-profile', async (req, res) => {
  try { res.json(await buildTasteModel()); }
  catch (e) { res.status(500).json({ error: 'Failed to build taste model' }); }
});

app.get('/api/genre-titles/:genreId', async (req, res) => {
  const genreId = parseInt(req.params.genreId, 10);
  if (isNaN(genreId)) return res.status(400).json({ error: 'Invalid genre id' });
  try {
    await buildTasteModel();
    const items = [];
    for (const item of ratings) {
      try {
        const movie = await getMovieDetailsForItem(item);
        if (!(movie.genres||[]).some(g=>g.id===genreId)) continue;
        items.push({ title: movie.title||movie.name, year: (movie.release_date||movie.first_air_date||'').slice(0,4)||null, tmdbId: movie.id, posterPath: movie.poster_path, genres: (movie.genres||[]).map(g=>g.name), tmdbRating: movie.vote_average, userRating: item.rating, letterboxdUrl: item.url });
      } catch (e) { /* skip */ }
    }
    res.json({ genreId, count: items.length, items });
  } catch (e) { res.status(500).json({ error: 'Failed to build genre titles' }); }
});

app.get('/api/recommendations', async (req, res) => {
  try {
    const { recommendations, usedRatings, usedWatchlist } = await calculateRecommendations();
    res.json({ totalRatings: ratings.length, totalWatchlist: watchlist.length, overlapCount: overlapItems.length, usedRatings, usedWatchlist, recommendations });
  } catch (e) { res.status(500).json({ error: 'Failed to calculate recommendations' }); }
});

app.get('/api/rewatch-ranking', async (req, res) => {
  try {
    const { rewatchRecommendations, usedRatings, count } = await calculateRewatchRanking();
    res.json({ count, usedRatings, totalRated: ratings.length, items: rewatchRecommendations });
  } catch (e) { res.status(500).json({ error: 'Failed to calculate rewatch ranking' }); }
});

// ─── FIX 4: Export — correct Letterboxd v7 format + stream as download ────────

app.get('/api/export-ranked-watchlist', async (req, res) => {
  try {
    const includeRewatches = String(req.query.includeRewatches||'false').toLowerCase() === 'true';
    const candidates = [...watchlist];
    if (includeRewatches) overlapItems.forEach(r => { if (!hiddenRewatches.has(normalizeUrl(r.url))) candidates.push(r); });
    if (!candidates.length) return res.status(400).json({ error: 'No items to export.' });

    const taste  = await buildTasteModel();
    const scored = [];

    for (const c of candidates) {
      try {
        const movie = await getMovieDetailsForItem(c);
        const s     = scoreItem(movie, taste);
        scored.push({ title: movie.title||movie.name, year: (movie.release_date||movie.first_air_date||'').slice(0,4)||'', letterboxdUrl: c.url||'', predictedScore: s.predictedScore });
      } catch (e) { console.warn(`Export: skip "${c.title}": ${e.message}`); }
    }

    if (!scored.length) return res.status(400).json({ error: 'No items scored.' });
    scored.sort((a,b) => b.predictedScore - a.predictedScore);

    const q    = s => `"${String(s||'').replace(/"/g,'""')}"`;
    const today = new Date().toISOString().slice(0,10);

    const lines = [
      'Letterboxd list export v7',
      'Date,Name,Tags,URL,Description',
      [today, q('Taste Matcher – Ranked Watchlist'), q('taste-matcher'), '', q('Ranked by Taste Matcher v2.')].join(','),
      '',
      'Position,Name,Year,URL,Description'
    ];

    scored.forEach((item, i) => {
      lines.push([i+1, q(item.title), item.year, q(item.letterboxdUrl), q(`Score: ${(item.predictedScore*100).toFixed(1)}%`)].join(','));
    });

    const csv = lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ranked-watchlist-${today}.csv"`);
    res.send(csv);
  } catch (e) {
    console.error('export error:', e.message);
    res.status(500).json({ error: 'Failed to export.' });
  }
});

// ─── Mutation endpoints ───────────────────────────────────────────────────────

app.post('/api/mark-watched', async (req, res) => {
  try {
    const { letterboxdUrl, rating, title, year } = req.body || {};
    if (!letterboxdUrl || typeof rating !== 'number') return res.status(400).json({ error: 'letterboxdUrl and rating required.' });

    const uNorm = normalizeUrl(letterboxdUrl);
    const eW    = watchlist.find(x => normalizeUrl(x.url)===uNorm);
    const eR    = ratings.find(x   => normalizeUrl(x.url)===uNorm);

    const baseTitle  = title  || eR?.title  || eW?.title  || 'Unknown';
    const baseYear   = year   ?? eR?.year   ?? eW?.year   ?? null;
    const baseTmdbId = eR?.tmdbId || eW?.tmdbId || null;

    watchlist    = watchlist.filter(w    => normalizeUrl(w.url)!==uNorm);
    overlapItems = overlapItems.filter(o => normalizeUrl(o.url)!==uNorm);

    if (eR) { eR.rating = rating; }
    else     { ratings.push({ title: baseTitle, year: baseYear, url: letterboxdUrl, rating, tmdbId: baseTmdbId }); }

    invalidateAllDerivedCaches();
    saveDataStateToDisk();
    res.json({ ok: true });
  } catch (e) { console.error('mark-watched:', e.message); res.status(500).json({ error: 'Failed to mark watched.' }); }
});

// ─── FIX 5: add-rating — update existing and remove from failedItems ──────────

app.post('/api/add-rating', async (req, res) => {
  try {
    let { title, year, letterboxdUrl, rating, tmdbInput, fromResolved } = req.body || {};
    let tmdbId = null;

    if (!title && !tmdbInput) return res.status(400).json({ error: 'title or tmdbInput required.' });
    if (typeof rating !== 'number') return res.status(400).json({ error: 'Numeric rating required.' });

    if (tmdbInput) {
      const resolved = await resolveTitleYearFromTmdb(tmdbInput);
      if (resolved?.title) { title = resolved.title; year = resolved.year; tmdbId = resolved.tmdbId; }
    }
    if (!title) return res.status(400).json({ error: 'Could not resolve title.' });

    const uNorm  = normalizeUrl(letterboxdUrl);
    const yearInt = year != null ? parseInt(year, 10) : null;
    const tk     = titleKey(title, yearInt);
    const tid    = tmdbId ? parseInt(tmdbId, 10) : null;

    const existing = ratings.find(r =>
      (uNorm && normalizeUrl(r.url)===uNorm) ||
      titleKey(r.title, r.year)===tk ||
      (tid && r.tmdbId && r.tmdbId===tid)
    );

    if (existing) {
      // If not coming from unresolved-film resolution, warn the user
      if (!fromResolved) {
        return res.status(409).json({ error: 'You have already rated this film.', alreadyRated: true });
      }
      existing.rating = rating;
      if (tid) existing.tmdbId = tid;
      if (uNorm) existing.url = letterboxdUrl;
    } else {
      ratings.push({ title, year: yearInt, url: letterboxdUrl||null, rating, tmdbId: tid });
    }

    failedItems = failedItems.filter(f => titleKey(f.title, f.year) !== tk && (!uNorm || normalizeUrl(f.url) !== uNorm));

    invalidateAllDerivedCaches();
    saveDataStateToDisk();
    res.json({ ok: true });
  } catch (e) { console.error('add-rating:', e.message); res.status(500).json({ error: 'Failed to add rating.' }); }
});

// ─── update-rating — change an existing rating ───────────────────────────────

app.post('/api/update-rating', async (req, res) => {
  try {
    const { letterboxdUrl, title, year, rating } = req.body || {};
    if (typeof rating !== 'number' || rating < 0.5 || rating > 5) {
      return res.status(400).json({ error: 'Valid numeric rating (0.5–5) required.' });
    }
    const uNorm  = normalizeUrl(letterboxdUrl);
    const yearInt = year != null ? parseInt(year, 10) : null;
    const tk     = titleKey(title, yearInt);

    const existing = ratings.find(r =>
      (uNorm && normalizeUrl(r.url) === uNorm) ||
      titleKey(r.title, r.year) === tk
    );

    if (!existing) return res.status(404).json({ error: 'Film not found in your ratings.' });

    existing.rating = rating;
    invalidateAllDerivedCaches();
    saveDataStateToDisk();
    res.json({ ok: true, title: existing.title, newRating: rating });
  } catch (e) { console.error('update-rating:', e.message); res.status(500).json({ error: 'Failed to update rating.' }); }
});

// ─── FIX 6: add-to-watchlist — update existing and remove from failedItems ────

app.post('/api/add-to-watchlist', async (req, res) => {
  try {
    let { title, year, letterboxdUrl, tmdbInput, fromResolved } = req.body || {};
    let tmdbId = null;

    if (!title && !tmdbInput) return res.status(400).json({ error: 'title or tmdbInput required.' });
    if (!letterboxdUrl)       return res.status(400).json({ error: 'letterboxdUrl required.' });

    if (tmdbInput) {
      const resolved = await resolveTitleYearFromTmdb(tmdbInput);
      if (resolved?.title) { title = resolved.title; year = resolved.year; tmdbId = resolved.tmdbId; }
    }
    if (!title) return res.status(400).json({ error: 'Could not resolve title.' });

    const uNorm  = normalizeUrl(letterboxdUrl);
    const yearInt = year != null ? parseInt(year, 10) : null;
    const tk     = titleKey(title, yearInt);
    const tid    = tmdbId ? parseInt(tmdbId, 10) : null;

    const rated = ratings.find(r =>
      (uNorm && normalizeUrl(r.url)===uNorm) || titleKey(r.title,r.year)===tk || (tid && r.tmdbId && r.tmdbId===tid)
    );
    if (rated) {
      if (tid) rated.tmdbId = tid;
      if (uNorm) rated.url = letterboxdUrl;
      const inOL = overlapItems.find(o => normalizeUrl(o.url)===uNorm || titleKey(o.title,o.year)===tk);
      if (!inOL) {
        overlapItems.push({ url: letterboxdUrl, title: rated.title||title, year: rated.year??yearInt??null, rating: rated.rating, tmdbId: rated.tmdbId||tid||null });
      } else if (tid) {
        inOL.tmdbId = tid;
      }
      
      failedItems = failedItems.filter(f => titleKey(f.title, f.year) !== tk && (!uNorm || normalizeUrl(f.url) !== uNorm));
      invalidateWatchlistCaches();
      saveDataStateToDisk();
      return res.status(409).json({ error: 'Already rated – moved to rewatches.', rewatch: true });
    }

    const existingW = watchlist.find(w =>
      normalizeUrl(w.url)===uNorm || titleKey(w.title,w.year)===tk || (tid && w.tmdbId && w.tmdbId===tid)
    );
    if (existingW) {
      if (!fromResolved) {
        return res.status(409).json({ error: 'This film is already in your watchlist.', alreadyInWatchlist: true });
      }
      if (tid) existingW.tmdbId = tid;
      if (uNorm) existingW.url = letterboxdUrl;
    } else {
      watchlist.push({ title, year: yearInt, url: letterboxdUrl, tmdbId: tid });
    }

    failedItems = failedItems.filter(f => titleKey(f.title, f.year) !== tk && (!uNorm || normalizeUrl(f.url) !== uNorm));
    cachedRecommendations = null;
    saveDerivedCacheToDisk();
    saveDataStateToDisk();
    res.json({ ok: true });
  } catch (e) { console.error('add-to-watchlist:', e.message); res.status(500).json({ error: 'Failed to add to watchlist.' }); }
});

app.post('/api/hide-rewatch', (req, res) => {
  try {
    const { letterboxdUrl } = req.body || {};
    if (!letterboxdUrl) return res.status(400).json({ error: 'letterboxdUrl required.' });
    hiddenRewatches.add(normalizeUrl(letterboxdUrl));
    saveHiddenRewatches();
    cachedRewatchRanking = null;
    saveDerivedCacheToDisk();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to hide rewatch.' }); }
});

app.post('/api/remove-from-watchlist', (req, res) => {
  try {
    const { letterboxdUrl } = req.body || {};
    if (!letterboxdUrl) return res.status(400).json({ error: 'letterboxdUrl required.' });
    const uNorm  = normalizeUrl(letterboxdUrl);
    const before = watchlist.length;
    watchlist    = watchlist.filter(w => normalizeUrl(w.url)!==uNorm);
    if (watchlist.length===before) return res.status(404).json({ error: 'Not found in watchlist.' });
    cachedRecommendations = null;
    saveDerivedCacheToDisk();
    saveDataStateToDisk();
    res.json({ ok: true, removed: true });
  } catch (e) { res.status(500).json({ error: 'Failed to remove from watchlist.' }); }
});

// ─── Start ────────────────────────────────────────────────────────────────────

function startServer(port) {
  return new Promise((resolve, reject) => {
    loadMovieCacheFromDisk();
    loadDerivedCacheFromDisk();
    loadHiddenRewatches();
    loadUserWeightsFromDisk();
    loadAllData();
    app.listen(port, () => {
      console.log(`\n✅  Taste Matcher v2 → http://localhost:${port}`);
      resolve();
    }).on('error', reject);
  });
}

// If run directly via node (not required by Electron), start immediately
if (require.main === module) {
  startServer(PORT).catch(console.error);
}

module.exports = { startServer };

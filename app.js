/* ─── Constants ─────────────────────────────────────────────────────────────── */
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w342';

const defaultMessage = `
  <section class="hero">
    <div class="hero-badge">Taste Matcher · v2</div>
    <h2 class="hero-title">
      Turn your chaotic watchlist into a<br/>
      <span>perfectly ranked queue.</span>
    </h2>
    <p class="hero-subtitle">
      Built from your Letterboxd ratings + TMDb data. Use the actions above to explore:
    </p>
    <ul class="hero-list">
      <li><span>🎯</span><div><strong>Ranked Watchlist</strong><p>Every film in your watchlist ordered by predicted enjoyment.</p></div></li>
      <li><span>🔁</span><div><strong>Ranked Rewatches</strong><p>Films you've seen, sorted by rewatch-worthiness.</p></div></li>
      <li><span>📊</span><div><strong>Genre Profile</strong><p>Which genres you actually reward with the highest ratings.</p></div></li>
      <li><span>🔍</span><div><strong>Search Seen Films</strong><p>Universal search across every film you've rated.</p></div></li>
      <li><span>⚠️</span><div><strong>Unresolved Films</strong><p>Films the engine couldn't find on TMDb — add them manually.</p></div></li>
    </ul>
    <p class="hero-footer">Start with <strong>"Ranked Watchlist"</strong> to see what to watch tonight.</p>
  </section>
`;

/* ─── State ──────────────────────────────────────────────────────────────────── */
let allRecommendations = [];
let currentGenreTitles = [];
const isElectron = !!window.electronAPI;

// Track the current view to prevent late-resolving promises from overwriting the DOM
let currentViewId = 0;
function getNewViewId() { return ++currentViewId; }

/* ─── DOM helpers ────────────────────────────────────────────────────────────── */
function setOutput(html) { document.getElementById('output').innerHTML = html; }
function goHome()        { setOutput(defaultMessage); }

document.getElementById('backButton').addEventListener('click', goHome);

let isListView = false;
document.getElementById('toggleViewBtn').addEventListener('click', () => {
  isListView = !isListView;
  document.body.classList.toggle('view-mode-list', isListView);
  document.getElementById('toggleViewBtn').textContent = isListView ? '🖼 Card View' : '☷ List View';
});

/* ─── Settings drawer ────────────────────────────────────────────────────────── */
function openDrawer() {
  document.getElementById('settingsDrawer').classList.remove('hidden');
  loadAppStatus();
}
function closeDrawer() {
  document.getElementById('settingsDrawer').classList.add('hidden');
}
document.getElementById('settingsBtn').addEventListener('click', openDrawer);
document.getElementById('closeDrawerBtn').addEventListener('click', closeDrawer);
document.getElementById('settingsDrawer').addEventListener('click', e => {
  if (e.target === document.getElementById('settingsDrawer')) closeDrawer();
});

async function loadAppStatus() {
  try {
    const d = await apiFetch('/api/app-status');
    document.getElementById('appStatusInfo').innerHTML = `
      <div class="status-grid">
        <div class="stat-box"><div class="stat-num">${d.ratingsCount}</div><div class="stat-lbl">Rated films</div></div>
        <div class="stat-box"><div class="stat-num">${d.watchlistCount}</div><div class="stat-lbl">Watchlist</div></div>
        <div class="stat-box"><div class="stat-num">${d.overlapCount}</div><div class="stat-lbl">Rewatches</div></div>
        <div class="stat-box ${d.failedCount > 0 ? 'warn' : ''}"><div class="stat-num">${d.failedCount}</div><div class="stat-lbl">Unresolved</div></div>
      </div>
      <div class="tmdb-badge ${d.tmdbKeySet ? 'ok' : 'err'}">
        ${d.tmdbKeySet ? '✓ TMDb connected' : '✗ No TMDb key'}
      </div>
    `;
  } catch {}
}

if (isElectron) {
  document.getElementById('goSetupBtn').addEventListener('click', () => {
    closeDrawer();
    window.electronAPI.goToSettings();
  });

  document.getElementById('reloadRatingsBtn').addEventListener('click', async () => {
    const p = await window.electronAPI.pickFile({ title: 'Select ratings CSV', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (!p) return;
    const r = await window.electronAPI.installCsv({ sourcePath: p, destName: 'ratings.csv' });
    if (r.ok) { showToast('Ratings CSV updated. Resetting state…', 'info'); resetState(); closeDrawer(); }
    else showToast('Error: ' + r.error, 'error');
  });

  document.getElementById('reloadWatchlistBtn').addEventListener('click', async () => {
    const p = await window.electronAPI.pickFile({ title: 'Select watchlist CSV', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (!p) return;
    const r = await window.electronAPI.installCsv({ sourcePath: p, destName: 'watchlist.csv' });
    if (r.ok) { showToast('Watchlist CSV updated. Reloading…', 'info'); reloadWatchlist(); closeDrawer(); }
    else showToast('Error: ' + r.error, 'error');
  });
} else {
  // Hide Electron-only buttons in browser mode
  document.getElementById('goSetupBtn').style.display = 'none';
  document.getElementById('reloadRatingsBtn').style.display = 'none';
  document.getElementById('reloadWatchlistBtn').style.display = 'none';
}

/* ─── Escape ─────────────────────────────────────────────────────────────────── */
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

/* ─── Score breakdown pill ───────────────────────────────────────────────────── */
function breakdownHtml(bd) {
  if (!bd) return '';
  const labels = { genre:'Genre', director:'Director', writer:'Writer', keyword:'Keywords', geography:'Geo', decade:'Decade', collection:'Collect', tmdb:'TMDb', neighbor:'Neighbors' };
  const entries = Object.entries(bd).filter(([,v]) => v > 0).sort(([,a],[,b]) => b-a).slice(0, 6);
  if (!entries.length) return '';
  const pills = entries.map(([k,v]) =>
    `<span class="breakdown-pill"><span class="bd-label">${labels[k]||k}</span><span class="bd-value">${Math.round(v*100)}%</span></span>`
  ).join('');
  return `<div class="breakdown-row">${pills}</div>`;
}

/* ─── Card builder ───────────────────────────────────────────────────────────── */
function buildCard({ posterPath, title, year, genres, tmdbRating, letterboxdUrl, extraMeta, priorityHtml, actionBtns }) {
  const img = posterPath ? IMAGE_BASE + posterPath : null;
  const rating = typeof tmdbRating === 'number' ? tmdbRating.toFixed(1) : tmdbRating || '';
  const linkHref = isElectron ? `javascript:void(0)` : escapeHtml(letterboxdUrl);
  const linkOnClick = isElectron && letterboxdUrl ? `onclick="window.electronAPI.openExternal('${escapeHtml(letterboxdUrl)}')"` : '';
  return `
    <div class="card">
      ${img ? `<img class="poster" src="${img}" alt="Poster" loading="lazy">` : '<div class="no-poster">No poster</div>'}
      <div class="card-main">
        <div>
          <div class="title-row">
            <div class="title">${escapeHtml(title)}</div>
            ${year ? `<div class="year">(${escapeHtml(String(year))})</div>` : ''}
          </div>
          ${genres?.length ? `<div class="genres">${escapeHtml(genres.join(', '))}</div>` : ''}
          <div class="meta">
            ${rating ? `<span>TMDb: ${rating}/10</span>` : ''}
            ${extraMeta || ''}
          </div>
          ${letterboxdUrl ? `<div style="font-size:11px;margin-top:4px;">
            <a class="movie-link" href="${linkHref}" ${linkOnClick} target="${isElectron ? '' : '_blank'}" rel="noopener noreferrer">View on Letterboxd ↗</a>
          </div>` : ''}
        </div>
        <div class="priority-row">
          ${priorityHtml || ''}
          ${actionBtns ? `<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;">${actionBtns}</div>` : ''}
        </div>
      </div>
    </div>
  `;
}

/* ─── Universal search across rated films ────────────────────────────────────── */
async function promptChangeRating(title, year, letterboxdUrl, currentRating = 0) {
  const result = await showModal('rating', letterboxdUrl || '', title, !letterboxdUrl, currentRating);
  if (!result) return;
  const { rating } = result;
  try {
    const data = await apiPost('/api/update-rating', { title, year, letterboxdUrl, rating });
    if (data.error) { showToast('Error: ' + data.error, 'error'); return; }
    showToast(`Rating for "${title}" updated to ${rating}★. Ranked watchlist will recalculate.`, 'success', 3500);
    // Refresh the search results in place
    if (typeof window.tmRefreshRatedSearch === 'function') window.tmRefreshRatedSearch();
  } catch { showToast('Failed to update rating.', 'error'); }
}

async function loadSearchRatings() {
  const viewId = getNewViewId();

  // Load all rated films initially for sort-browse mode
  let allRatedItems = [];
  try {
    const allData = await apiFetch('/api/search-ratings?all=true');
    allRatedItems = allData.items || [];
  } catch {}

  setOutput(`
    <h3>Search Your Rated Films</h3>
    <p class="summary">Search across every film you've rated. Results include poster, your rating, and TMDb data.</p>
    <div class="rated-controls-row">
      <div class="search-wrap rated-search-wrap">
        <input id="universalSearch" type="text" placeholder="Type a film title…" autofocus autocomplete="off">
      </div>
      <div class="sort-controls">
        <label class="sort-label">Sort:</label>
        <button class="pill-btn sort-btn active" data-sort="highest">Highest rated</button>
        <button class="pill-btn ghost sort-btn" data-sort="lowest">Lowest rated</button>
      </div>
    </div>
    <div id="searchResults" class="cards"></div>
  `);

  const input   = document.getElementById('universalSearch');
  const results = document.getElementById('searchResults');
  const sortBtns = document.querySelectorAll('.sort-btn');
  let debounce = null;
  let currentRequestId = 0;
  let currentSort = 'highest';
  let currentItems = [];

  setTimeout(() => { if (input) input.focus(); }, 50);

  function sortItems(items) {
    return [...items].sort((a, b) => {
      const rDiff = currentSort === 'highest'
        ? (b.userRating || 0) - (a.userRating || 0)
        : (a.userRating || 0) - (b.userRating || 0);
      if (rDiff !== 0) return rDiff;
      return (a.title || '').localeCompare(b.title || '');
    });
  }

  function renderRatedItems(items) {
    currentItems = items;
    if (!items.length) { results.innerHTML = '<p class="summary">No rated films match that search.</p>'; return; }
    results.innerHTML = sortItems(items).map(r => buildCard({
      posterPath: r.posterPath, title: r.title, year: r.year,
      genres: r.genres, tmdbRating: r.tmdbRating, letterboxdUrl: r.letterboxdUrl,
      extraMeta: `<span>Your rating: ${r.userRating}★</span>`,
      actionBtns: `<button class="small-btn change-rating-btn"
        data-title="${escapeHtml(r.title)}"
        data-year="${escapeHtml(String(r.year || ''))}"
        data-url="${escapeHtml(r.letterboxdUrl || '')}"
        data-rating="${r.userRating || 0}">
        Change rating
      </button>`
    })).join('');
    attachChangeRatingHandlers();
  }

  function attachChangeRatingHandlers() {
    document.querySelectorAll('.change-rating-btn').forEach(btn => {
      btn.addEventListener('click', async e => {
        const b = e.currentTarget;
        const currentRating = parseFloat(b.dataset.rating) || 0;
        await promptChangeRating(b.dataset.title, b.dataset.year ? parseInt(b.dataset.year, 10) : null, b.dataset.url, currentRating);
      });
    });
  }

  sortBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      sortBtns.forEach(b => { b.classList.remove('active'); b.classList.add('ghost'); });
      btn.classList.add('active'); btn.classList.remove('ghost');
      currentSort = btn.dataset.sort;
      if (currentItems.length) renderRatedItems(currentItems);
      else if (!input.value.trim()) renderRatedItems(allRatedItems);
    });
  });

  // Show all rated films sorted by default on load
  if (allRatedItems.length) renderRatedItems(allRatedItems);

  window.tmRefreshRatedSearch = () => {
    const q = input.value.trim();
    if (q) input.dispatchEvent(new Event('input'));
    else apiFetch('/api/search-ratings?all=true').then(d => renderRatedItems(d.items || [])).catch(() => {});
  };

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    const q = input.value.trim();
    if (!q) { renderRatedItems(allRatedItems); return; }
    results.innerHTML = '<p class="summary">Searching…</p>';
    const reqId = ++currentRequestId;
    debounce = setTimeout(async () => {
      try {
        const data = await apiFetch('/api/search-ratings?q=' + encodeURIComponent(q));
        if (currentRequestId !== reqId) return;
        renderRatedItems(data.items || []);
      } catch {
        if (currentRequestId !== reqId) return;
        results.innerHTML = '<p class="summary">Search failed.</p>';
      }
    }, 350);
  });
}

/* ─── Failed / unresolved items ──────────────────────────────────────────────── */
async function loadFailedItems() {
  const viewId = getNewViewId();
  setOutput('<p class="summary">Loading unresolved films…</p>');
  try {
    const data = await apiFetch('/api/failed-items');
    if (currentViewId !== viewId) return;
    if (!data.items.length) {
      setOutput('<h3>Unresolved Films</h3><p class="summary">🎉 All films were found on TMDb — nothing to fix!</p>');
      return;
    }
    let html = `
      <h3>Unresolved Films <span class="badge-warn">${data.count}</span></h3>
      <p class="summary">These films couldn't be found on TMDb. You can add them manually using "Add Rating" or "Add to Watchlist" with their TMDb URL.</p>
      <div class="failed-list">
    `;
    data.items.forEach(item => {
      html += `
        <div class="failed-row">
          <div class="failed-info">
            <span class="failed-title">${escapeHtml(item.title)}</span>
            ${item.year ? `<span class="failed-year">(${item.year})</span>` : ''}
            <span class="failed-source">${item.source}</span>
          </div>
          <div class="failed-actions">
            ${item.url ? `<a class="movie-link" href="${isElectron ? 'javascript:void(0)' : escapeHtml(item.url)}"
              ${isElectron ? `onclick="window.electronAPI.openExternal('${escapeHtml(item.url)}')"` : 'target="_blank"'}
              >Letterboxd ↗</a>` : ''}
            <button class="small-btn" onclick="searchTmdb('${escapeHtml(item.title)}', ${item.year || 'null'})">Search TMDb ↗</button>
            <button class="small-btn resolve-btn" onclick="promptResolveFailed('${escapeHtml(item.title)}', ${item.year || 'null'}, '${item.url ? escapeHtml(item.url) : ''}')">Add / Resolve</button>
          </div>
        </div>
      `;
    });
    html += '</div>';
    setOutput(html);
  } catch { setOutput('<p class="summary">Failed to load unresolved items.</p>'); }
}

function searchTmdb(title, year) {
  const url = `https://www.themoviedb.org/search?query=${encodeURIComponent(title)}${year ? `&year=${year}` : ''}`;
  if (isElectron) window.electronAPI.openExternal(url);
  else window.open(url, '_blank');
}

function showResolveModal(title) {
  return new Promise(resolve => {
    const overlay = document.getElementById('resolveModal');
    const submitBtn = document.getElementById('resolveModalSubmit');
    const cancelBtn = document.getElementById('resolveModalCancel');
    const closeBtn = document.getElementById('resolveModalClose');
    
    document.getElementById('resolveModalTitle').textContent = `Resolve: ${title}`;
    overlay.classList.remove('hidden');
    
    function cleanup() {
      overlay.classList.add('hidden');
      submitBtn.removeEventListener('click', onSubmit);
      cancelBtn.removeEventListener('click', onCancel);
      closeBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKey);
    }
    
    function onCancel() { cleanup(); resolve(null); }
    function onOverlayClick(e) { if (e.target === overlay) onCancel(); }
    function onKey(e) { if (e.key === 'Escape') onCancel(); }
    
    function onSubmit() {
      const mode = document.querySelector('input[name="resolveMode"]:checked').value;
      cleanup();
      resolve(mode);
    }
    
    submitBtn.addEventListener('click', onSubmit);
    cancelBtn.addEventListener('click', onCancel);
    closeBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKey);
  });
}

async function promptResolveFailed(title, year, url) {
  const mode = await showResolveModal(title);
  if (!mode) return; // User cancelled
  
  const result = await showModal(mode, url, title);
  if (!result) return;
  
  const { letterboxdUrl, tmdbInput, rating } = result;
  try {
    const endpoint = mode === 'rating' ? '/api/add-rating' : '/api/add-to-watchlist';
    const payload = mode === 'rating'
      ? { letterboxdUrl, rating, tmdbInput, title, year, fromResolved: true }
      : { letterboxdUrl, tmdbInput, title, year, fromResolved: true };
    const data = await apiPost(endpoint, payload);
    
    if (data.error) {
      if (data.rewatch) { showToast('Note: ' + data.error, 'warn'); }
      else { showToast('Error: ' + data.error, 'error'); return; }
    } else {
      showToast('Film resolved successfully!', 'success');
    }
    
    // Reload recommendations or rewatches if needed, then reload failed items
    if (mode === 'watchlist') loadRecommendations();
    loadFailedItems();
  } catch { showToast('Failed to resolve film.', 'error'); }
}

/* ─── Reload & Reset ─────────────────────────────────────────────────────────── */
async function reloadWatchlist() {
  setOutput('<p class="summary">Reloading watchlist.csv…</p>');
  try {
    const data = await apiPost('/api/reload-watchlist');
    if (data.error) { showToast('Error: ' + data.error, 'error'); return; }
    showToast(`Watchlist reloaded. Items: ${data.watchlistCount}, rewatches: ${data.overlapCount}.`, 'success');
    loadRecommendations();
  } catch { showToast('Failed to reload watchlist.', 'error'); }
}

async function resetState() {
  if (!await showConfirm('Reset to original CSV files? This discards all manual changes.', 'Reset State')) return;
  setOutput('<p class="summary">Resetting…</p>');
  try {
    const data = await apiPost('/api/reset-state');
    if (data.error) { showToast('Error: ' + data.error, 'error'); return; }
    showToast(`State reset. Ratings: ${data.ratingsCount}, watchlist: ${data.watchlistCount}.`, 'success');
    loadRecommendations();
  } catch { showToast('Failed to reset state.', 'error'); }
}

/* ─── Rewatch Ranking ────────────────────────────────────────────────────────── */
async function loadRewatchRanking() {
  const viewId = getNewViewId();
  setOutput('<p class="summary">Loading ranked rewatches…</p>');
  try {
    const data = await apiFetch('/api/rewatch-ranking');
    if (currentViewId !== viewId) return;
    const items = data.items || [];
    if (!items.length) { setOutput('<p class="summary">No rewatches found.</p>'); return; }

    let html = `<h3>Ranked Rewatches</h3>
      <p class="summary">${data.count} rewatch candidates. Rating is the primary anchor; the taste model adjusts by up to ±30%.</p>
      <div class="cards">`;

    items.forEach((r, i) => {
      const pct = Math.round(r.rewatchScore * 100);
      html += buildCard({
        posterPath: r.posterPath, title: r.title, year: r.year,
        genres: r.genres, tmdbRating: r.tmdbRating, letterboxdUrl: r.letterboxdUrl,
        extraMeta: `<span>Your rating: ${r.userRating}★</span><span>Model score: ${Math.round(r.modelScore*100)}%</span>`,
        priorityHtml: `
          <div class="priority-label">Rewatch priority: ${pct}%</div>
          <div class="bar-wrap"><div class="bar-fill" style="width:${pct}%;"></div></div>
          <div class="priority-text">Rewatch rank #${i+1}</div>
          ${breakdownHtml(r.breakdown)}
        `,
        actionBtns: r.letterboxdUrl ? `
          <button class="small-btn hide-rewatch-btn"
            data-url="${escapeHtml(r.letterboxdUrl)}"
            data-title="${escapeHtml(r.title)}">
            Hide from rewatches
          </button>` : ''
      });
    });

    html += '</div>';
    setOutput(html);
    attachHideRewatchHandlers();
  } catch { setOutput('<p class="summary">Failed to load rewatches.</p>'); }
}

function attachHideRewatchHandlers() {
  document.querySelectorAll('.hide-rewatch-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      const url = e.currentTarget.dataset.url;
      const title = e.currentTarget.dataset.title;
      if (!await showConfirm(`Hide "${title}" from your rewatch list?`, 'Hide Rewatch')) return;
      try {
        const data = await apiPost('/api/hide-rewatch', { letterboxdUrl: url });
        if (data.error) { showToast('Error: ' + data.error, 'error'); return; }
        loadRewatchRanking();
      } catch { showToast('Failed to hide rewatch.', 'error'); }
    }, { once: true });
  });
}

/* ─── Genre Profile ──────────────────────────────────────────────────────────── */
async function loadGenreProfile() {
  const viewId = getNewViewId();
  setOutput('<p class="summary">Building genre profile…</p>');
  try {
    const data = await apiFetch('/api/genre-profile');
    if (currentViewId !== viewId) return;
    const stats   = data.genreStats   || {};
    const profile = data.genreProfile || {};

    const entries = Object.keys(stats).map(id => ({
      id, name: stats[id].name, avg: profile[id] || 0, count: stats[id].count
    })).sort((a,b) => b.avg - a.avg);

    if (!entries.length) { setOutput('<p>No genre data available.</p>'); return; }
    const maxAvg = Math.max(...entries.map(e => e.avg));

    let html = `<h3>Genre Profile</h3>
      <p class="summary">Based on ${data.usedRatings} rated titles. Click a genre to see films in it.</p>
      <div class="genre-grid">`;

    entries.forEach(e => {
      const pct = maxAvg > 0 ? Math.round((e.avg / maxAvg) * 100) : 0;
      html += `
        <div class="genre-card" onclick="loadGenreTitles(${e.id})">
          <div class="genre-name">${escapeHtml(e.name)}</div>
          <div>Smoothed avg: ${e.avg.toFixed(2)} / 5</div>
          <div>Titles rated: ${e.count}</div>
          <div class="genre-bar-wrap"><div class="genre-bar-fill" style="width:${pct}%;"></div></div>
        </div>`;
    });

    html += '</div>';
    setOutput(html);
  } catch { setOutput('<p class="summary">Failed to load genre profile.</p>'); }
}

async function loadGenreTitles(genreId) {
  const viewId = getNewViewId();
  setOutput('<p class="summary">Loading genre titles…</p>');
  try {
    const data = await apiFetch('/api/genre-titles/' + genreId);
    if (currentViewId !== viewId) return;
    currentGenreTitles = data.items || [];

    if (!currentGenreTitles.length) {
      setOutput(`<h3>Genre ${genreId}</h3><p class="summary">No rated titles in this genre.</p>`);
      return;
    }

    setOutput(`
      <h3>Genre – rated titles</h3>
      <p class="summary">${currentGenreTitles.length} films rated in this genre.</p>
      <div class="search-wrap">
        <input id="genreTitlesSearch" type="text" placeholder="Search by title…" />
      </div>
      <div id="genreTitlesCards" class="cards"></div>
    `);

    const cardsDiv = document.getElementById('genreTitlesCards');
    function render(list) {
      cardsDiv.innerHTML = list.map(r => buildCard({
        posterPath: r.posterPath, title: r.title, year: r.year,
        genres: r.genres, tmdbRating: r.tmdbRating, letterboxdUrl: r.letterboxdUrl,
        extraMeta: `<span>Your rating: ${r.userRating}★</span>`
      })).join('') || '<p class="summary">No results.</p>';
    }

    render(currentGenreTitles);
    document.getElementById('genreTitlesSearch').addEventListener('input', e => {
      const q = e.target.value.toLowerCase().trim();
      render(q ? currentGenreTitles.filter(r => (r.title||'').toLowerCase().includes(q)) : currentGenreTitles);
    });
  } catch { setOutput('<p class="summary">Failed to load genre titles.</p>'); }
}

/* ─── Recommendations ────────────────────────────────────────────────────────── */
function renderRecommendations(list) {
  const cardsDiv = document.getElementById('recsCards');
  if (!cardsDiv) return;

  if (!list?.length) {
    cardsDiv.innerHTML = '<p class="summary">No recommendations to show.</p>';
    return;
  }

  cardsDiv.innerHTML = list.map(r => {
    const pct  = Math.round(r.predictedScore * 100);
    const rank = r.globalRank ?? (allRecommendations.indexOf(r) + 1);

    const actionBtns = r.letterboxdUrl ? `
      <button class="small-btn mark-watched-btn"
        data-url="${escapeHtml(r.letterboxdUrl)}"
        data-title="${escapeHtml(r.title)}"
        data-year="${escapeHtml(r.year||'')}">
        Mark watched &amp; rate
      </button>
      <button class="small-btn remove-watchlist-btn"
        data-url="${escapeHtml(r.letterboxdUrl)}"
        data-title="${escapeHtml(r.title)}">
        Remove from watchlist
      </button>` : '';

    return buildCard({
      posterPath: r.posterPath, title: r.title, year: r.year,
      genres: r.genres, tmdbRating: r.tmdbRating, letterboxdUrl: r.letterboxdUrl,
      extraMeta: `<span>Model score: ${Math.round(r.predictedScore*100)}%</span>${r.directors?.length ? `<span>Dir: ${escapeHtml(r.directors.slice(0,2).join(', '))}</span>` : ''}`,
      priorityHtml: `
        <div class="priority-label">Match: ${pct}%</div>
        <div class="bar-wrap"><div class="bar-fill" style="width:${pct}%;"></div></div>
        <div class="priority-text">Rank #${rank} in your watchlist</div>
        ${breakdownHtml(r.breakdown)}
      `,
      actionBtns
    });
  }).join('');

  attachMarkWatchedHandlers();
  attachRemoveWatchlistHandlers();
}

function attachMarkWatchedHandlers() {
  document.querySelectorAll('.mark-watched-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      const b    = e.currentTarget;
      const url  = b.dataset.url;
      const title = b.dataset.title;
      const year  = b.dataset.year ? parseInt(b.dataset.year, 10) : null;

      if (!url) { showToast('No Letterboxd URL.', 'error'); return; }
      // window.prompt is blocked in Electron — use the modal instead
      const result = await showModal('rating', url, title, true);
      if (!result) return;
      const rating = result.rating;

      try {
        const data = await apiPost('/api/mark-watched', { letterboxdUrl: url, rating, title, year });
        if (data.error) { showToast('Error: ' + data.error, 'error'); return; }
        showToast(`"${title}" marked as watched!`, 'success');
        allRecommendations = allRecommendations.filter(r => r.letterboxdUrl !== url);
        if (typeof window.tmApplyFilters === 'function') {
          window.tmApplyFilters();
        } else {
          renderRecommendations(allRecommendations);
        }
      } catch { showToast('Failed to mark watched.', 'error'); }
    }, { once: true });
  });
}

function attachRemoveWatchlistHandlers() {
  document.querySelectorAll('.remove-watchlist-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      const b    = e.currentTarget;
      const url  = b.dataset.url;
      const title = b.dataset.title;
      if (!await showConfirm(`Remove "${title}" from watchlist?`, 'Remove Film')) return;
      try {
        const data = await apiPost('/api/remove-from-watchlist', { letterboxdUrl: url });
        if (data.error) { showToast('Error: ' + data.error, 'error'); return; }
        showToast(`"${title}" removed from watchlist.`, 'success');
        allRecommendations = allRecommendations.filter(r => r.letterboxdUrl !== url);
        if (typeof window.tmApplyFilters === 'function') {
          window.tmApplyFilters();
        } else {
          renderRecommendations(allRecommendations);
        }
      } catch { showToast('Failed to remove.', 'error'); }
    }, { once: true });
  });
}

async function loadRecommendations() {
  const viewId = getNewViewId();
  setOutput('<p class="summary">Calculating recommendations (first call may take a while)…</p>');
  try {
    const data = await apiFetch('/api/recommendations');
    if (currentViewId !== viewId) return;
    allRecommendations = data.recommendations || [];

    if (!allRecommendations.length) { setOutput('<p>No recommendations computed.</p>'); return; }
    allRecommendations.forEach((r, i) => { r.globalRank = i + 1; });

    setOutput(`
      <h3>Ranked Watchlist</h3>
      <p class="summary">
        ${data.totalRatings} ratings used · ${data.totalWatchlist} watchlist items ranked · ${data.overlapCount} rewatches removed.
        <button class="pill-btn ghost inline-reload-btn" id="reloadRankedWlBtn">↻ Recalculate</button>
      </p>
      <div class="search-wrap">
        <input id="recsSearch" type="text" placeholder="Search by title or genre…" />
      </div>
      <div class="filters-row">
        <input id="filterYear"   type="text" class="filter-input" placeholder="Year (e.g. 2019)" />
        <input id="filterDecade" type="text" class="filter-input" placeholder="Decade (e.g. 1990s)" />
        <select id="filterDirector" class="filter-select">
          <option value="all">All directors</option>
          <option value="watched">Only watched directors</option>
          <option value="unwatched">Only new directors</option>
        </select>
        <button class="pill-btn" id="applyFiltersBtn">Apply filters</button>
        <button class="pill-btn ghost" id="clearFiltersBtn">Clear</button>
      </div>
      <div id="recsCards" class="cards"></div>
    `);

    const searchInput  = document.getElementById('recsSearch');
    const yearInput    = document.getElementById('filterYear');
    const decadeInput  = document.getElementById('filterDecade');
    const dirSelect    = document.getElementById('filterDirector');
    const applyBtn     = document.getElementById('applyFiltersBtn');
    const clearBtn     = document.getElementById('clearFiltersBtn');
    const reloadBtn    = document.getElementById('reloadRankedWlBtn');
    if (reloadBtn) {
      reloadBtn.addEventListener('click', async () => {
        reloadBtn.disabled = true;
        reloadBtn.textContent = '↻ Recalculating…';
        try { await apiPost('/api/invalidate-recommendations', {}); } catch {}
        loadRecommendations();
      });
    }

    function applyFilters() {
      try {
        const q       = searchInput.value.toLowerCase().trim();
        const yearStr = yearInput.value.trim();
        const decStr  = decadeInput.value.trim();
        const dirMode = dirSelect.value;
        let filtered  = allRecommendations.slice();

        if (q) {
          filtered = filtered.filter(r => {
            const titleMatch = (r.title||'').toLowerCase().includes(q);
            const gList = Array.isArray(r.genres) ? r.genres : (r.genres ? [r.genres] : []);
            const genreMatch = gList.some(g => String(g).toLowerCase().includes(q));
            return titleMatch || genreMatch;
          });
        }

        if (yearStr) {
          const y = parseInt(yearStr, 10);
          if (isNaN(y) || y < 1888 || y > 2100) { return; } // Don't block with alert, just ignore invalid year during typing
          filtered = filtered.filter(r => parseInt(r.year, 10) === y);
        }

        if (decStr) {
          const m = decStr.match(/^(\d{4})s$/i);
          if (m) {
            const start = parseInt(m[1], 10);
            filtered = filtered.filter(r => { const y = parseInt(r.year,10); return y>=start && y<=start+9; });
          }
        }

        if (dirMode === 'watched')   filtered = filtered.filter(r => r.hasWatchedDirector);
        if (dirMode === 'unwatched') filtered = filtered.filter(r => !r.hasWatchedDirector);

        const container = document.getElementById('recsCards');
        if (!filtered.length) { container.innerHTML = '<p class="summary">No titles match the current filters.</p>'; }
        else renderRecommendations(filtered);
      } catch (err) {
        console.error('Filter error:', err);
      }
    }

    let filterDebounce = null;
    const debouncedApplyFilters = () => {
      clearTimeout(filterDebounce);
      filterDebounce = setTimeout(applyFilters, 150);
    };
    
    window.tmApplyFilters = debouncedApplyFilters;

    searchInput.addEventListener('input', debouncedApplyFilters);
    yearInput.addEventListener('input', debouncedApplyFilters);
    decadeInput.addEventListener('input', debouncedApplyFilters);
    dirSelect.addEventListener('change', debouncedApplyFilters);
    applyBtn.addEventListener('click', applyFilters);
    clearBtn.addEventListener('click', () => {
      searchInput.value = ''; yearInput.value = ''; decadeInput.value = ''; dirSelect.value = 'all';
      renderRecommendations(allRecommendations);
    });

    renderRecommendations(allRecommendations);
  } catch (e) { setOutput('<p class="summary">Failed to load recommendations.</p>'); console.error(e); }
}

/* ─── Modal helpers ──────────────────────────────────────────────────────────── */
function showModal(mode, prefillUrl = '', prefillTitle = '', hideUrls = false, prefillRating = 0) {
  // mode: 'rating' | 'watchlist'
  const overlay = document.getElementById('tmModal');
  const title   = document.getElementById('tmModalTitle');
  const ratingField = document.getElementById('tmRatingField');
  const submitBtn   = document.getElementById('tmModalSubmit');
  const lbInput     = document.getElementById('tmLbUrl');
  const tmdbInput   = document.getElementById('tmTmdbUrl');
  const ratingInput = document.getElementById('tmRating');
  const starRow     = document.getElementById('tmStarRow');

  const lbField     = lbInput.closest('.tm-field');
  const tmdbField   = tmdbInput.closest('.tm-field');

  if (hideUrls) {
    lbField.style.display = 'none';
    tmdbField.style.display = 'none';
  } else {
    lbField.style.display = '';
    tmdbField.style.display = '';
  }

  // Reset
  lbInput.value     = prefillUrl;
  tmdbInput.value   = '';
  ratingInput.value = prefillRating || '';

  const titlePrefix = mode === 'rating' ? (prefillRating ? 'Change Rating' : 'Add Rating') : 'Add to Watchlist';
  title.textContent = prefillTitle ? `${titlePrefix} — ${prefillTitle}` : titlePrefix;
  ratingField.style.display = mode === 'rating' ? '' : 'none';
  submitBtn.textContent = titlePrefix;

  // Build star picker (half-star: click left=half, right=full)
  starRow.innerHTML = '';
  const stars = [1,2,3,4,5];
  let currentRating = prefillRating || 0;
  function renderStars(val) {
    starRow.querySelectorAll('.tm-star').forEach((s,i) => {
      const full = i + 1;
      const half = i + 0.5;
      if (val >= full) s.textContent = '★';
      else if (val >= half) s.textContent = '⯨';
      else s.textContent = '☆';
      s.classList.toggle('active', val >= half);
    });
  }
  stars.forEach((n, i) => {
    const s = document.createElement('span');
    s.className = 'tm-star';
    s.textContent = '☆';
    s.title = `${n - 0.5} / ${n}`;
    s.addEventListener('click', e => {
      // Left half of star = half-star, right half = full
      const rect = s.getBoundingClientRect();
      const mid  = rect.left + rect.width / 2;
      currentRating = e.clientX < mid ? i + 0.5 : i + 1;
      ratingInput.value = currentRating;
      renderStars(currentRating);
    });
    s.addEventListener('mouseenter', e => {
      const rect = s.getBoundingClientRect();
      const mid  = rect.left + rect.width / 2;
      renderStars(e.clientX < mid ? i + 0.5 : i + 1);
    });
    starRow.appendChild(s);
  });
  starRow.addEventListener('mouseleave', () => renderStars(currentRating));

  // Render initial state (shows prefilled rating if any)
  renderStars(currentRating);

  // Sync typed rating to stars
  ratingInput.addEventListener('input', () => {
    const v = parseFloat(ratingInput.value);
    if (!isNaN(v) && v >= 0.5 && v <= 5) { currentRating = v; renderStars(v); }
    else renderStars(0);
  });

  overlay.classList.remove('hidden');
  setTimeout(() => lbInput.focus(), 80);

  // Return a promise that resolves with the form data or null on cancel
  return new Promise(resolve => {
    function cleanup() {
      overlay.classList.add('hidden');
      document.getElementById('tmModalClose').removeEventListener('click', onCancel);
      document.getElementById('tmModalCancel').removeEventListener('click', onCancel);
      submitBtn.removeEventListener('click', onSubmit);
      overlay.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKey);
    }
    function onCancel() { cleanup(); resolve(null); }
    function onOverlayClick(e) { if (e.target === overlay) onCancel(); }
    function onKey(e) { if (e.key === 'Escape') onCancel(); }
    function onSubmit() {
      const lb   = lbInput.value.trim();
      const tmdb = tmdbInput.value.trim();
      if (!lb) { lbInput.focus(); lbInput.style.borderColor = '#e05555'; return; }
      lbInput.style.borderColor = '';
      if (mode === 'rating') {
        const r = parseFloat(ratingInput.value);
        if (isNaN(r) || r < 0.5 || r > 5) {
          ratingInput.focus(); ratingInput.style.borderColor = '#e05555'; return;
        }
        ratingInput.style.borderColor = '';
        cleanup();
        resolve({ letterboxdUrl: lb, tmdbInput: tmdb || null, rating: r });
      } else {
        cleanup();
        resolve({ letterboxdUrl: lb, tmdbInput: tmdb || null });
      }
    }
    document.getElementById('tmModalClose').addEventListener('click', onCancel);
    document.getElementById('tmModalCancel').addEventListener('click', onCancel);
    submitBtn.addEventListener('click', onSubmit);
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKey);
  });
}

/* ─── Manual mutations ───────────────────────────────────────────────────────── */
async function promptAddRating() {
  const result = await showModal('rating');
  if (!result) return;
  const { letterboxdUrl, tmdbInput, rating } = result;
  const submitBtn = document.getElementById('tmModalSubmit');
  try {
    if (submitBtn) submitBtn.disabled = true;
    const data = await apiPost('/api/add-rating', { letterboxdUrl, rating, tmdbInput });
    if (data.error) {
      if (data.alreadyRated) { showToast('You\'ve already rated this film.', 'warn'); return; }
      showToast('Error: ' + data.error, 'error'); return;
    }
    showToast('Rating added! Recalculating ranked watchlist…', 'success', 3000);
    loadRecommendations();
  } catch { showToast('Failed to add rating.', 'error'); }
  finally { if (submitBtn) submitBtn.disabled = false; }
}

async function promptAddToWatchlist() {
  const result = await showModal('watchlist');
  if (!result) return;
  const { letterboxdUrl, tmdbInput } = result;
  try {
    const data = await apiPost('/api/add-to-watchlist', { letterboxdUrl, tmdbInput });
    if (data.error) {
      if (data.alreadyInWatchlist) { showToast('This film is already in your watchlist.', 'warn'); return; }
      if (data.rewatch) { showToast('Note: ' + data.error, 'warn'); return; }
      showToast('Error: ' + data.error, 'error'); return;
    }
    showToast('Added to watchlist!', 'success');
    loadRecommendations();
  } catch { showToast('Failed to add to watchlist.', 'error'); }
}

/* ─── Export ─────────────────────────────────────────────────────────────────── */
function showExportModal() {
  return new Promise(resolve => {
    const overlay = document.getElementById('exportModal');
    const submitBtn = document.getElementById('exportModalSubmit');
    const cancelBtn = document.getElementById('exportModalCancel');
    const closeBtn = document.getElementById('exportModalClose');
    
    overlay.classList.remove('hidden');
    
    function cleanup() {
      overlay.classList.add('hidden');
      submitBtn.removeEventListener('click', onSubmit);
      cancelBtn.removeEventListener('click', onCancel);
      closeBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKey);
    }
    
    function onCancel() { cleanup(); resolve(null); }
    function onOverlayClick(e) { if (e.target === overlay) onCancel(); }
    function onKey(e) { if (e.key === 'Escape') onCancel(); }
    
    function onSubmit() {
      const includeRewatches = document.querySelector('input[name="exportIncludeRewatches"]:checked').value === 'true';
      cleanup();
      resolve(includeRewatches);
    }
    
    submitBtn.addEventListener('click', onSubmit);
    cancelBtn.addEventListener('click', onCancel);
    closeBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKey);
  });
}

async function exportRankedWatchlist() {
  const includeRewatches = await showExportModal();
  if (includeRewatches === null) return; // User cancelled

  try {
    const url = `/api/export-ranked-watchlist?includeRewatches=${includeRewatches}`;
    const res = await fetch(url);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast('Error: ' + (err.error || 'Unknown error'), 'error');
      return;
    }

    const blob    = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a       = document.createElement('a');
    const today   = new Date().toISOString().slice(0, 10);
    a.href         = blobUrl;
    a.download     = `ranked-watchlist-${today}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
    showToast(`Exported! Import via Letterboxd Lists → Import. ${includeRewatches ? 'Rewatches included.' : 'Watchlist only.'}`, 'success', 5000);
  } catch { showToast('Failed to export.', 'error'); }
}

/* ─── Toast notifications (replaces alert()) ─────────────────────────────────── */
function showToast(message, type = 'info', duration = 3500) {
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warn: '⚠️' };
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `tm-toast toast-${type}`;
  el.innerHTML = `<span class="tm-toast-icon">${icons[type] || 'ℹ️'}</span><span class="tm-toast-msg">${escapeHtml(message)}</span>`;
  container.appendChild(el);
  const remove = () => {
    el.classList.add('toast-exit');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  };
  const t = setTimeout(remove, duration);
  el.addEventListener('click', () => { clearTimeout(t); remove(); });
}

/* ─── Custom confirm dialog (replaces confirm()) ─────────────────────────────── */
function showConfirm(message, title = 'Confirm') {
  return new Promise(resolve => {
    const overlay  = document.getElementById('confirmModal');
    const msgEl    = document.getElementById('confirmModalMessage');
    const titleEl  = document.getElementById('confirmModalTitle');
    const okBtn    = document.getElementById('confirmModalOk');
    const cancelBtn = document.getElementById('confirmModalCancel');

    titleEl.textContent = title;
    msgEl.textContent   = message;
    overlay.classList.remove('hidden');

    function cleanup() {
      overlay.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlay);
      document.removeEventListener('keydown', onKey);
    }
    function onOk()     { cleanup(); resolve(true); }
    function onCancel() { cleanup(); resolve(false); }
    function onOverlay(e) { if (e.target === overlay) onCancel(); }
    function onKey(e)   { if (e.key === 'Escape') onCancel(); if (e.key === 'Enter') onOk(); }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlay);
    document.addEventListener('keydown', onKey);
  });
}

/* ─── API helpers ────────────────────────────────────────────────────────────── */
async function apiFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function apiPost(url, body = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

/* ─── Init ───────────────────────────────────────────────────────────────────── */
goHome();

/* ─── Priority Ranking System ───────────────────────────────────────────────── */

const DIMENSION_META = [
  {
    key: 'keyword',
    label: 'Themes & Keywords',
    icon: '🏷',
    desc: 'How well the film\'s themes, subjects, and tagged keywords align with topics you consistently enjoy — e.g. heist films, coming-of-age, road trips.'
  },
  {
    key: 'genre',
    label: 'Genre Match',
    icon: '🎭',
    desc: 'How strongly the film\'s genres match the ones you historically rate highest — action, drama, horror, animation, etc.'
  },
  {
    key: 'tmdb',
    label: 'Critical Reception',
    icon: '⭐',
    desc: 'The film\'s overall rating on TMDb, adjusted for Bayesian smoothing to avoid bias towards obscure films with few votes.'
  },
  {
    key: 'neighbour',
    label: 'Similar Films You Loved',
    icon: '🔗',
    desc: 'How closely this film resembles other films in your collection that you rated highly — a k-nearest-neighbour signal.'
  },
  {
    key: 'director',
    label: 'Director',
    icon: '🎬',
    desc: 'Whether you\'ve enjoyed films by this director before and how highly you\'ve rated their past work.'
  },
  {
    key: 'writer',
    label: 'Writer / Screenplay',
    icon: '✍',
    desc: 'How well the film\'s writers match your taste — useful if you gravitate towards specific screenwriters or storytelling styles.'
  },
  {
    key: 'geo',
    label: 'Country & Region',
    icon: '🌍',
    desc: 'Your affinity for films from a particular country or region — e.g. if you love French cinema or South Korean films.'
  },
  {
    key: 'decade',
    label: 'Era / Decade',
    icon: '📅',
    desc: 'How often you tend to enjoy films from the same era — e.g. if you consistently rate 80s films higher than recent releases.'
  },
  {
    key: 'collection',
    label: 'Film Series / Collection',
    icon: '🗂',
    desc: 'Whether the film is part of a franchise or collection you\'ve already shown you enjoy — sequels, trilogies, cinematic universes.'
  }
];

// Current priority order (array of keys, index 0 = highest priority)
let currentPriorityRanking = DIMENSION_META.map(d => d.key);
let priorityModalCallback  = null; // called after saving (null = just editing)

// ─── Load existing weights from server and derive ranking order ───────────────
async function loadCurrentPriorityRanking() {
  try {
    const data = await apiFetch('/api/user-weights');
    const w = data.weights;
    // Sort dimension keys by their current weight, descending
    currentPriorityRanking = DIMENSION_META.map(d => d.key)
      .sort((a, b) => (w[b] || 0) - (w[a] || 0));
  } catch {}
}

// ─── Open the priority modal ──────────────────────────────────────────────────
// firstLaunch=true: called before the first ranked watchlist render
// firstLaunch=false: called from settings, just editing
async function openPriorityModal(firstLaunch = false) {
  await loadCurrentPriorityRanking();
  priorityModalCallback = firstLaunch ? () => loadRecommendations() : null;

  const overlay = document.getElementById('priorityModal');
  overlay.classList.remove('hidden');
  renderPriorityList(currentPriorityRanking);

  document.getElementById('priorityModalClose').onclick = () => {
    overlay.classList.add('hidden');
    if (firstLaunch) loadRecommendations(); // still proceed with defaults
  };
  overlay.onclick = (e) => {
    if (e.target === overlay) {
      overlay.classList.add('hidden');
      if (firstLaunch) loadRecommendations();
    }
  };
  document.getElementById('priorityResetBtn').onclick = async () => {
    await apiPost('/api/user-weights/reset', {});
    overlay.classList.add('hidden');
    showToast('Reset to defaults — recalculating…', 'info');
    loadRecommendations();
  };
  document.getElementById('prioritySaveBtn').onclick = async () => {
    const items = document.querySelectorAll('#priorityList .priority-item');
    const ranking = Array.from(items).map(el => el.dataset.key);
    try {
      const result = await apiPost('/api/user-weights', { ranking });
      if (result.error) { showToast('Error: ' + result.error, 'error'); return; }
      overlay.classList.add('hidden');
      showToast('Priorities saved — recalculating…', 'success');
      loadRecommendations();
    } catch {
      showToast('Failed to save priorities.', 'error');
    }
  };
}

// ─── Render the draggable priority list ──────────────────────────────────────
function renderPriorityList(ranking) {
  const list = document.getElementById('priorityList');
  list.innerHTML = '';
  ranking.forEach((key, idx) => {
    const meta = DIMENSION_META.find(d => d.key === key);
    if (!meta) return;
    const li = document.createElement('li');
    li.className = 'priority-item';
    li.dataset.key = key;
    li.draggable = true;
    li.innerHTML = `
      <span class="priority-rank">${idx + 1}</span>
      <span class="priority-drag-handle" title="Drag to reorder">⠿</span>
      <span class="priority-icon">${meta.icon}</span>
      <div class="priority-text">
        <span class="priority-label">${meta.label}</span>
        <span class="priority-desc">${meta.desc}</span>
      </div>
      <div class="priority-arrows">
        <button class="priority-arrow-btn" data-dir="up" title="Move up" ${idx === 0 ? 'disabled' : ''}>▲</button>
        <button class="priority-arrow-btn" data-dir="down" title="Move down" ${idx === ranking.length - 1 ? 'disabled' : ''}>▼</button>
      </div>
    `;

    // Arrow buttons
    li.querySelectorAll('.priority-arrow-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const items = Array.from(document.querySelectorAll('#priorityList .priority-item'));
        const keys = items.map(el => el.dataset.key);
        const i = keys.indexOf(key);
        if (btn.dataset.dir === 'up' && i > 0) {
          [keys[i], keys[i - 1]] = [keys[i - 1], keys[i]];
        } else if (btn.dataset.dir === 'down' && i < keys.length - 1) {
          [keys[i], keys[i + 1]] = [keys[i + 1], keys[i]];
        }
        currentPriorityRanking = keys;
        renderPriorityList(keys);
      });
    });

    list.appendChild(li);
  });

  // Drag-and-drop
  let dragSrc = null;
  list.querySelectorAll('.priority-item').forEach(item => {
    item.addEventListener('dragstart', e => {
      dragSrc = item;
      e.dataTransfer.effectAllowed = 'move';
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      list.querySelectorAll('.priority-item').forEach(i => i.classList.remove('drag-over'));
    });
    item.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (item !== dragSrc) {
        list.querySelectorAll('.priority-item').forEach(i => i.classList.remove('drag-over'));
        item.classList.add('drag-over');
      }
    });
    item.addEventListener('drop', e => {
      e.preventDefault();
      if (!dragSrc || dragSrc === item) return;
      const items = Array.from(list.querySelectorAll('.priority-item'));
      const fromIdx = items.indexOf(dragSrc);
      const toIdx   = items.indexOf(item);
      const keys = items.map(el => el.dataset.key);
      keys.splice(toIdx, 0, keys.splice(fromIdx, 1)[0]);
      currentPriorityRanking = keys;
      renderPriorityList(keys);
    });
  });
}

// ─── Hook into loadRecommendations to show modal on first launch ──────────────
const _originalLoadRecommendations = loadRecommendations;
window._priorityShownThisSession = false;

window.loadRecommendationsWithPriority = async function() {
  if (!window._priorityShownThisSession) {
    window._priorityShownThisSession = true;
    // Check if user has ever set custom weights
    try {
      const data = await apiFetch('/api/user-weights');
      const isDefault = JSON.stringify(data.weights) === JSON.stringify(data.defaultWeights);
      if (isDefault) {
        openPriorityModal(true);
        return;
      }
    } catch {}
  }
  loadRecommendations();
};

// Replace the action bar button behaviour
document.addEventListener('DOMContentLoaded', () => {
  // Patch the action button if it's using inline onclick
  document.querySelectorAll('[onclick="loadRecommendations()"]').forEach(btn => {
    btn.removeAttribute('onclick');
    btn.addEventListener('click', window.loadRecommendationsWithPriority);
  });
});

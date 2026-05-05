![Banner](banner.jpg)

# 🎬 Taste Matcher v3

**Turn your Letterboxd watchlist into a perfectly ranked queue.**

The all new Taste Matcher v3 is a desktop app (built with Electron + Node.js) that reads your Letterboxd ratings, fetches rich metadata from TMDb, builds a multi-dimensional taste model, and ranks every film in your watchlist from most-likely-to-enjoy to least. Everything runs locally — no accounts, no cloud, no subscriptions.

### 📂 Source Code

The full source is available on the main branch:

- [`server.js`](./server.js) — backend engine, taste model, scoring, all API routes
- [`public/js/app.js`](./public/js/app.js) — frontend logic
- [`public/css/main.css`](./public/css/main.css) — styles
- [`public/index.html`](./public/index.html) — UI markup
- [`electron/main.js`](./electron/main.js) — Electron entry point, IPC, window management

---

## 🧱 Tech Stack

- **Electron** — cross-platform desktop wrapper
- **Node.js + Express** — backend engine (runs in-process, no separate terminal needed)
- **TMDb API** — movie & TV metadata (genres, directors, keywords, collections, etc.)
- **csv-parse** — Letterboxd CSV parsing
- **HTML + CSS + vanilla JS** — frontend (no frameworks)
- **Disk caching** — all TMDb data and computed state persisted locally, zero repeated API calls

---

## 📁 Project Structure

```
taste-matcher/
├─ electron/
│  ├─ main.js           # Electron entry point — window, IPC, server lifecycle
│  ├─ preload.js        # Context bridge (exposes electronAPI to renderer)
│  ├─ setup.html        # First-run setup wizard
│  ├─ loading.html      # Splash screen while server starts
│  └─ error.html        # Error screen
├─ public/
│  ├─ css/
│  │  └─ main.css
│  ├─ js/
│  │  └─ app.js
│  └─ index.html
├─ server.js            # All backend logic — scoring, caching, API routes
└─ package.json
```

All user data (CSVs, cache, config) is stored in the OS user data directory — never inside the app folder:

| Platform | Path |
|----------|------|
| Windows  | `%APPDATA%\Taste Matcher\` |
| macOS    | `~/Library/Application Support/Taste Matcher/` |
| Linux    | `~/.config/Taste Matcher/` |

Inside that directory:

```
config.json              # TMDb key + CSV paths (setup wizard output)
data/
  ratings.csv            # your imported ratings
  watchlist.csv          # your imported watchlist
cache/
  tmdb_cache.json        # all TMDb API responses (never re-fetched)
  derived_cache.json     # taste model, ranked watchlist, rewatch ranking
  data_state.json        # live ratings/watchlist/overlap state
  hidden_rewatches.json  # rewatches you've chosen to permanently hide
```

---

## 1️⃣ Requirements

- **Node.js 18+**
- **TMDb Developer API Key** (free — v3 auth key)
- **Letterboxd exports:**
  - `ratings.csv`
  - `watchlist.csv` (or any Letterboxd list export)

---

## 2️⃣ First-Run Setup

On first launch, a setup wizard walks you through three steps:

**Step 1 — Ratings CSV**
Export from Letterboxd → Settings → Import & Export → Export Your Data. Use `ratings.csv`.

**Step 2 — Watchlist CSV**
Any Letterboxd list CSV works — official watchlist export, a custom list, or a legacy format. The parser handles all of them.

**Step 3 — TMDb API Key**
Get a free key at [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) → Request an API key (v3 auth). Paste it in, hit "Test" to verify, then "Launch App →".

The wizard copies your CSVs into the app's data directory and saves the config. After that, the server starts and the app opens directly every time.

---

## 3️⃣ Install & Run (Development)

```bash
git clone <repo>
cd taste-matcher
npm install
npm start
```

To build a distributable:

```bash
npm run dist        # current platform
npm run dist:win    # Windows installer (NSIS)
```

---

## ⭐ Features

### 🎯 Ranked Watchlist

Your entire watchlist, ordered by predicted enjoyment based on your personal taste profile. Each card shows:

- Poster, title, year
- Genres
- TMDb community rating
- Match percentage (colour-coded progress bar)
- Global rank in your watchlist
- Score breakdown pills (top contributing factors)
- Director names

**Filters:**
- Text search (title or genre)
- Exact year (e.g. `2019`)
- Decade (e.g. `1990s`)
- Director filter — All / Only directors you've seen before / Only new directors

**↻ Recalculate button** — forces a fresh re-score of the entire watchlist using your current ratings and taste model, without making any new TMDb API calls.

Per-card actions:
- **Mark watched & rate** — removes the film from the watchlist, prompts for a star rating, adds it to your ratings and moves it to the rewatch list. Rankings update immediately.
- **Remove from watchlist** — permanently removes the film from the current watchlist snapshot without rating it. Rankings update immediately.

---

### 🔁 Ranked Rewatches

Films that appear in both your ratings and your watchlist (i.e. films you've already seen but kept on your watchlist). Ranked by a formula that keeps your own rating as the anchor, using the taste model only as a modifier:

```
rewatchScore = userRatingNorm × (0.70 + 0.30 × modelScore)
```

- A 5★ film the model also loves → up to **1.00**
- A 5★ film the model disagrees with → **0.70** (still ranked high)
- A 2★ film the model loves → max **~0.52** (can't outrank your 3★+ films)

Each card shows your rating, the model's score, a rewatch priority bar, and a score breakdown.

**Hide from rewatches** — permanently removes a film from the rewatch list. Persists across restarts.

---

### 📊 Genre Profile

A visual overview of your taste broken down by genre:

- Bayesian-smoothed average rating per genre (pulled toward your global mean for small sample sizes)
- Film count per genre
- Visual preference bar (relative to your highest-rated genre)

Click any genre card to expand it into a full list of every film you've rated in that genre, with posters, your rating, and a search filter.

---

### 🔍 Rated Films

Browse and search your entire rating history with full TMDb enrichment (poster, genres, TMDb score). Loads all your rated films immediately on open, sorted highest-rated first by default.

**Sort controls:**
- **Highest rated** — your top-rated films first; ties sorted alphabetically
- **Lowest rated** — your lowest-rated films first; ties sorted alphabetically

**Change rating** — every card has a "Change rating" button that opens the star picker pre-filled with your current rating. Saving a new rating immediately invalidates the taste model and ranked watchlist caches so the next calculation reflects the change.

Search filters to title in real time as you type.

---

### ⚠️ Unresolved Films

Films from your CSVs that couldn't be matched to a TMDb entry. Each item shows:

- Title and year
- Source (ratings or watchlist)
- Link to its Letterboxd page
- "Search TMDb ↗" — opens a TMDb search in your browser so you can find the correct entry
- "Add / Resolve" — opens a modal to manually supply the correct TMDb URL or ID, permanently resolving the film and removing it from the unresolved list

---

## ⚙️ Settings Drawer

Accessible via the ⚙ button. Shows live stats (rated films, watchlist size, rewatches, unresolved count) and a TMDb connection badge.

Actions:
- **📂 New Ratings CSV** — pick a new ratings export file; imports it and resets to the new baseline
- **📂 New Watchlist CSV** — pick a new watchlist/list CSV; reloads the watchlist while keeping all ratings and the TMDb cache intact
- **⚠ Reset to CSV** — discards all manual in-session mutations and reverts the entire state back to the originally imported CSV files
- **← Back to Setup** — returns to the setup wizard (useful if you want to change your TMDb key or import new files from scratch)

---

## ✏️ Live Mutations

All mutations update in memory immediately, persist to disk, and invalidate only the relevant caches — no TMDb calls are ever repeated for films already seen.

### Add Rating

Supports: Letterboxd URL, TMDb URL or numeric ID (auto-resolves title & year), or title + year manually. Half-star precision (0.5–5.0). Duplicate-safe via triple check: URL match, title+year match, and TMDb ID match.

After adding, the ranked watchlist automatically recalculates.

### Change Rating

Available on every card in the Rated Films section. Opens the star picker pre-filled with the current rating. On save, invalidates the taste model and ranked watchlist caches.

### Add to Watchlist

Supports: Letterboxd URL, TMDb URL or numeric ID, or title + year. If the film is already in your ratings, it's automatically moved to the rewatch list instead. Duplicate-safe (same triple check as above).

### Mark Watched & Rate

From any ranked watchlist card. Removes the film from the watchlist, prompts for a rating, adds it to your ratings, and moves it to rewatches. Rankings update live — the card disappears from the watchlist immediately.

### Remove from Watchlist

Permanently removes a film from the current watchlist state. Rankings update immediately.

### Reload Watchlist

Replace your watchlist with any new Letterboxd list export using the Settings drawer. The backend re-parses the CSV, recomputes the overlap (rewatches), and rebuilds the ranked watchlist — your ratings and TMDb cache are untouched.

### Hide Rewatch

Permanently hides a film from the ranked rewatch list. Stored in `hidden_rewatches.json` and survives restarts.

---

## 📤 Export Ranked Watchlist

Exports your ranked watchlist as a Letterboxd-compatible list CSV (v7 format), ready to import directly into a new Letterboxd list.

Options:
- **Watchlist only** — just your ranked unwatched films
- **Include rewatches** — combines watchlist + visible rewatches, re-scored and re-ranked together

The file downloads as `ranked-watchlist-YYYY-MM-DD.csv`.

To use it: create a new list on Letterboxd → Import → upload the CSV.

---

## 🔍 Taste Model Algorithm

### 1. Input Data

From your `ratings.csv` and `watchlist.csv`:
- Title, year, Letterboxd URL, your rating (0.5–5.0)
- Overlap detection: URL match first, then title+year fallback

### 2. TMDb Enrichment

For every film in both files, the backend fetches and permanently caches:
- Genres
- Directors & writers (from credits)
- Production countries → mapped to regions (Europe, Asia, North America, etc.)
- Release year → decade (1970s, 1980s, …)
- Keywords (themes, mood, tone)
- Collection / franchise membership
- TMDb community vote average

### 3. Taste Profiles (Bayesian-smoothed)

A profile is built for every dimension using Bayesian smoothing with k=5, pulling low-sample keys toward your global mean to avoid over-fitting on one or two films:

```
smoothedScore[key] = (totalRating + globalMean × 5) / (count + 5)
```

Profiles built: genre, director, writer, country, region, decade, keyword, collection.

### 4. Nearest-Neighbour Component

For each candidate film, the model finds the most similar films in your rating history using Jaccard similarity over genres, keywords, decade, regions, and directors:

```
filmSim = 0.50 × genreJaccard + 0.35 × keywordJaccard + 0.20 × regionJaccard + 0.15 × directorMatch + 0.15 × eraScore
```

Top 30 neighbours above a 0.12 similarity threshold are used. The component confidence scales with the number of neighbours found (saturates at 8+).

### 5. Final Weighted Score

```
predictedScore =
  0.18 × genreAffinity        +
  0.22 × keywordAffinity      +
  0.10 × directorAffinity     +
  0.08 × writerAffinity       +
  0.15 × tmdbScoreNorm        +
  0.10 × neighbourSimilarity  +
  0.07 × geoAffinity          +
  0.05 × decadeAffinity       +
  0.05 × collectionAffinity
```

Weights sum to **1.00**. All components are normalized to 0–1 before weighting.

### 6. Ranking

Scores are converted to a match percentage and sorted descending. Rewatches use the separate anchored formula above and are ranked independently.

---

## 💾 Cache System

| File | What it stores |
|------|---------------|
| `tmdb_cache.json` | Every TMDb API response ever fetched — never re-fetched |
| `derived_cache.json` | Taste model, ranked watchlist, rewatch ranking |
| `data_state.json` | Live ratings + watchlist + overlap (survives restarts) |
| `hidden_rewatches.json` | Permanently hidden rewatch entries |

**First run** — slow, fetches TMDb data for every film in both CSVs.  
**Every subsequent run** — instant, loads everything from disk.  
**After mutations** — only affected caches are invalidated; TMDb data is never re-fetched.

### Full Wipe (Fresh Start)

Delete the entire user data folder:

| Platform | Command |
|----------|---------|
| Windows  | Delete `%APPDATA%\Taste Matcher\` in Explorer, or: `Remove-Item "$env:APPDATA\Taste Matcher" -Recurse -Force` |
| macOS    | `rm -rf ~/Library/Application\ Support/Taste\ Matcher/` |
| Linux    | `rm -rf ~/.config/Taste\ Matcher/` |

Restart the app — it will open the setup wizard.

### Partial Wipe (Keep TMDb Cache)

If you only want to reset your data (new CSVs, fresh state) but don't want to re-fetch all the TMDb metadata, use **"Reset to CSV"** in the Settings drawer, or manually delete only `data_state.json` and `derived_cache.json` from the cache folder.

---

## 🔌 API Reference

The Express server runs on `http://127.0.0.1:47291` internally. All routes are also accessible from a browser if you want to inspect raw data.

| Route | Method | Description |
|-------|--------|-------------|
| `/api/ratings` | GET | Raw ratings array |
| `/api/watchlist` | GET | Watchlist after removing rewatches |
| `/api/overlap` | GET | Full rewatch list with TMDb metadata |
| `/api/genre-profile` | GET | Bayesian genre taste model |
| `/api/genre-titles/:id` | GET | All rated films in a genre |
| `/api/search-ratings?q=` | GET | Search rated films by title; `?all=true` returns all |
| `/api/recommendations` | GET | Ranked watchlist |
| `/api/rewatch-ranking` | GET | Ranked rewatch list |
| `/api/failed-items` | GET | Unresolved films list |
| `/api/app-status` | GET | Stats for the settings panel |
| `/api/export-ranked-watchlist` | GET | Download ranked Letterboxd CSV (`?includeRewatches=true\|false`) |
| `/api/reload-watchlist` | POST | Re-parse watchlist CSV, recompute overlap, keep ratings intact |
| `/api/reset-state` | POST | Revert all state to original CSV baseline |
| `/api/invalidate-recommendations` | POST | Force a fresh recalculation on next `/api/recommendations` call |
| `/api/mark-watched` | POST | Remove from watchlist → add/update rating → move to rewatches |
| `/api/add-rating` | POST | Add a new rating (TMDb URL/ID supported, triple duplicate-safe) |
| `/api/update-rating` | POST | Change the rating on an existing entry |
| `/api/add-to-watchlist` | POST | Add a film to the watchlist (rewatch-aware, triple duplicate-safe) |
| `/api/remove-from-watchlist` | POST | Remove a film from the current watchlist |
| `/api/hide-rewatch` | POST | Permanently hide a film from the rewatch list |

---

## 📜 License

MIT — see [LICENSE](./LICENSE) for full details.

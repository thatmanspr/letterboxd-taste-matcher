### Full Youtube Guide

[![Watch the video](https://img.youtube.com/vi/gZmlPXZjs9s/0.jpg)](https://www.youtube.com/watch?v=gZmlPXZjs9s)

# 🎬 Taste Matcher – Letterboxd + TMDb Watchlist Ranker

Taste Matcher is a backend-first Node.js project that:

- Reads your **Letterboxd ratings CSV**
- Reads your **Letterboxd watchlist CSV** (or any list export)
- Removes **rewatches** (movies appearing in both files)
- Builds a **multi-dimensional taste model** using TMDb metadata:
  - genres
  - directors & writers
  - countries & regions
  - decades / eras
  - keywords (mood / tone / themes)
  - collections (franchises / sagas)
- Blends that with a **nearest-neighbour similarity layer** (films most similar to what you already love)
- Predicts how much you'll like every film in your watchlist
- Ranks the entire watchlist from **most-likely-to-enjoy → least**

Includes a clean UI with:

- ⭐ Rewatch list (posters + your rating)
- ⭐ Genre profile (clickable, expands into films per genre)
- ⭐ Ranked watchlist (full cards + match percentage)

Everything runs **locally**, no frontend frameworks, no database.

---

## 🧱 Tech Stack

- **Node.js + Express** (backend)
- **TMDb API** (movie/TV metadata)
- **csv-parse** (Letterboxd CSV reading)
- **HTML + CSS + vanilla JS** (frontend)
- **Disk caching** (no repeated TMDb calls)

---

## 📁 Project Structure

```
taste-matcher/
├─ data/
│  ├─ ratings.csv           # your ratings (Letterboxd export)
│  └─ watchlist.csv         # your watchlist or any list export (renamed)
├─ public/
│  ├─ css/
│  │  └─ main.css
│  ├─ js/
│  │  └─ app.js
│  └─ index.html
├─ cache/
│  ├─ tmdb_cache.json       # TMDb responses saved here
│  ├─ derived_cache.json    # taste model + recommendations + rewatch ranking
│  ├─ hidden_rewatches.json # rewatches you chose to hide from ranking
│  └─ data_state.json       # persisted ratings + watchlist + overlap state
├─ exported/
│  └─ ranked-watchlist-*.csv  # Letterboxd-ready list exports
├─ server.js                # backend logic
├─ .env                     # TMDb API key + PORT
└─ package.json
```

> ⚠️ IMPORTANT:
> Do NOT commit `.env`, `/data/*`, or `/cache/*` to a public GitHub repo.

---

## 1️⃣ Requirements

- Node.js **18+**
- TMDb **Developer API Key**
- Letterboxd:
  - `ratings.csv`
  - `watchlist.csv` (or any list export renamed to `watchlist.csv`)

---

## 2️⃣ Getting Your Letterboxd CSV Files

Place your CSVs inside:

`taste-matcher/data/`

### 🔹 Ratings Export

1. Letterboxd → **Settings → Data → Export**
2. Download **ratings.csv**
3. This will usually not be the case, but in case the file is not named `ratings.csv`, rename it.

### 🔹 Watchlist Export (now fully universal)

Taste Matcher accepts **any** Letterboxd-generated list CSV:

- "Watchlist → Export" (official format)
- Any custom list export
- Old/legacy list formats

Just rename your chosen file to: `watchlist.csv`

When you put the file into `taste-matcher/data/`, **make sure** it's renamed to `watchlist.csv`.

Then click **Reload Watchlist** inside the UI to apply a new list instantly without restarting the server.

---

## 3️⃣ Setting Up TMDb API Key

Go to: https://www.themoviedb.org/settings/api

Generate an API key → V3 authentication.

Edit `.env`:

```
TMDB_API_KEY=YOUR_KEY_HERE
PORT=3000
```

> `.env` is already included. You only fill in your key.

---

## 4️⃣ Install Dependencies

Make sure you are inside the project folder:

```
cd taste-matcher
```

Run:

```
npm init -y
npm install express axios csv-parse dotenv
```

This installs: express, axios, csv-parse, dotenv.

If this completes without errors, you're good.

### Verify installation

```
node -v
npm -v
```

You should see Node **18 or higher**. Any npm version is fine.

---

## 5️⃣ Start the Server

```
node server.js
```

### On first run:
- Loads CSVs
- Calls TMDb (movie/TV search + details)
- Builds genre profile
- Builds ranked watchlist
- Saves everything to `/cache/`

### On later runs:
- Loads from disk cache
- Zero API calls
- Instant startup

---

## 6️⃣ Open the UI

Open: http://localhost:3000/

---

## ⭐ Rewatches (Removed From Ranking)

Movies found in both your ratings and watchlist.

Each card shows:

- Poster
- Title + Year
- Genres
- TMDb rating
- **Your rating**
- Link to Letterboxd

These are **excluded from recommendations**, but their ratings are **included** in taste calculation.

---

## ⭐ Interactive Features (Live Editing, Instant Re-Ranking)

Taste Matcher supports full **live mutation** of your data — no need to re-export CSVs unless you want to.

### ✅ Add a new rating (manual)

Supports:
- Title
- Year (optional)
- Letterboxd URL (optional)
- **TMDb URL or ID (recommended — auto-fills title & year)**
- Your rating

The backend:
- Resolves TMDb metadata (only once — cached)
- Prevents duplicates via **triple check** (URL + title+year + TMDb ID)
- Updates the taste model
- Re-ranks both watchlist + rewatches instantly
- Never re-calls TMDb for previously seen films

### ✅ Add a film to your watchlist (manual)

Supports:
- Title
- Year
- Letterboxd URL
- **TMDb URL/ID for instant, accurate metadata**

The backend:
- Rejects duplicates (triple check: URL + title+year + TMDb ID)
- If it's already rated → automatically moves it to **rewatches**
- Otherwise adds it to the watchlist
- Updates ranking without extra TMDb calls

### ✅ Mark a film as "Watched"

For any film in your watchlist:
- Removes it from the watchlist
- Prompts for a rating
- Adds/updates the rating
- Moves it to the **rewatch list**
- Recomputes taste model + rankings instantly

### ✅ Remove from Watchlist

Permanently removes a film from your current watchlist snapshot without rating it. Rankings update instantly.

### ✅ Ranked Rewatches

Rewatches are ranked by a formula that keeps **your rating as the anchor**, with the taste model acting as a modifier:

```
rewatchScore = userRatingNorm × (0.70 + 0.30 × modelScore)
```

- A 5★ film the model also loves → up to **1.00**
- A 5★ film the model disagrees with → **0.70** (still high)
- A 2★ film the model loves → max ~**0.52** (can't sneak above your 3★+ films)

This gives you a priority list of films you're most likely to enjoy rewatching, without letting the model override your own taste.

### ✅ Hide a Rewatch

Click **"Hide from rewatches"** on any rewatch card to remove it from the ranked rewatch list. Persists across restarts.

### ⚡ TMDb metadata is fetched only once

All metadata — genres, directors, writers, keywords, collections, etc. — is cached permanently.
Future operations reuse this cached data and never touch TMDb again.

---

## ⭐ Genre Profile (Interactive)

Shows:

- Average rating you give each genre
- Number of films in that genre
- Visual preference bars

**Click a genre card → expands into all films you rated in that genre.**

Includes posters + your rating. Search within the genre list.

---

## ⭐ Ranked Watchlist

Your entire watchlist is ranked using a full **multi-factor taste model**, enriched with TMDb data and your entire rating history.

### What influences your ranking:

- **Genre affinity** – how much you like its genres
- **Keyword affinity** – mood/theme/tone similarity using TMDb keywords
- **Director affinity** – how much you like the directors' other work
- **TMDb community rating** – normalized quality baseline
- **Neighbour similarity** – how close this film is to your highest-rated films (k-NN over genres/keywords/era/regions/directors)
- **Writer affinity** – how much you like their screenwriters
- **Geography affinity** – how highly you rate films from similar film cultures
- **Decade affinity** – taste for specific eras (70s, 90s, 2010s, etc.)
- **Collection affinity** – franchise/universe you already enjoy

These are normalized (0–1), weighted, and turned into a **predictedScore** for every watchlist film.

### UI includes:

- Poster
- Title + year
- Genres
- TMDb rating
- Match percentage (color-coded bar)
- Rank number
- Score breakdown pills (top contributors)
- Director names

### Filters:

- **Text search** — filter by title or genre
- **Year** — exact year (e.g. `2019`)
- **Decade** — e.g. `1990s`
- **Director** — All / Only watched directors / Only new directors

---

## ⭐ Export Ranked Watchlist to Letterboxd

Once your watchlist is ranked, you can export it as a **Letterboxd list CSV** to import straight into a new List on Letterboxd.

From the UI:

- Click **"Export Ranked Watchlist → Letterboxd"**
- Choose whether to **include rewatches** in the exported list:
  - **OK** → watchlist items + visible rewatches, ranked together
  - **Cancel** → watchlist items only

The browser downloads the CSV directly. Then:

1. Create a new list on Letterboxd
2. Use their "Import" feature
3. Upload the generated CSV
4. Get your Taste Matcher ranking as a Letterboxd list in one go

---

## 7️⃣ API Endpoints

| Route | Method | Description |
|-------|--------|-------------|
| `/api/ratings` | GET | Raw ratings list |
| `/api/watchlist` | GET | Watchlist after removing rewatches |
| `/api/overlap` | GET | Full rewatch list (with metadata) |
| `/api/genre-profile` | GET | Multi-dimensional taste model |
| `/api/genre-titles/:id` | GET | Rated films filtered by genre |
| `/api/recommendations` | GET | Ranked watchlist |
| `/api/rewatch-ranking` | GET | Ranked rewatch list |
| `/api/export-ranked-watchlist` | GET | Export ranked Letterboxd list CSV (`?includeRewatches=true\|false`) |
| `/api/reload-watchlist` | POST | Reload `watchlist.csv` only — keeps ratings + taste model intact |
| `/api/reset-state` | POST | Reset everything back to the original CSV baseline |
| `/api/mark-watched` | POST | Remove from watchlist → add/update rating, move to rewatches |
| `/api/add-rating` | POST | Add a rating (TMDb URL/ID supported, triple duplicate-safe) |
| `/api/add-to-watchlist` | POST | Add a film to watchlist (rewatch-aware, triple duplicate-safe) |
| `/api/remove-from-watchlist` | POST | Permanently remove a title from the current watchlist |
| `/api/hide-rewatch` | POST | Hide a rewatch so it never appears in ranked rewatches |

### 🔁 Hot Reload Watchlist

- Replace `data/watchlist.csv` with any Letterboxd export
- Press **"Reload Watchlist"** in the UI (or POST `/api/reload-watchlist`)
- The backend:
  - Parses any watchlist/list CSV format
  - Recomputes overlap (rewatches)
  - Keeps your ratings cache + taste model intact
  - Rebuilds recommendations instantly

### 🔄 Reset State to CSV

If you've made manual mutations and want to start fresh:

- Press **"Reset state to CSV"** in the UI (or POST `/api/reset-state`)
- Reverts ratings, watchlist, and overlap back to what's in your CSV files
- Clears all hidden rewatches

---

## 8️⃣ Cache System

The server persists data into:

```
cache/
  tmdb_cache.json        # TMDb metadata for every film you've touched
  derived_cache.json     # taste model + recommendations + rewatch ranking
  hidden_rewatches.json  # rewatches you've chosen to hide
  data_state.json        # current ratings + watchlist + overlap (instant restarts)
```

### What this means:

- First run → slow (lots of TMDb calls)
- Every later run → instant
- Manual mutations (add rating, mark watched, etc.) survive restarts via `data_state.json`

### When to delete cache:

- You updated your Letterboxd CSVs and want a full rebuild
- You changed the taste model algorithm
- You want a clean slate

> You can also use **"Reset state to CSV"** in the UI to revert data without deleting the TMDb cache.

**macOS / Linux:**
```
rm -rf cache
```

**Windows PowerShell:**
```
Remove-Item cache -Recurse -Force
```

Then restart:
```
node server.js
```

---

## 🔍 Taste Model Algorithm

Taste Matcher builds a **multi-dimensional taste vector** from your Letterboxd ratings and applies it to every film in your watchlist.

### 1. Data Inputs

From `ratings.csv` and `watchlist.csv`:
- Title, year
- Your rating (0–5)
- Letterboxd URL
- Rewatch detection via URL matching **and** title+year fallback

### 2. TMDb Metadata (enriched & cached)

For every film (ratings + watchlist):
- Genres
- Directors / Writers
- Production countries → Regions (Europe, Asia, NA, etc.)
- Release year → Decade (1980s, 2010s…)
- Keywords (themes, tone, mood)
- Collection ID & name (sagas, franchises)
- vote_average (community baseline)

### 3. Taste Profiles

From all your rated films, the backend builds Bayesian-smoothed profiles:

```
genreProfile[genreId]
directorProfile[name]
writerProfile[name]
countryProfile["US"/"JP"/etc]
regionProfile["Asia"/"Europe"]
decadeProfile[1970, 1980...]
keywordProfile["surrealism", "slow-burn"...]
collectionProfile[id]
```

Each value = weighted average of your ratings for that factor, pulled toward your global mean for low-sample keys.

### 4. Nearest-Neighbour Similarity

For each watchlist film, the model finds the most similar films in your rated history using **Jaccard similarity** over genres, keywords, decade, regions, and directors. The top 30 neighbours (above a 0.12 similarity threshold) are used to compute a weighted-rating score.

```
filmSim = 0.50 × genreJaccard + 0.35 × keywordJaccard + 0.20 × regionJaccard + 0.15 × directorMatch + 0.15 × eraScore
neighbourSimilarity = Σ(sim × rating) / Σ(sim) × confidence
```

Confidence scales with the number of neighbours found (saturates at 8+).

### 5. Final Weighted Score

```
predictedScore =
  0.18 × genreAffinity       +
  0.22 × keywordAffinity     +
  0.10 × directorAffinity    +
  0.15 × tmdbScoreNorm       +
  0.10 × neighbourSimilarity +
  0.08 × writerAffinity      +
  0.07 × countryRegionAffinity +
  0.05 × decadeAffinity      +
  0.05 × collectionAffinity
```

All weights sum to **1.00**.

### 6. Ranking

- Converted to percent match
- Sorted descending
- Rendered as your ranked watchlist

Rewatches receive a separate ranking:

```
rewatchScore = userRatingNorm × (0.70 + 0.30 × predictedScore)
```

---

## 🐛 Bugs Fixed in v2

| Fix | Description |
|-----|-------------|
| **Overlap detection** | Now uses URL match first, with title+year as fallback. Films with different URL formats but the same title/year are correctly identified as rewatches. |
| **Unified scoring function** | A single shared `scoreItem()` is used by watchlist ranking, rewatch ranking, and export. Previously the export used a different code path and could return a different order than the UI. |
| **Rewatch ranking formula** | Old formula (`0.6 × rating + 0.4 × model`) allowed low-rated films to rank above high-rated ones if the model disagreed. New formula anchors to rating and only nudges ±30%. |
| **Triple duplicate check** | `add-rating` and `add-to-watchlist` now check for duplicates by URL, by title+year, and by TMDb ID — preventing phantom duplicates when a film is added by different methods. |
| **Export format** | Export now uses the correct Letterboxd list export v7 format and streams as a direct browser download instead of writing a file to disk. |
| **Derived cache invalidation** | Old `derived_cache.json` entries missing `ratedItemsMeta` (required by the neighbour component) are now detected and discarded on load, forcing a clean rebuild. |

---

## 9️⃣ Quickstart Summary

```
git clone <repo>
cd taste-matcher
# add ratings.csv & watchlist.csv to /data/
# add TMDB_API_KEY to .env
npm init -y
npm install express axios csv-parse dotenv
node server.js
# open http://localhost:3000/
```

Done. Enjoy your personalized watchlist ranking ✨

---

## 📜 License

MIT License – see [LICENSE](./LICENSE) for full details.

'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path   = require('path');
const fs     = require('fs');
const http   = require('http');
const https  = require('https');

// ─── User-data config path ────────────────────────────────────────────────────
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const DATA_DIR    = path.join(app.getPath('userData'), 'data');
const CACHE_DIR   = path.join(app.getPath('userData'), 'cache');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); }
  catch { return {}; }
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ─── Server management ────────────────────────────────────────────────────────
let serverPort    = 47291;
let mainWindow    = null;

function waitForServer(port, retries = 40) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      const req = http.get(`http://127.0.0.1:${port}/api`, res => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (++attempts >= retries) return reject(new Error('Server did not start'));
        setTimeout(check, 300);
      });
      req.end();
    };
    check();
  });
}

let serverStarted = false;

function startServer(config) {
  // Set env vars before requiring server.js so it picks them up at module level
  process.env.PORT         = String(serverPort);
  process.env.TMDB_API_KEY = config.tmdbApiKey || '';
  process.env.TM_DATA_DIR  = DATA_DIR;
  process.env.TM_CACHE_DIR = CACHE_DIR;

  if (serverStarted) {
    // Already running in-process, just resolve
    return Promise.resolve();
  }

  serverStarted = true;
  const { startServer: runServer } = require('../server.js');
  return runServer(serverPort);
}

function stopServer() {
  // No child process to kill — server runs in-process
}

// ─── Window creation ──────────────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 560,
    autoHideMenuBar: true,
    webPreferences: {
      preload:         path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false
    },
    titleBarStyle: 'default',
    title: 'Taste Matcher'
  });

  const cfg = loadConfig();
  const isSetup = !cfg.tmdbApiKey || !cfg.ratingsPath;

  if (isSetup) {
    mainWindow.loadFile(path.join(__dirname, 'setup.html'));
  } else {
    launchApp(cfg);
  }

  // Open external links in OS browser, not Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

async function launchApp(cfg) {
  mainWindow.loadFile(path.join(__dirname, 'loading.html'));
  try {
    await startServer(cfg);
    mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
  } catch (e) {
    console.error('Failed to launch app:', e);
    mainWindow.loadFile(path.join(__dirname, 'error.html'));
  }
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

// Open file picker dialog
ipcMain.handle('pick-file', async (_, { title, filters }) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title,
    filters,
    properties: ['openFile']
  });
  return result.canceled ? null : result.filePaths[0];
});

// Copy a picked CSV into the userData data dir with a fixed name
ipcMain.handle('install-csv', async (_, { sourcePath, destName }) => {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const dest = path.join(DATA_DIR, destName);
    fs.copyFileSync(sourcePath, dest);
    return { ok: true, dest };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Validate TMDB key by hitting a cheap endpoint
ipcMain.handle('validate-tmdb-key', async (_, apiKey) => {
  try {
    const res = await new Promise((resolve, reject) => {
      const req = https.get(
        `https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(apiKey)}`,
        res => {
          let body = '';
          res.on('data', d => body += d);
          res.on('end', () => resolve({ status: res.statusCode, body }));
        }
      );
      req.on('error', reject);
      req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    });
    if (res.status === 200) return { ok: true };
    const parsed = JSON.parse(res.body).status_message || 'Invalid key';
    return { ok: false, error: parsed };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Save config and (re)launch app
ipcMain.handle('save-config', async (_, cfg) => {
  saveConfig(cfg);
  if (cfg.ratingsPath)  { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.copyFileSync(cfg.ratingsPath,  path.join(DATA_DIR, 'ratings.csv'));  } catch {} }
  if (cfg.watchlistPath){ try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.copyFileSync(cfg.watchlistPath,path.join(DATA_DIR, 'watchlist.csv')); } catch {} }
  await launchApp(cfg);
  return { ok: true };
});

ipcMain.handle('load-config', () => loadConfig());

ipcMain.handle('go-to-settings', () => {
  stopServer();
  mainWindow.loadFile(path.join(__dirname, 'setup.html'));
});

ipcMain.handle('open-external', (_, url) => shell.openExternal(url));

// ─── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(createMainWindow);

app.on('window-all-closed', () => {
  stopServer();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

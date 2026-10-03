'use strict';
const { app, BrowserWindow, ipcMain, safeStorage, shell, session, Tray, Menu, Notification, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const QRCode = require('qrcode');
const SteamService = require('./steam-service');
const { readLocalSchema } = require('./ach-schema');
const { t, LANG } = require('./lang');
const { StatsStore, fmtMs } = require('./stats');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

const APP_NAME = 'RCK Steam Manager';
app.setAppUserModelId('com.rck.steammanager');
const ICON_PNG = path.join(__dirname, 'assets', 'icon.png');
const ICON_ICO = path.join(__dirname, 'assets', 'icon.ico');
const AUTOSTART = process.argv.includes('--autostart');

const DEFAULTS = {
  selected: [], rotateMin: 30, muted: false, groupMode: true, lists: [], lastIdle: null,
  autoStart: false, startHidden: false, autoIdle: false, closeToTray: true, minToTray: true,
  persona: 'online', notify: true, lang: 'tr', theme: 'aurora', steamApiKey: ''
};

let prefs = Object.assign({}, DEFAULTS);
const tt = (key, vars) => t(prefs.lang, key, vars);

const steam = new SteamService(() => prefs.lang);
const ach = { running: false, cancel: false, child: null };
let win = null;
let tray = null;
let quitting = false;
let trayTipShown = false;
let remember = false;
let pendingAuto = null;
let lastBlocked = 0;
let stats = null; // app ready sonrası
let lastAchOp = null; // geri alma için son başarım işlemi
let lastIdleSnapshot = null; // oturum özeti için

const send = (ch, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(ch, payload);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const ids = (arr) => Array.from(new Set((Array.isArray(arr) ? arr : []).map(Number).filter((n) => Number.isInteger(n) && n > 0)));
const gameName = (id) => {
  const g = steam.games.find((x) => x.appid === id);
  return g ? g.name : 'Oyun ' + id;
};

// ---- küçük dosya deposu (log yok) ----------------------------------------
const file = (name) => path.join(app.getPath('userData'), name);
const readJson = (name, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch (e) {
    return fallback;
  }
};
const writeJson = (name, value) => {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(file(name), JSON.stringify(value));
  } catch (e) {
    /* yoksay */
  }
};

// Eski "RCK Steam Idle" klasöründeki ayarları ve kayıtlı oturumu yeni klasöre taşı
function migrateOld() {
  try {
    const old = path.join(app.getPath('appData'), 'RCK Steam Idle');
    if (old === app.getPath('userData') || !fs.existsSync(old)) return;
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    for (const f of ['prefs.json', 'session.json']) {
      if (!fs.existsSync(file(f)) && fs.existsSync(path.join(old, f))) fs.copyFileSync(path.join(old, f), file(f));
    }
  } catch (e) {
    /* yoksay */
  }
}

function cleanLists(arr) {
  return (Array.isArray(arr) ? arr : []).slice(0, 60).map((l) => ({
    id: String((l && l.id) || '').slice(0, 40) || 'l' + Math.random().toString(36).slice(2, 10),
    name: String((l && l.name) || '').trim().slice(0, 40) || 'Liste',
    ids: ids(l && l.ids).slice(0, 5000)
  }));
}

// Renderer'dan gelen ayarları süzer: sadece bilinen anahtarlar ve doğru tipler geçer
function cleanPrefs(p) {
  const out = {};
  if (!p || typeof p !== 'object') return out;
  if (Array.isArray(p.selected)) out.selected = ids(p.selected).slice(0, 5000);
  if (Number.isFinite(Number(p.rotateMin))) out.rotateMin = clamp(Number(p.rotateMin), 5, 240);
  for (const k of ['muted', 'groupMode', 'autoStart', 'startHidden', 'autoIdle', 'closeToTray', 'minToTray', 'notify']) {
    if (typeof p[k] === 'boolean') out[k] = p[k];
  }
  if (['online', 'invisible', 'keep'].includes(p.persona)) out.persona = p.persona;
  if (['tr', 'en'].includes(p.lang)) out.lang = p.lang;
  if (typeof p.theme === 'string') {
    const map = { steam: 'aurora', bordo: 'goth', emerald: 'aurora', violet: 'nova', slate: 'aurora' };
    const t = map[p.theme] || p.theme;
    if (['aurora', 'goth', 'nova'].includes(t)) out.theme = t;
  }
  // Steam Web API anahtarı 32 karakterlik onaltılık bir metindir; boşluk ve garip karakterleri at.
  if (typeof p.steamApiKey === 'string') out.steamApiKey = p.steamApiKey.replace(/[^A-Za-z0-9]/g, '').slice(0, 64);
  if (Array.isArray(p.lists)) out.lists = cleanLists(p.lists);
  if (p.lastIdle === null) out.lastIdle = null;
  else if (p.lastIdle && typeof p.lastIdle === 'object') {
    const l = ids(p.lastIdle.ids).slice(0, 5000);
    out.lastIdle = l.length ? { ids: l, rotateMin: clamp(Number(p.lastIdle.rotateMin) || 30, 5, 240), groupMode: p.lastIdle.groupMode !== false } : null;
  }
  return out;
}

// Şifre hiçbir zaman saklanmaz. "Hatırla" açıksa sadece Windows ile şifrelenmiş giriş anahtarı saklanır.
const canRemember = () => {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch (e) {
    return false;
  }
};
function saveSession(accountName, token) {
  if (!canRemember() || !accountName || !token) return;
  writeJson('session.json', { accountName, token: safeStorage.encryptString(token).toString('base64') });
}
function loadSession() {
  const s = readJson('session.json', null);
  if (!s || !s.accountName || !s.token) return null;
  try {
    return { accountName: s.accountName, token: safeStorage.decryptString(Buffer.from(s.token, 'base64')) };
  } catch (e) {
    return null;
  }
}
function forgetSession() {
  try {
    fs.unlinkSync(file('session.json'));
  } catch (e) {
    /* yoksay */
  }
}

// ---- bildirim --------------------------------------------------------------
function notify(title, body, always) {
  if (!prefs.notify) return;
  if (!always && win && win.isVisible() && win.isFocused()) return;
  try {
    if (Notification.isSupported()) new Notification({ title, body, icon: ICON_PNG }).show();
  } catch (e) {
    /* yoksay */
  }
}

// ---- pencere ve tepsi ---------------------------------------------------------
function hideToTray() {
  if (!tray) {
    prefs.closeToTray = true;
    prefs.minToTray = true;
    ensureTray();
  }
  if (win && !win.isDestroyed()) win.hide();
  if (!trayTipShown && tray) {
    trayTipShown = true;
    notify(APP_NAME, tt('be.close.trayTip'));
  }
}

function showWindow() {

  if (!win) createWindow(true);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function ensureTray() {
  const need = prefs.closeToTray || prefs.minToTray || prefs.startHidden;
  if (need && !tray) {
    try {
      let img = nativeImage.createFromPath(process.platform === 'win32' ? ICON_ICO : ICON_PNG);
      if (process.platform !== 'win32') img = img.resize({ width: 22, height: 22 });
      tray = new Tray(img);
      tray.on('click', showWindow);
      tray.on('double-click', showWindow);
      refreshTray();
    } catch (e) {
      tray = null;
    }
  } else if (!need && tray) {
    tray.destroy();
    tray = null;
  }
}

function startLast() {
  const l = prefs.lastIdle;
  if (!l || !l.ids.length) return { ok: false };
  if (steam.idle.on) onIdleStopRecord();
  const r = steam.startIdle(l.ids, l.rotateMin, l.groupMode);
  if (r.ok) onIdleStartRecord(r.list);
  return r;
}

function refreshTray() {
  if (!tray) return;
  const i = steam.idleInfo();
  const canStart = steam.status === 'ready' && !!(prefs.lastIdle && prefs.lastIdle.ids.length);
  tray.setToolTip(`${APP_NAME}\n${i.on ? tt('be.tray.idleOnN', { n: i.playing }) : tt('be.tray.idleOff')}`);
  const idleLabel = i.on
    ? (i.paused ? tt('be.tray.idlePaused') : (i.blockedBy ? tt('be.tray.idleBlocked') : tt('be.tray.idleOnN', { n: i.playing })))
    : tt('be.tray.idleOff');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: tt('be.tray.open'), click: showWindow },
    { type: 'separator' },
    { label: idleLabel, enabled: false },
    i.on
      ? { label: tt('be.tray.stopIdle'), click: () => { onIdleStopRecord(); steam.stopIdle(); refreshTray(); } }
      : { label: tt('be.tray.startLast'), enabled: canStart, click: () => {
          const r = startLast();
          if (r.ok) onIdleStartRecord(r.list || (prefs.lastIdle && prefs.lastIdle.ids) || []);
          refreshTray();
        } },
    { type: 'separator' },
    { label: tt('be.tray.stats'), click: () => { showWindow(); send('ui:open-tab', 'stats'); } },
    { type: 'separator' },
    { label: tt('be.tray.quit'), click: async () => {
      const res = await dialog.showMessageBox(win || undefined, {
        type: 'question',
        title: APP_NAME,
        message: tt('be.close.message'),
        detail: tt('be.close.quitDetail'),
        buttons: [tt('be.close.quit'), tt('be.close.cancel')],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      });
      if (res.response === 0) { quitting = true; app.quit(); }
    } }
  ]));
}

function applyAutoStart() {
  try {
    const opts = { openAtLogin: !!prefs.autoStart };
    if (app.isPackaged) {
      opts.path = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
      opts.args = ['--autostart'];
    } else {
      opts.path = process.execPath;
      opts.args = [app.getAppPath(), '--autostart'];
    }
    app.setLoginItemSettings(opts);
  } catch (e) {
    /* yoksay */
  }
}

function applyPrefs(keys) {
  if (keys.includes('autoStart')) applyAutoStart();
  if (['closeToTray', 'minToTray', 'startHidden'].some((k) => keys.includes(k))) ensureTray();
  if (keys.includes('persona')) steam.setPersonaMode(prefs.persona);
  if (keys.includes('lang')) refreshTray();
}

function createWindow(show) {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 980,
    minHeight: 660,
    show,
    backgroundColor: '#0e141b',
    title: APP_NAME,
    icon: process.platform === 'win32' ? ICON_ICO : ICON_PNG,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });
  win.removeMenu();
  try {
    const ic = process.platform === 'win32' ? ICON_ICO : ICON_PNG;
    if (fs.existsSync(ic)) win.setIcon(ic);
  } catch (e) { /* yoksay */ }
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', async (e) => {
    if (quitting) return;
    e.preventDefault();
    // Tepsi yoksa oluştur (kullanıcı tepsiye gönderebilsin)
    if (!tray) {
      prefs.closeToTray = true;
      prefs.minToTray = true;
      ensureTray();
    }
    const buttons = tray
      ? [tt('be.close.toTray'), tt('be.close.quit'), tt('be.close.cancel')]
      : [tt('be.close.quit'), tt('be.close.cancel')];
    const res = await dialog.showMessageBox(win, {
      type: 'question',
      title: APP_NAME,
      message: tt('be.close.message'),
      detail: tt('be.close.detail'),
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
      noLink: true
    });
    if (tray) {
      if (res.response === 0) { // tepsiye
        hideToTray();
      } else if (res.response === 1) { // kapat
        quitting = true;
        app.quit();
      }
    } else {
      if (res.response === 0) {
        quitting = true;
        app.quit();
      }
    }
  });
  win.on('minimize', (e) => {
    if (prefs.minToTray) {
      e.preventDefault();
      if (!tray) {
        prefs.minToTray = true;
        prefs.closeToTray = true;
        ensureTray();
      }
      if (tray) hideToTray();
    }
  });
  win.on('session-end', () => {
    quitting = true;
  });
  win.on('closed', () => {
    win = null;
  });
}

// ---- istatistik yardımcıları ------------------------------------------------
function gameListForStats(appids) {
  return (appids || []).map((id) => ({ id: Number(id), name: gameName(id) }));
}

function onIdleStartRecord(list) {
  if (!stats) return;
  stats.idleStart(gameListForStats(list));
}

function onIdleStopRecord() {
  if (!stats) return null;
  const summary = stats.idleStop();
  if (summary) {
    lastIdleSnapshot = summary;
    send('stats:session', summary);
  }
  return summary;
}

function rememberAchOp(mode, items) {
  // items: [{ appId, names: string[] }]
  lastAchOp = {
    mode,
    items: (items || []).map((it) => ({
      appId: Number(it.appId),
      names: Array.from(new Set((it.names || []).map(String))).slice(0, 2000)
    })).filter((it) => it.appId > 0 && it.names.length)
  };
  if (!lastAchOp.items.length) lastAchOp = null;
}

// ---- Steam olayları -> arayüz ---------------------------------------------
function trackBlocked(i) {
  const b = i.on && !i.paused ? i.blockedBy : 0;
  if (b && !lastBlocked) notify(tt('be.notify.idlePausedTitle'), tt('be.notify.idlePausedBody'));
  else if (!b && lastBlocked && i.on) notify(tt('be.notify.idleResumedTitle'), tt('be.notify.idleResumedBody'));
  lastBlocked = b;
}

steam.on('state', (s) => {
  send('steam:state', s);
  refreshTray();
});
steam.on('progress', (p) => send('steam:progress', p));
steam.on('games', (g) => {
  send('steam:games', g);
  if (pendingAuto) {
    const a = pendingAuto;
    pendingAuto = null;
    const r = steam.startIdle(a.ids, a.rotateMin, a.groupMode);
    if (r.ok) {
      onIdleStartRecord(r.list);
      notify(APP_NAME, tt('be.notify.idleStartedBody', { n: r.list.length }));
    }
  }
});
steam.on('idle', (i) => {
  const payload = Object.assign({}, i);
  if (i.blockedBy) payload.blockedName = gameName(i.blockedBy);
  send('steam:idle', payload);
  refreshTray();
  trackBlocked(i);
});
steam.on('failure', (f) => {
  if (f.tokenBad) forgetSession();
  send('steam:fail', f);
  if (pendingAuto) {
    // sessiz açılışta giriş yapılamadı: kullanıcının görmesi için pencereyi aç
    pendingAuto = null;
    showWindow();
    notify(APP_NAME, f.message);
  }
});
steam.on('token', (tok) => {
  if (remember) saveSession(tok.accountName, tok.token);
});
steam.on('qr', async (q) => {
  if (q.status === 'waiting' && q.url) {
    try {
      const image = await QRCode.toDataURL(q.url, {
        margin: 1,
        width: 420,
        errorCorrectionLevel: 'M',
        color: { dark: '#0e141b', light: '#e8f1f8' }
      });
      if (!image || typeof image !== 'string' || !image.startsWith('data:')) {
        send('steam:qr', { status: 'error', message: tt('login.qrGenFailed') });
        return;
      }
      send('steam:qr', { status: 'waiting', image });
    } catch (e) {
      const msg = (e && e.message) ? String(e.message).slice(0, 80) : '';
      send('steam:qr', { status: 'error', message: msg ? (tt('login.qrGenFailed') + ' (' + msg + ')') : tt('login.qrGenFailed') });
    }
  } else {
    send('steam:qr', q);
  }
});

function maybeAutoIdle() {
  if (!prefs.autoIdle) return;
  const s = loadSession();
  const last = prefs.lastIdle;
  if (!s || !last || !last.ids.length) return;
  pendingAuto = last;
  remember = true;
  steam.loginWithToken(s.accountName, s.token);
}

// ---- başarımlar ------------------------------------------------------------
async function fetchAchievements(appId) {
  const url = `https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v0002/?gameid=${appId}&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('http ' + res.status);
  const data = await res.json();
  const list = (data && data.achievementpercentages && data.achievementpercentages.achievements) || [];
  return list
    .map((a) => ({ name: String(a.name || ''), percent: Number(a.percent) || 0 }))
    .filter((a) => a.name);
}

// Steam'in dil adı: arayüz dili Türkçe ise Türkçe, değilse İngilizce iste.
const steamLang = () => (prefs.lang === 'en' ? 'english' : 'turkish');

// Başarımların gerçek adı, açıklaması ve görseli. Sadece kullanıcı kendi Web API
// anahtarını girdiyse istenir; herhangi bir hata olursa boş döner ve arayüz
// eskisi gibi teknik adları gösterir.
async function fetchSchema(appId) {
  const map = new Map();
  if (!prefs.steamApiKey) return map;
  try {
    const url = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${encodeURIComponent(prefs.steamApiKey)}&appid=${appId}&l=${steamLang()}&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return map;
    const data = await res.json();
    const list = (data && data.game && data.game.availableGameStats && data.game.availableGameStats.achievements) || [];
    const https = (u) => (u ? String(u).replace(/^http:/i, 'https:') : '');
    for (const a of list) {
      if (!a || !a.name) continue;
      map.set(String(a.name), {
        displayName: a.displayName ? String(a.displayName) : '',
        description: a.description ? String(a.description) : '',
        icon: https(a.icon),
        iconGray: https(a.icongray),
        hidden: Number(a.hidden) === 1
      });
    }
  } catch (e) {
    /* yoksay: anahtar yanlış olabilir ya da ağ yok */
  }
  return map;
}

// Kullanıcının başarımları hangi tarihte açtığı (unix saniyesi). Profil "oyun
// ayrıntıları" gizliyse Steam bunu vermez; o zaman tarih gösterilmez.
async function fetchUnlockTimes(appId, steamId64) {
  const map = new Map();
  if (!prefs.steamApiKey || !steamId64) return map;
  try {
    const url = `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v0001/?key=${encodeURIComponent(prefs.steamApiKey)}&appid=${appId}&steamid=${steamId64}&l=${steamLang()}&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return map;
    const data = await res.json();
    const ps = data && data.playerstats;
    const list = (ps && ps.success && ps.achievements) || [];
    for (const a of list) {
      const when = Number(a && a.unlocktime) || 0;
      if (a && a.apiname && Number(a.achieved) === 1 && when > 0) map.set(String(a.apiname), when);
    }
  } catch (e) {
    /* yoksay */
  }
  return map;
}

const workerPath = () => path.join(__dirname, 'ach-worker.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

// Worker sadece "error" kodu döner (init/input/crash); gösterilecek metni
// kullanıcının seçtiği dile göre burada üretiyoruz.
function achErrorMessage(code) {
  if (code === 'init') return tt('be.ach.clientConnectFailed');
  if (code === 'input') return tt('be.ach.invalidRequest');
  return tt('be.ach.unexpectedError');
}

function runWorker(appId, names, mode) {
  return new Promise((resolve) => {
    let result = null;
    let buf = '';
    let child;
    try {
      child = spawn(process.execPath, [workerPath()], {
        env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true
      });
    } catch (e) {
      resolve({ ok: false, error: 'spawn', message: tt('be.ach.helperSpawnFailed') });
      return;
    }
    ach.child = child;
    const timer = setTimeout(() => child.kill(), 240000);
    child.stdout.on('data', (d) => {
      buf += d;
      let n;
      while ((n = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, n).trim();
        buf = buf.slice(n + 1);
        if (!line) continue;
        try {
          const m = JSON.parse(line);
          if (m.type === 'result') {
            if (!m.ok && !m.message) m.message = achErrorMessage(m.error);
            result = m;
          } else send('ach:event', Object.assign({ appId, mode }, m));
        } catch (e) {
          /* yoksay */
        }
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, error: 'spawn', message: tt('be.ach.helperSpawnFailed') });
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(result || { ok: false, error: 'crash', message: tt('be.ach.helperCrashed') });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ appId, names, mode }));
  });
}

// Tek bir oyunun, seçilen başarımlarını açar ya da sıfırlar; hem çoklu-oyun
// akışı hem de tek oyun için "tek tek seç" akışı bunu paylaşır.
async function runGameAchievements(appId, names, mode) {
  let r = await runWorker(appId, names, mode);
  if (ach.cancel) r = { ok: false, message: tt('ach.cancelled') };
  return r;
}

async function runAch(list, mode) {
  ach.running = true;
  ach.cancel = false;
  const wasIdling = steam.idle.on && !steam.idle.paused;
  if (wasIdling) steam.pauseIdle();
  let total = 0;
  try {
    for (let i = 0; i < list.length && !ach.cancel; i++) {
      const appId = list[i];
      send('ach:event', { appId, mode, type: 'start', index: i, total: list.length });
      let meta = [];
      try {
        meta = await fetchAchievements(appId);
      } catch (e) {
        send('ach:event', { appId, mode, type: 'done', ok: false, message: tt('be.ach.fetchFailed') });
        continue;
      }
      if (!meta.length) {
        send('ach:event', { appId, mode, type: 'done', ok: false, message: tt('be.ach.noneAvailable') });
        continue;
      }
      const r = await runGameAchievements(appId, meta.map((m) => m.name), mode);
      send('ach:event', Object.assign({ appId, mode }, r, { type: 'done' }));
      if (r.ok && r.unlocked > 0) {
        total += r.unlocked;
        if (stats) stats.recordAch(appId, gameName(appId), mode, r.unlocked, r.names || []);
        // Steam'in kendi başarım balonu sadece oyunun içinde çıkar; bu yüzden bildirimi biz gösteriyoruz
        if (list.length <= 5) notify(gameName(appId), tt(mode === 'clear' ? 'be.notify.achResetBody' : 'be.notify.achUnlockedBody', { n: r.unlocked }), true);
      }
      if (r.error === 'init') {
        // Steam istemcisi yok: kalan oyunları da denemenin anlamı yok
        for (let j = i + 1; j < list.length; j++) {
          send('ach:event', { appId: list[j], mode, type: 'done', ok: false, message: tt('be.ach.skipped') });
        }
        break;
      }
      await sleep(1000);
    }
  } finally {
    ach.running = false;
    ach.child = null;
    if (wasIdling) steam.resumeIdle();
    if (list.length > 5 && total > 0 && !ach.cancel) {
      notify(
        tt(mode === 'clear' ? 'be.notify.achBulkResetTitle' : 'be.notify.achBulkUnlockedTitle'),
        tt(mode === 'clear' ? 'be.notify.achBulkResetBody' : 'be.notify.achBulkUnlockedBody', { games: list.length, n: total }),
        true
      );
    }
    // Geri alma: tüm oyunların tüm başarımları (liste modu) — isimleri sonradan çekmek zor;
    // sadece tek-oyun "some" yolunda isim tutuyoruz. Liste modunda undo kapalı kalır.
    send('ach:event', { type: 'finished', mode, cancelled: ach.cancel, total, games: list.length });
  }
}

// Tek bir oyunun, kullanıcının tek tek işaretlediği başarımlarını açar veya
// sıfırlar (bkz. ach:run-some / ach:clear-some).
async function runAchSome(appId, names, mode) {
  ach.running = true;
  ach.cancel = false;
  const wasIdling = steam.idle.on && !steam.idle.paused;
  if (wasIdling) steam.pauseIdle();
  send('ach:event', { appId, mode, type: 'start', index: 0, total: 1 });
  let r;
  try {
    r = await runGameAchievements(appId, names, mode);
  } finally {
    ach.running = false;
    ach.child = null;
    if (wasIdling) steam.resumeIdle();
  }
  send('ach:event', Object.assign({ appId, mode }, r, { type: 'done' }));
  if (r.ok && r.unlocked > 0) {
    if (stats) stats.recordAch(appId, gameName(appId), mode, r.unlocked, names);
    rememberAchOp(mode, [{ appId, names }]);
    notify(gameName(appId), tt(mode === 'clear' ? 'be.notify.achResetBody' : 'be.notify.achUnlockedBody', { n: r.unlocked }), true);
  }
  send('ach:event', { type: 'finished', mode, cancelled: ach.cancel, appId, total: (r && r.unlocked) || 0, games: 1, canUndo: !!(r && r.ok && r.unlocked > 0) });
}

// ---- IPC ---------------------------------------------------------------------
// preload (sandbox) sözlüğü buradan senkron alır
ipcMain.on('lang:dict', (e) => { e.returnValue = LANG; });

ipcMain.handle('app:init', () => {
  const s = loadSession();
  return {
    saved: s ? s.accountName : null,
    canRemember: canRemember(),
    prefs,
    state: steam.snapshot(),
    auto: !!pendingAuto,
    games: steam.status === 'ready' ? steam.games : null,
    idle: steam.idleInfo()
  };
});

ipcMain.handle('steam:login', (_e, a) => {
  const accountName = String((a && a.accountName) || '').trim();
  const password = String((a && a.password) || '');
  if (!accountName || !password) return { ok: false, message: tt('be.login.needFields') };
  remember = !!(a && a.remember) && canRemember();
  steam.login(accountName, password);
  return { ok: true };
});

ipcMain.handle('steam:qr-start', (_e, a) => {
  remember = !!(a && a.remember) && canRemember();
  steam.startQr();
  return { ok: true };
});

ipcMain.handle('steam:qr-cancel', () => {
  steam.cancelQr();
  return { ok: true };
});

ipcMain.handle('steam:resume', () => {
  const s = loadSession();
  if (!s) return { ok: false, message: tt('be.resume.noSession') };
  remember = true;
  steam.loginWithToken(s.accountName, s.token);
  return { ok: true };
});

ipcMain.handle('steam:forget', () => {
  forgetSession();
  return { ok: true };
});

ipcMain.handle('steam:guard', (_e, code) => steam.submitGuard(String(code || '').replace(/\s/g, '').toUpperCase()));

ipcMain.handle('steam:logout', () => {
  steam.logout();
  return { ok: true };
});

ipcMain.handle('idle:start', (_e, a) => {
  let list = ids(a && a.ids);
  // Kartlı oyunlar önce (grup rotasyonunda öncelik)
  if (a && a.cardsFirst !== false) {
    const map = new Map(steam.games.map((g) => [g.appid, g]));
    list = list.slice().sort((a, b) => {
      const ga = map.get(a), gb = map.get(b);
      const ca = ga && ga.cards ? 0 : 1;
      const cb = gb && gb.cards ? 0 : 1;
      if (ca !== cb) return ca - cb;
      return 0;
    });
  }
  const rotateMin = clamp(Number(a && a.rotateMin) || 30, 5, 240);
  const grouped = !(a && a.groupMode === false);
  // Önceki oturumu kapat (süre kaydı)
  if (steam.idle.on) onIdleStopRecord();
  const r = steam.startIdle(list, rotateMin, grouped);
  if (r.ok) {
    prefs.lastIdle = { ids: r.list, rotateMin, groupMode: grouped };
    prefs.groupMode = grouped;
    writeJson('prefs.json', prefs);
    onIdleStartRecord(r.list);
    refreshTray();
  }
  return { ok: r.ok, message: r.message };
});

ipcMain.handle('idle:mode', (_e, flag) => {
  const grouped = !!flag;
  steam.setGrouped(grouped);
  prefs.groupMode = grouped;
  if (prefs.lastIdle) prefs.lastIdle.groupMode = grouped;
  writeJson('prefs.json', prefs);
  return { ok: true };
});

ipcMain.handle('idle:stop', () => {
  const summary = onIdleStopRecord();
  steam.stopIdle();
  refreshTray();
  return { ok: true, summary: summary || null };
});

ipcMain.handle('prefs:set', (_e, p) => {
  const cleaned = cleanPrefs(p);
  Object.assign(prefs, cleaned);
  writeJson('prefs.json', prefs);
  applyPrefs(Object.keys(cleaned));
  return { ok: true };
});

ipcMain.handle('ach:run', (_e, list) => {
  if (ach.running) return { ok: false, message: tt('be.ach.busy') };
  if (steam.status !== 'ready') return { ok: false, message: tt('be.needLogin') };
  const owned = new Set(steam.games.filter((g) => g.ach && !g.vac).map((g) => g.appid));
  const clean = ids(list).filter((n) => owned.has(n));
  if (!clean.length) return { ok: false, message: tt('be.ach.pickGame') };
  runAch(clean, 'unlock');
  return { ok: true };
});

ipcMain.handle('ach:clear', (_e, list) => {
  if (ach.running) return { ok: false, message: tt('be.ach.busy') };
  if (steam.status !== 'ready') return { ok: false, message: tt('be.needLogin') };
  const owned = new Set(steam.games.filter((g) => g.ach && !g.vac).map((g) => g.appid));
  const clean = ids(list).filter((n) => owned.has(n));
  if (!clean.length) return { ok: false, message: tt('be.ach.pickGame') };
  runAch(clean, 'clear');
  return { ok: true };
});

ipcMain.handle('ach:list', async (_e, appId) => {
  const id = Number(appId);
  const game = steam.games.find((g) => g.appid === id && g.ach && !g.vac);
  if (steam.status !== 'ready' || !game) return { ok: false, message: tt('be.ach.listUnavailable') };
  let meta;
  try {
    meta = await fetchAchievements(id);
  } catch (e) {
    return { ok: false, message: tt('be.ach.fetchFailed') };
  }
  if (!meta.length) return { ok: false, message: tt('be.ach.noneAvailable') };
  let steamId64 = '';
  try {
    steamId64 = steam.client && steam.client.steamID ? String(steam.client.steamID.getSteamID64()) : '';
  } catch (e) {
    steamId64 = '';
  }
  // Üçü birbirinden bağımsız: yerel Steam istemcisinden açık/kapalı durumu (hiçbir
  // şeyi değiştirmez), gerçek adlar/görseller ve açılma tarihleri. Aynı anda iste.
  const [r, web, times] = await Promise.all([
    runWorker(id, meta.map((m) => m.name), 'list'),
    fetchSchema(id),
    fetchUnlockTimes(id, steamId64)
  ]);
  // Anahtarsız yol: Steam istemcisi şemayı yukarıdaki işlem sırasında önbelleğe yazar;
  // bittikten sonra oku. Web API'den gelen bilgi varsa o önceliklidir.
  const local = web.size ? new Map() : await readLocalSchema(id, steamLang());
  const schema = web.size ? web : local;
  const source = web.size ? 'api' : (local.size ? 'local' : 'none');
  const status = new Map((r.ok && r.items ? r.items : []).map((it) => [it.name, it.unlocked]));
  return {
    ok: true,
    partial: !r.ok,
    message: r.ok ? undefined : (r.message || tt('be.ach.statusReadFailed')),
    hasApiKey: !!prefs.steamApiKey,
    source,
    items: meta.map((m) => {
      const sc = schema.get(m.name);
      const unlocked = status.get(m.name) || false;
      return {
        name: m.name,
        percent: m.percent,
        unlocked,
        displayName: sc ? sc.displayName : '',
        description: sc ? sc.description : '',
        icon: sc ? (sc.icon || sc.iconGray) : '', // kilitli görünüm arayüzde CSS ile verilir
        hidden: !!(sc && sc.hidden),
        unlockTime: unlocked ? (times.get(m.name) || 0) : 0
      };
    })
  };
});

ipcMain.handle('ach:run-some', (_e, a) => {
  if (ach.running) return { ok: false, message: tt('be.ach.busy') };
  if (steam.status !== 'ready') return { ok: false, message: tt('be.needLogin') };
  const appId = Number(a && a.appId);
  const game = steam.games.find((g) => g.appid === appId && g.ach && !g.vac);
  if (!game) return { ok: false, message: tt('be.ach.gameUnavailable') };
  const names = Array.from(new Set((a && a.names || []).map(String))).slice(0, 2000);
  if (!names.length) return { ok: false, message: tt('be.ach.pickAchievement') };
  runAchSome(appId, names, 'unlock');
  return { ok: true };
});

ipcMain.handle('ach:clear-some', (_e, a) => {
  if (ach.running) return { ok: false, message: tt('be.ach.busy') };
  if (steam.status !== 'ready') return { ok: false, message: tt('be.needLogin') };
  const appId = Number(a && a.appId);
  const game = steam.games.find((g) => g.appid === appId && g.ach && !g.vac);
  if (!game) return { ok: false, message: tt('be.ach.gameUnavailableClear') };
  const names = Array.from(new Set((a && a.names || []).map(String))).slice(0, 2000);
  if (!names.length) return { ok: false, message: tt('be.ach.pickAchievement') };
  runAchSome(appId, names, 'clear');
  return { ok: true };
});

ipcMain.handle('ach:cancel', () => {
  ach.cancel = true;
  if (ach.child) {
    try {
      ach.child.kill();
    } catch (e) {
      /* yoksay */
    }
  }
  return { ok: true };
});

// ---- istatistik IPC --------------------------------------------------------------
ipcMain.handle('stats:get', () => {
  if (!stats) return { ok: false };
  return { ok: true, data: stats.snapshot(), canUndo: !!lastAchOp };
});

ipcMain.handle('stats:open-folder', async () => {
  if (!stats) return { ok: false };
  const dir = stats.openFolder();
  try {
    const { shell } = require('electron');
    await shell.openPath(dir);
  } catch (e) { /* yoksay */ }
  return { ok: true, path: dir };
});

ipcMain.handle('stats:open-logs', async () => {
  if (!stats) return { ok: false };
  try {
    fs.mkdirSync(stats.logsDir, { recursive: true });
    await shell.openPath(stats.logsDir);
  } catch (e) { /* yoksay */ }
  return { ok: true, path: stats.logsDir };
});

ipcMain.handle('ach:undo', async () => {
  if (!lastAchOp || ach.running) return { ok: false, message: tt('be.ach.undoUnavailable') };
  if (steam.status !== 'ready') return { ok: false, message: tt('be.needLogin') };
  const op = lastAchOp;
  lastAchOp = null;
  const reverse = op.mode === 'clear' ? 'unlock' : 'clear';
  // Sadece tek-oyun some yolu desteklenir
  for (const it of op.items) {
    await runAchSome(it.appId, it.names, reverse);
  }
  return { ok: true };
});

// ---- açılış ----------------------------------------------------------------------
app.whenReady().then(() => {
  migrateOld();
  stats = new StatsStore(app.getPath('userData'));
  prefs = Object.assign({}, DEFAULTS, cleanPrefs(readJson('prefs.json', {})));
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  steam.setPersonaMode(prefs.persona);
  ensureTray();
  const hidden = AUTOSTART && prefs.startHidden && !!tray;
  createWindow(!hidden);
  applyAutoStart();
  maybeAutoIdle();
});

app.on('second-instance', showWindow);
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  quitting = true;
  try { if (stats) stats.flush(); } catch (e) { /* yoksay */ }
  try {
    steam.logout();
  } catch (e) {
    /* yoksay */
  }
  if (ach.child) {
    try {
      ach.child.kill();
    } catch (e) {
      /* yoksay */
    }
  }
});

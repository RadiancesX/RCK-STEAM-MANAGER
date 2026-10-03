'use strict';
// Steam ile konuşan katman. Electron'a bağımlı değil.
// Hiçbir şey diske yazılmaz ve log tutulmaz.
const { EventEmitter } = require('events');
const SteamUser = require('steam-user');
const { LoginSession, EAuthTokenPlatformType } = require('steam-session');
const { t } = require('./lang');

const MAX_AT_ONCE = 32; // Steam aynı anda en fazla 32 oyunu sayar
const CHUNK = 150; // kütüphane bilgisi parça parça istenir
const QR_MAX_REFRESH = 6; // QR kodu bu kadar kez otomatik yenilenir
const R = SteamUser.EResult;

function toGame(appid, info) {
  const common = info && info.common;
  if (!common || !common.name) return null;
  if (String(common.type || '').toLowerCase() !== 'game') return null;
  const cat = common.category || {};
  const has = (n) => {
    const v = cat['category_' + n] !== undefined ? cat['category_' + n] : common['category_' + n];
    return String(v) === '1';
  };
  return { appid, name: String(common.name), cards: has(29), ach: has(22), vac: has(8) };
}

function friendly(lang, err, usingToken) {
  const c = err && err.eresult;
  if (c === R.InvalidPassword) {
    return usingToken ? t(lang, 'be.steam.badPasswordToken') : t(lang, 'be.steam.badPassword');
  }
  if (c === R.AccessDenied) {
    return usingToken ? t(lang, 'be.steam.accessDeniedToken') : t(lang, 'be.steam.accessDenied');
  }
  if (c === R.RateLimitExceeded || c === R.AccountLoginDeniedThrottle) {
    return t(lang, 'be.steam.rateLimit');
  }
  if (c === R.TwoFactorCodeMismatch || c === R.InvalidLoginAuthCode || c === R.TwoFactorActivationCodeMismatch) {
    return t(lang, 'be.steam.guardWrong');
  }
  if (c === R.LoggedInElsewhere || c === R.LogonSessionReplaced) {
    return t(lang, 'be.steam.loggedInElsewhere');
  }
  if (c === R.ServiceUnavailable || c === R.NoConnection || c === R.Timeout) {
    return t(lang, 'be.steam.noConnection');
  }
  const code = (c && R[c]) || (err && err.message) || t(lang, 'be.steam.unknownCode');
  return t(lang, 'be.steam.unknown', { code });
}

// steam-user her girişte logonID'yi 0 yapar. Aynı hesapla giren başka bir steam-user
// tabanlı program (ya da bu uygulamanın ikinci bir kopyası) aynı kimliği kullanınca
// Steam eskisini "LoggedInElsewhere" ile atar. Her süreç kendi rastgele kimliğini kullanır.
const LOGON_ID = 1 + Math.floor(Math.random() * 0xfffffffe);
// Atılırsa (10 dk içinde en fazla 3 kez) sırayla 5 sn, 30 sn, 2 dk sonra kendiliğinden yeniden bağlan
const KICK_WINDOW_MS = 10 * 60 * 1000;
const KICK_DELAYS_MS = [5000, 30000, 120000];

class SteamService extends EventEmitter {
  constructor(getLang) {
    super();
    this._lang = typeof getLang === 'function' ? getLang : () => 'tr';
    this._t = (key, vars) => t(this._lang(), key, vars);
    this.client = null;
    this.status = 'out'; // out | connecting | guard | loading | ready
    this.account = '';
    this.games = [];
    this.online = true;
    this.personaMode = 'online'; // online | invisible | keep
    this._guard = null;
    this._usingToken = false;
    this._wasLoggedOn = false;
    this._token = ''; // bu oturumun yenileme anahtarı (yalnızca bellekte)
    this._kicks = [];
    this._reconnectTimer = null;
    this._libraryLoaded = false;
    this._loadId = 0;
    this._qr = null;
    this._qrId = 0;
    this._qrRefreshes = 0;
    this.idle = { on: false, paused: false, list: [], batch: 0, rotateMin: 30, rotateMs: 0, grouped: true, startedAt: 0, timer: null, blockedBy: 0 };
  }

  snapshot() {
    return { status: this.status, account: this.account };
  }

  _set(status, extra) {
    this.status = status;
    this.emit('state', Object.assign({ status, account: this.account }, extra || {}));
  }

  // ---- giriş ----------------------------------------------------------
  login(accountName, password) {
    this._start({ accountName, password }, accountName, false);
  }

  loginWithToken(accountName, refreshToken) {
    this._start({ refreshToken }, accountName, true);
  }

  _start(details, account, usingToken) {
    this._teardown();
    this.account = account;
    this._usingToken = usingToken;
    this._wasLoggedOn = false;
    this._kicks = [];
    this._token = usingToken ? details.refreshToken : '';
    this._set('connecting');
    this._connect(details);
  }

  _connect(details) {
    const c = new SteamUser({ dataDirectory: null, autoRelogin: true, enablePicsCache: true, changelistUpdateInterval: 0 });
    this.client = c;
    const mine = () => c === this.client;

    c.on('steamGuard', (domain, callback, lastCodeWrong) => {
      if (!mine()) return;
      // 2FA kodu yanlışsa 30 sn beklemek gerekir, yoksa Steam IP'yi geçici banlar.
      const waitMs = lastCodeWrong ? 30000 : 0;
      this._guard = { callback, readyAt: Date.now() + waitMs };
      this._set('guard', { guard: { email: domain || null, wrong: !!lastCodeWrong, waitMs } });
    });
    c.on('refreshToken', (token) => {
      if (!mine()) return;
      this._token = token;
      this.emit('token', { accountName: this.account, token });
    });
    c.on('loggedOn', () => {
      if (mine()) this._onLoggedOn();
    });
    c.on('ownershipCached', () => {
      if (mine()) this._loadLibrary();
    });
    c.on('playingState', (blocked, playingApp) => {
      if (mine()) this._onPlaying(blocked, playingApp);
    });
    c.on('disconnected', () => {
      if (mine() && this._wasLoggedOn) {
        this.online = false;
        this._emitIdle();
      }
    });
    c.on('error', (err) => {
      if (mine()) this._onError(err);
    });

    try {
      c.logOn(Object.assign({ machineName: 'RCK Steam Manager', logonID: LOGON_ID }, details));
    } catch (err) {
      this._fail(err);
    }
  }

  // Giriş yapılmışken "başka yerde oturum açıldı" ile atılırsak oturumu düşürmeyip
  // kendiliğinden yeniden bağlanırız; idle ve oyun listesi olduğu gibi kalır.
  _onError(err) {
    const code = err && err.eresult;
    const kicked = code === R.LoggedInElsewhere || code === R.LogonSessionReplaced;
    if (kicked && this._wasLoggedOn && this._token && this._scheduleReconnect()) return;
    this._fail(err);
  }

  _scheduleReconnect() {
    const now = Date.now();
    this._kicks = this._kicks.filter((t) => now - t < KICK_WINDOW_MS);
    this._kicks.push(now);
    const delay = KICK_DELAYS_MS[this._kicks.length - 1];
    if (delay == null) return false; // 10 dk içinde defalarca atıldı: döngüye girme, kullanıcıya söyle
    const old = this.client;
    this.client = null;
    if (old) {
      old.removeAllListeners();
      old.on('error', () => {});
      try {
        old.logOff();
      } catch (e) {
        /* yoksay */
      }
    }
    this.online = false;
    this._emitIdle();
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this.client || this.status !== 'ready') return; // bu arada çıkış yapıldı
      this._connect({ refreshToken: this._token });
    }, delay);
    return true;
  }

  submitGuard(code) {
    if (!this._guard) return { ok: false, error: 'none', message: this._t('be.steam.guardNoneNow') };
    const wait = this._guard.readyAt - Date.now();
    if (wait > 0) return { ok: false, error: 'wait', waitMs: wait, message: this._t('be.steam.guardWait') };
    if (!code) return { ok: false, error: 'empty', message: this._t('be.steam.guardEmpty') };
    const cb = this._guard.callback;
    this._guard = null;
    this._set('connecting');
    cb(code);
    return { ok: true };
  }

  // ---- QR ile giriş ---------------------------------------------------
  async startQr(isRefresh) {
    this._cancelQr();
    if (!isRefresh) {
      this._qrRefreshes = 0;
      // Şifreyle giriş ortasında QR'a geçilirse, arkada asılı kalan denemeyi kapat.
      if (this.status === 'connecting' || this.status === 'guard') this.logout();
    }
    const id = ++this._qrId;
    const session = new LoginSession(EAuthTokenPlatformType.SteamClient, { machineFriendlyName: 'RCK Steam Manager' });
    session.loginTimeout = 120000;
    this._qr = session;
    const mine = () => this._qr === session && id === this._qrId;

    session.on('remoteInteraction', () => {
      if (mine()) this.emit('qr', { status: 'scanned' });
    });
    session.on('authenticated', () => {
      if (!mine()) return;
      const accountName = session.accountName;
      const token = session.refreshToken;
      this._qr = null;
      this.emit('token', { accountName, token });
      this.loginWithToken(accountName, token);
    });
    session.on('timeout', () => {
      if (!mine()) return;
      this._qr = null;
      if (this._qrRefreshes < QR_MAX_REFRESH) {
        this._qrRefreshes++;
        this.startQr(true);
      } else {
        this.emit('qr', { status: 'expired' });
      }
    });
    session.on('error', (err) => {
      if (!mine()) return;
      this._qr = null;
      const msg = (err && err.message) ? String(err.message).slice(0, 120) : '';
      this.emit('qr', { status: 'error', message: msg ? (this._t('be.steam.qrFailed') + ' (' + msg + ')') : this._t('be.steam.qrFailed') });
    });

    try {
      const res = await session.startWithQR();
      if (!mine()) {
        try { session.cancelLoginAttempt(); } catch (e) { /* yoksay */ }
        return;
      }
      if (!res || !res.qrChallengeUrl) {
        this._qr = null;
        this.emit('qr', { status: 'error', message: this._t('be.steam.qrGenFailed') });
        return;
      }
      this.emit('qr', { status: 'waiting', url: res.qrChallengeUrl });
    } catch (e) {
      if (mine()) {
        this._qr = null;
        const msg = (e && e.message) ? String(e.message).slice(0, 120) : '';
        this.emit('qr', { status: 'error', message: msg ? (this._t('be.steam.qrGenFailed') + ' (' + msg + ')') : this._t('be.steam.qrGenFailed') });
      }
    }
  }

  cancelQr() {
    this._cancelQr();
  }

  _cancelQr() {
    this._qrId++;
    const s = this._qr;
    this._qr = null;
    if (s) {
      s.removeAllListeners();
      s.on('error', () => {});
      try { s.cancelLoginAttempt(); } catch (e) { /* yoksay */ }
    }
  }

  logout() {
    this._teardown();
    this.games = [];
    this._set('out');
  }

  _fail(err) {
    const c = err && err.eresult;
    const tokenBad = this._usingToken && (!c || c === R.InvalidPassword || c === R.AccessDenied || c === R.Expired);
    const message = friendly(this._lang(), err, this._usingToken);
    this._teardown();
    this.games = [];
    this._set('out');
    this.emit('failure', { message, tokenBad });
  }

  _teardown() {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this._cancelQr();
    this._loadId++;
    this._clearTimer();
    const i = this.idle;
    i.on = false;
    i.paused = false;
    i.list = [];
    i.batch = 0;
    i.blockedBy = 0;
    this._guard = null;
    this._libraryLoaded = false;
    this.online = true;
    const c = this.client;
    this.client = null;
    if (c) {
      c.removeAllListeners();
      c.on('error', () => {});
      try {
        c.logOff();
      } catch (e) {
        /* yoksay */
      }
    }
    this._emitIdle();
  }

  // ---- Steam durumu (yeşil isim) ---------------------------------------
  setPersonaMode(mode) {
    this.personaMode = mode === 'invisible' || mode === 'keep' ? mode : 'online';
    this._applyPersona();
  }

  // Çevrimiçi olmadan Steam bu oturumu çevrimdışı gösterir; isim yeşil olmaz.
  _applyPersona() {
    const c = this.client;
    if (!c || !c.steamID || this.personaMode === 'keep') return;
    try {
      c.setPersona(this.personaMode === 'invisible' ? SteamUser.EPersonaState.Invisible : SteamUser.EPersonaState.Online);
    } catch (e) {
      /* yoksay */
    }
  }

  _onLoggedOn() {
    this.online = true;
    this._applyPersona();
    if (this._wasLoggedOn) {
      // otomatik yeniden bağlanma: idle'ı geri kur
      this._emitIdle();
      if (this.idle.on && !this.idle.paused) this._apply();
      return;
    }
    this._wasLoggedOn = true;
    if (this.status === 'connecting' || this.status === 'guard') this._set('loading', { loaded: 0, total: 0 });
  }

  // ---- kütüphane ------------------------------------------------------
  async _loadLibrary() {
    if (this._libraryLoaded) return;
    this._libraryLoaded = true;
    const id = ++this._loadId;
    const c = this.client;
    if (this.status !== 'loading') this._set('loading', { loaded: 0, total: 0 });

    let ids = [];
    try {
      ids = c.getOwnedApps({ excludeShared: true, excludeExpiring: true });
    } catch (e) {
      this._fail(e);
      return;
    }

    const games = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      if (id !== this._loadId || c !== this.client) return;
      const part = ids.slice(i, i + CHUNK);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await c.getProductInfo(part, [], true);
          const apps = (res && res.apps) || {};
          for (const key of Object.keys(apps)) {
            const g = toGame(Number(key), apps[key] && apps[key].appinfo);
            if (g) games.push(g);
          }
          break;
        } catch (e) {
          /* bir kez daha dene */
        }
      }
      this.emit('progress', { loaded: Math.min(i + CHUNK, ids.length), total: ids.length });
    }
    if (id !== this._loadId || c !== this.client) return;

    games.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
    this.games = games;
    this._set('ready');
    this.emit('games', games);
  }

  // ---- idle -----------------------------------------------------------
  _batchCount() {
    const i = this.idle;
    return i.grouped ? Math.max(1, Math.ceil(i.list.length / MAX_AT_ONCE)) : 1;
  }

  _currentBatch() {
    const i = this.idle;
    if (!i.grouped) return i.list.slice(); // grup modu kapalı: hepsi tek seferde
    return i.list.slice(i.batch * MAX_AT_ONCE, i.batch * MAX_AT_ONCE + MAX_AT_ONCE);
  }

  idleInfo() {
    const i = this.idle;
    return {
      on: i.on,
      paused: i.paused,
      playing: i.on ? this._currentBatch().length : 0,
      total: i.list.length,
      batch: i.batch + 1,
      batches: i.on ? this._batchCount() : 0,
      grouped: i.grouped,
      rotateMin: i.rotateMs / 60000,
      startedAt: i.startedAt,
      blockedBy: i.blockedBy,
      online: this.online
    };
  }

  _emitIdle() {
    this.emit('idle', this.idleInfo());
  }

  _clearTimer() {
    if (this.idle.timer) clearInterval(this.idle.timer);
    this.idle.timer = null;
  }

  _armTimer() {
    const i = this.idle;
    this._clearTimer();
    if (i.rotateMs && this._batchCount() > 1) {
      i.timer = setInterval(() => {
        i.batch = (i.batch + 1) % this._batchCount();
        this._apply();
        this._emitIdle();
      }, i.rotateMs);
    }
  }

  _rotateMsFor(count) {
    const i = this.idle;
    return i.grouped && count > MAX_AT_ONCE ? i.rotateMin * 60000 : 0;
  }

  _apply() {
    const c = this.client;
    if (!c || !c.steamID) return;
    try {
      c.gamesPlayed(this._currentBatch());
    } catch (e) {
      /* yoksay */
    }
  }

  startIdle(appids, rotateMin, grouped) {
    if (this.status !== 'ready' || !this.client) return { ok: false, message: this._t('be.needLogin') };
    const owned = new Set(this.games.map((g) => g.appid));
    const list = Array.from(new Set(appids.map(Number))).filter((n) => owned.has(n));
    if (!list.length) return { ok: false, message: this._t('be.idle.pickGame') };
    const i = this.idle;
    i.startedAt = i.on ? i.startedAt : Date.now();
    i.on = true;
    i.paused = false;
    i.list = list;
    i.batch = 0;
    i.grouped = grouped !== false;
    i.rotateMin = Math.min(240, Math.max(5, Number(rotateMin) || 30));
    i.rotateMs = this._rotateMsFor(list.length);
    this._armTimer();
    this._apply();
    this._emitIdle();
    return { ok: true, list };
  }

  // Grup modunu çalışırken aç/kapat
  setGrouped(flag) {
    const i = this.idle;
    i.grouped = !!flag;
    if (!i.on) {
      this._emitIdle();
      return;
    }
    i.batch = 0;
    i.rotateMs = this._rotateMsFor(i.list.length);
    this._armTimer();
    if (!i.paused) this._apply();
    this._emitIdle();
  }

  stopIdle() {
    const i = this.idle;
    this._clearTimer();
    i.on = false;
    i.paused = false;
    i.list = [];
    i.batch = 0;
    if (this.client && this.client.steamID) {
      try {
        this.client.gamesPlayed([]);
      } catch (e) {
        /* yoksay */
      }
    }
    this._emitIdle();
  }

  // Başarım işlemi sırasında idle'ı geçici durdurmak için
  pauseIdle() {
    const i = this.idle;
    if (!i.on || i.paused) return;
    i.paused = true;
    this._clearTimer();
    if (this.client && this.client.steamID) {
      try {
        this.client.gamesPlayed([]);
      } catch (e) {
        /* yoksay */
      }
    }
    this._emitIdle();
  }

  resumeIdle() {
    const i = this.idle;
    if (!i.on || !i.paused) return;
    i.paused = false;
    this._armTimer();
    this._apply();
    this._emitIdle();
  }

  _onPlaying(blocked, playingApp) {
    const i = this.idle;
    const was = i.blockedBy;
    i.blockedBy = blocked ? playingApp || 1 : 0;
    // başka yerdeki oyun kapandı: idle'ı geri kur
    if (i.on && !i.paused && !blocked && was) this._apply();
    this._emitIdle();
  }
}

module.exports = SteamService;
module.exports.MAX_AT_ONCE = MAX_AT_ONCE;

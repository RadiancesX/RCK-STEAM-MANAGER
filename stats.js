'use strict';
// Kalıcı istatistik deposu. Sıfırlanmaz; userData/stats.json + userData/logs/
const fs = require('fs');
const path = require('path');

const EMPTY = () => ({
  version: 1,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  totalIdleMs: 0,
  totalSessions: 0,
  totalAchUnlocked: 0,
  totalAchCleared: 0,
  games: {}, // appid -> { name, idleMs, sessions, achUnlocked, achCleared, lastIdleAt, lastAchAt }
  recent: [] // son 200 olay
});

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* yoksay */ }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function writeJson(file, value) {
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  } catch (e) { /* yoksay */ }
}

function appendLog(logsDir, line) {
  try {
    ensureDir(logsDir);
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(logsDir, `log-${day}.txt`);
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch (e) { /* yoksay */ }
}

function iso(ts) {
  try { return new Date(ts).toISOString(); } catch (e) { return String(ts); }
}

function fmtMs(ms) {
  const s = Math.max(0, Math.floor(Number(ms) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}s ${m}dk ${sec}sn`;
  if (m > 0) return `${m}dk ${sec}sn`;
  return `${sec}sn`;
}

class StatsStore {
  constructor(userDataPath) {
    this.dir = userDataPath;
    this.file = path.join(userDataPath, 'stats.json');
    this.logsDir = path.join(userDataPath, 'logs');
    this.data = EMPTY();
    this._load();
    // Aktif idle oturumu (henüz kaydedilmedi)
    this._idle = null; // { startedAt, list:[{id,name}], lastTick }
  }

  _load() {
    const raw = readJson(this.file, null);
    if (!raw || typeof raw !== 'object') {
      this.data = EMPTY();
      this._save();
      return;
    }
    this.data = Object.assign(EMPTY(), raw);
    if (!this.data.games || typeof this.data.games !== 'object') this.data.games = {};
    if (!Array.isArray(this.data.recent)) this.data.recent = [];
  }

  _save() {
    this.data.updatedAt = Date.now();
    writeJson(this.file, this.data);
  }

  _game(id, name) {
    const key = String(id);
    if (!this.data.games[key]) {
      this.data.games[key] = {
        name: name || ('Oyun ' + key),
        idleMs: 0,
        sessions: 0,
        achUnlocked: 0,
        achCleared: 0,
        lastIdleAt: 0,
        lastAchAt: 0
      };
    }
    if (name) this.data.games[key].name = name;
    return this.data.games[key];
  }

  _pushRecent(ev) {
    this.data.recent.unshift(ev);
    if (this.data.recent.length > 200) this.data.recent.length = 200;
  }

  // ---- idle oturumu ----
  idleStart(list) {
    // Önceki yarım oturum varsa kapat
    if (this._idle) this.idleStop();
    const now = Date.now();
    this._idle = {
      startedAt: now,
      lastTick: now,
      list: (list || []).map((x) => ({
        id: Number(x.id || x.appid || x),
        name: String(x.name || '')
      })).filter((x) => x.id > 0)
    };
  }

  idleStop() {
    if (!this._idle) return null;
    const now = Date.now();
    const elapsed = Math.max(0, now - this._idle.startedAt);
    const list = this._idle.list;
    this._idle = null;
    if (elapsed < 1000 || !list.length) return null; // 1 sn altı yok say

    this.data.totalIdleMs += elapsed;
    this.data.totalSessions += 1;
    for (const g of list) {
      const row = this._game(g.id, g.name);
      row.idleMs += elapsed;
      row.sessions += 1;
      row.lastIdleAt = now;
    }
    const summary = {
      type: 'idle',
      at: now,
      ms: elapsed,
      games: list.length,
      ids: list.map((x) => x.id),
      names: list.map((x) => x.name).slice(0, 12)
    };
    this._pushRecent(summary);
    this._save();
    appendLog(this.logsDir,
      `[${iso(now)}] IDLE  süre=${fmtMs(elapsed)}  oyun=${list.length}  ` +
      list.map((x) => `${x.name || x.id}`).slice(0, 20).join(', ')
    );
    return summary;
  }

  // Uygulama kapanırken yarım oturumu kaydet
  flush() {
    return this.idleStop();
  }

  // ---- başarımlar ----
  recordAch(appId, name, mode, count, names) {
    const n = Math.max(0, Number(count) || 0);
    if (!n) return;
    const now = Date.now();
    const row = this._game(appId, name);
    if (mode === 'clear') {
      this.data.totalAchCleared += n;
      row.achCleared += n;
    } else {
      this.data.totalAchUnlocked += n;
      row.achUnlocked += n;
    }
    row.lastAchAt = now;
    const ev = {
      type: mode === 'clear' ? 'ach_clear' : 'ach_unlock',
      at: now,
      appId: Number(appId),
      name: name || row.name,
      count: n,
      names: Array.isArray(names) ? names.slice(0, 50) : []
    };
    this._pushRecent(ev);
    this._save();
    appendLog(this.logsDir,
      `[${iso(now)}] ${mode === 'clear' ? 'CLEAR' : 'UNLOCK'}  ${name || appId}  adet=${n}`
    );
  }

  snapshot() {
    const games = Object.keys(this.data.games).map((id) => {
      const g = this.data.games[id];
      return {
        appid: Number(id),
        name: g.name,
        idleMs: g.idleMs || 0,
        sessions: g.sessions || 0,
        achUnlocked: g.achUnlocked || 0,
        achCleared: g.achCleared || 0,
        lastIdleAt: g.lastIdleAt || 0,
        lastAchAt: g.lastAchAt || 0
      };
    });
    games.sort((a, b) => b.idleMs - a.idleMs || b.achUnlocked - a.achUnlocked);
    return {
      createdAt: this.data.createdAt,
      updatedAt: this.data.updatedAt,
      totalIdleMs: this.data.totalIdleMs,
      totalSessions: this.data.totalSessions,
      totalAchUnlocked: this.data.totalAchUnlocked,
      totalAchCleared: this.data.totalAchCleared,
      games,
      recent: this.data.recent.slice(0, 80),
      logsDir: this.logsDir,
      statsFile: this.file
    };
  }

  openFolder() {
    return this.dir;
  }
}

module.exports = { StatsStore, fmtMs };

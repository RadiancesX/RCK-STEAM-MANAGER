'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch, payload) => ipcRenderer.invoke(ch, payload);
const on = (ch) => (cb) => {
  ipcRenderer.on(ch, (_e, payload) => cb(payload));
};

// API'yi önce aç; dil yüklenemezse bile giriş vs. çalışsın
contextBridge.exposeInMainWorld('api', {
  init: () => call('app:init'),
  login: (a) => call('steam:login', a),
  qrStart: (a) => call('steam:qr-start', a),
  qrCancel: () => call('steam:qr-cancel'),
  resume: () => call('steam:resume'),
  forget: () => call('steam:forget'),
  guard: (code) => call('steam:guard', code),
  logout: () => call('steam:logout'),
  idleStart: (ids, rotateMin, groupMode) => call('idle:start', { ids, rotateMin, groupMode }),
  idleMode: (groupMode) => call('idle:mode', groupMode),
  idleStop: () => call('idle:stop'),
  achRun: (ids) => call('ach:run', ids),
  achClear: (ids) => call('ach:clear', ids),
  achList: (appId) => call('ach:list', appId),
  achRunSome: (appId, names) => call('ach:run-some', { appId, names }),
  achClearSome: (appId, names) => call('ach:clear-some', { appId, names }),
  achCancel: () => call('ach:cancel'),
  setPrefs: (p) => call('prefs:set', p),
  statsGet: () => call('stats:get'),
  statsOpenFolder: () => call('stats:open-folder'),
  statsOpenLogs: () => call('stats:open-logs'),
  achUndo: () => call('ach:undo'),
  onState: on('steam:state'),
  onGames: on('steam:games'),
  onProgress: on('steam:progress'),
  onIdle: on('steam:idle'),
  onFail: on('steam:fail'),
  onQr: on('steam:qr'),
  onAch: on('ach:event'),
  onSession: on('stats:session'),
  onOpenTab: on('ui:open-tab')
});

// Dil sözlüğü. Pencere sandbox'ta çalıştığı için burada require('./lang') ÇALIŞMAZ
// (sadece electron modülüne izin var); sözlüğü ana süreçten isteriz.
let LANG = { tr: {}, en: {} };
try {
  LANG = ipcRenderer.sendSync('lang:dict') || LANG;
} catch (e) {
  // yoksay – renderer yedekleri kullanacak
}
contextBridge.exposeInMainWorld('lang', LANG);

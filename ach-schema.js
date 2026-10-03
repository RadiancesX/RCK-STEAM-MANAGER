'use strict';
// Bilgisayardaki Steam istemcisinin önbelleğinden başarım şemasını (gerçek ad,
// açıklama, simge, gizli mi) okur: <Steam>/appcache/stats/UserGameStatsSchema_<appid>.bin
// Steam Web API anahtarı gerekmez. Bir sorun olursa (dosya yok, biçim farklı)
// boş döner ve arayüz eskisi gibi teknik adları gösterir. Hiçbir şey yazılmaz.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const CDN = 'https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps';

// Valve ikili KeyValues biçimi: 0 iç içe düğüm, 1 metin, 2 int32, 3 float, 4 işaretçi,
// 5 geniş metin, 6 renk, 7 uint64, 8 düğüm sonu.
function parseBinaryKV(buf) {
  let pos = 0;
  const cstr = () => {
    const end = buf.indexOf(0, pos);
    if (end < 0) throw new Error('kv: metin sonu yok');
    const s = buf.toString('utf8', pos, end);
    pos = end + 1;
    return s;
  };
  const node = (depth) => {
    if (depth > 32) throw new Error('kv: çok derin');
    const obj = {};
    while (pos < buf.length) {
      const type = buf[pos++];
      if (type === 8) return obj;
      const key = cstr();
      switch (type) {
        case 0: obj[key] = node(depth + 1); break;
        case 1: obj[key] = cstr(); break;
        case 2: obj[key] = buf.readInt32LE(pos); pos += 4; break;
        case 3: obj[key] = buf.readFloatLE(pos); pos += 4; break;
        case 4: case 6: obj[key] = buf.readUInt32LE(pos); pos += 4; break;
        case 5: {
          let end = pos;
          while (end + 1 < buf.length && !(buf[end] === 0 && buf[end + 1] === 0)) end += 2;
          obj[key] = buf.toString('utf16le', pos, end);
          pos = end + 2;
          break;
        }
        case 7: obj[key] = Number(buf.readBigUInt64LE(pos)); pos += 8; break;
        default: throw new Error('kv: bilinmeyen tür ' + type);
      }
    }
    return obj;
  };
  return node(0);
}

// Şemadaki "bits" düğümlerini bulur; her çocuk bir başarımdır:
// { name: 'API_ADI', display: { name: {english, turkish, ...}, desc: {...}, icon, icon_gray, hidden } }
function extractAchievements(root, lang, appId) {
  const out = new Map();
  const loc = (n) => {
    if (typeof n === 'string') return n;
    if (n && typeof n === 'object') {
      for (const k of [lang, 'english']) if (typeof n[k] === 'string' && n[k]) return n[k];
    }
    return '';
  };
  const url = (f) => {
    if (typeof f !== 'string' || !f) return '';
    if (/^https?:\/\//i.test(f)) return f.replace(/^http:/i, 'https:');
    return `${CDN}/${appId}/${f}`;
  };
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    for (const [k, v] of Object.entries(n)) {
      if (k.toLowerCase() === 'bits' && v && typeof v === 'object') {
        for (const bit of Object.values(v)) {
          if (!bit || typeof bit !== 'object' || typeof bit.name !== 'string' || !bit.name) continue;
          const d = bit.display && typeof bit.display === 'object' ? bit.display : {};
          out.set(bit.name, {
            displayName: loc(d.name),
            description: loc(d.desc),
            icon: url(d.icon),
            iconGray: url(d.icon_gray),
            hidden: Number(d.hidden) === 1
          });
        }
      } else walk(v);
    }
  };
  walk(root);
  return out;
}

// ---- Steam klasörünü bul ----------------------------------------------------
let steamDirCache = '';

function regSteamPath() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve(''); return; }
    try {
      execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true, timeout: 4000 }, (err, out) => {
        if (err || !out) { resolve(''); return; }
        const m = /SteamPath\s+REG_SZ\s+(.+)/i.exec(String(out));
        resolve(m ? path.normalize(m[1].trim()) : '');
      });
    } catch (e) {
      resolve('');
    }
  });
}

async function findSteamDir() {
  if (steamDirCache) return steamDirCache;
  const cands = [];
  const reg = await regSteamPath();
  if (reg) cands.push(reg);
  if (process.platform === 'win32') {
    for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, 'C:\\Program Files (x86)', 'C:\\Program Files']) {
      if (base) cands.push(path.join(base, 'Steam'));
    }
  } else {
    const home = os.homedir();
    cands.push(path.join(home, '.steam', 'steam'), path.join(home, '.local', 'share', 'Steam'), path.join(home, 'Library', 'Application Support', 'Steam'));
  }
  for (const c of cands) {
    try {
      if (fs.statSync(path.join(c, 'appcache', 'stats')).isDirectory()) { steamDirCache = c; return c; }
    } catch (e) {
      /* sıradaki adayı dene */
    }
  }
  return '';
}

// appId için yerel şemayı okur. lang: 'turkish' | 'english'. Map<apiAdı, bilgi> döner.
async function readLocalSchema(appId, lang, dirOverride) {
  try {
    const dir = dirOverride || await findSteamDir();
    if (!dir) return new Map();
    const file = path.join(dir, 'appcache', 'stats', `UserGameStatsSchema_${Number(appId)}.bin`);
    const buf = await fs.promises.readFile(file);
    return extractAchievements(parseBinaryKV(buf), lang, Number(appId));
  } catch (e) {
    return new Map();
  }
}

module.exports = { parseBinaryKV, extractAchievements, readLocalSchema, findSteamDir };

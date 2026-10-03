'use strict';
// Ayrı bir süreçte çalışır (ELECTRON_RUN_AS_NODE=1). stdin'den JSON okur,
// bilgisayardaki Steam istemcisi üzerinden başarımları açar/sıfırlar ya da
// durumlarını okur, sonucu JSON satırları olarak stdout'a yazar.
//
// Bu dosya hiçbir dilde metin üretmez: hata durumunda sadece bir "error" kodu
// döner (init/input/crash), gösterilecek metni ana süreç (main.js) kullanıcının
// seçtiği dile göre kendisi üretir.
//
// Önemli: Steamworks API'de bir başarımı SetAchievement/ClearAchievement ile
// işaretlemek sadece yerel bellekte bir bayrak koyar; StoreStats() çağrılmadan
// bu değişiklik Steam'e hiç gönderilmez ve kalıcı olmaz. steamworks.js'in
// activate()/clear() fonksiyonları her çağrıda kendi içinde bir StoreStats de
// yapıyor, ama Valve'ın kendi belgeleri StoreStats'in saniyede birden fazla
// değil, seyrek çağrılmasını öneriyor. Bu yüzden burada: (1) her başarım
// arasına makul bir bekleme koyuyoruz, (2) hepsi bittikten sonra ayrıca bir kez
// daha explicit stats.store() çağırıp değişiklikleri topluca göndermeyi
// deniyoruz.
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INITIAL_WAIT = 3500; // istatistiklerin Steam'den gelmesini (RequestCurrentStats) bekle
const PER_ITEM_DELAY = 450; // ardışık SetAchievement/ClearAchievement + StoreStats çağrıları arasında
const ROUND_GAP = 3000;

async function run(input) {
  const appId = Number(input.appId);
  const names = Array.isArray(input.names) ? input.names.map(String).filter(Boolean) : [];
  const mode = ['list', 'unlock', 'clear'].includes(input.mode) ? input.mode : 'unlock';
  if (!appId || !names.length) return { ok: false, error: 'input' };

  let client;
  try {
    client = require('steamworks.js').init(appId);
  } catch (e) {
    return { ok: false, error: 'init' };
  }
  const api = client.achievement;
  const stats = client.stats;

  await sleep(INITIAL_WAIT);

  const isOn = (n) => {
    try {
      return !!api.isActivated(n);
    } catch (e) {
      return false;
    }
  };

  if (mode === 'list') {
    // Sadece mevcut durumu okur, hiçbir şeyi değiştirmez.
    const items = names.map((name) => ({ name, unlocked: isOn(name) }));
    return { ok: true, mode: 'list', items };
  }

  const wantOn = mode === 'unlock'; // bu işlemden sonra hedeflenen durum: açık mı, kilitli mi
  let already = 0;
  let pending = [];
  for (const n of names) {
    if (isOn(n) === wantOn) already++;
    else pending.push(n);
  }

  let changed = 0;
  for (let round = 0; round < 2 && pending.length; round++) {
    const failed = [];
    for (const n of pending) {
      let ok = false;
      try {
        ok = wantOn ? !!api.activate(n) : !!api.clear(n);
      } catch (e) {
        ok = false;
      }
      if (ok) changed++;
      else failed.push(n);
      out({ type: 'progress', done: already + changed, total: names.length });
      await sleep(PER_ITEM_DELAY);
    }
    pending = failed;
    if (pending.length) await sleep(ROUND_GAP);
  }

  // Tüm SetAchievement/ClearAchievement çağrıları bitti: değişiklikleri topluca
  // Steam'e göndermeyi birkaç kez dene (activate()/clear() içindeki store zaten
  // denedi, bu ek bir güvence).
  for (let i = 0; i < 3; i++) {
    let stored = false;
    try {
      stored = !!stats.store();
    } catch (e) {
      stored = false;
    }
    if (stored) break;
    await sleep(1500);
  }

  await sleep(2000);
  const failedCount = names.filter((n) => isOn(n) !== wantOn).length;
  out({ type: 'progress', done: names.length - failedCount, total: names.length });
  return { ok: true, mode, total: names.length, unlocked: changed, already, failed: failedCount };
}

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  data += c;
});
process.stdin.on('end', async () => {
  let result;
  try {
    result = await run(JSON.parse(data));
  } catch (e) {
    result = { ok: false, error: 'crash' };
  }
  out(Object.assign({ type: 'result' }, result));
  setTimeout(() => process.exit(0), 100);
});

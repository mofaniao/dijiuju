// spider.js — 俊版 TVBox / FongMi 影视 的 type:3 JS 爬虫
// 定位：你自己的「动漫数据源」。目录来自本地静态 catalog（不含播放地址），
//       点开影片 / 点具体某集时【实时】爬 omofuns 解析线路与真实 m3u8，电视本地播放。
//       node 项目仅在「刷新 catalog」时跑一次 export.mjs，运行时零依赖。
//
// 在电视上按需修改下面 4 个常量。
// ============================================================================

// 静态 catalog 地址（托管在 dijiuju.cn 网站根目录下的 tvbox/）。
const CATALOG_URL = 'https://dijiuju.cn/tvbox/anime_catalog.json';

// 播放走 CatVod 本地代理（重写 .ts 切片、带 Referer 绕防盗链），与 node serveStream 行为一致：
//   true  = 最稳，但依赖下面 PROXY_PORT 正确
//   false = 直接把真实 m3u8 返回，并带 Referer 头（多数 omofuns CDN 这样就行；若 .ts 报 403 就改回 true）
const USE_PROXY = true;
const PROXY_PORT = 9978; // CatVod 本地代理端口：俊版常 9978，FongMi 可能不同，看 TVBox 日志/设置
const REFERRER = 'https://www.omofuns.com/';

// 主源 + 镜像域名池（与 lib/anime-play.js 一致）。id 是 omofuns 原生 24hex，所有镜像共用同一套 CMS。
const MIRRORS = [
  'https://www.omofuns.com',
  'https://cn.233dm.com',
  'https://www.699dm.com',
  'https://cn.211dm.com',
  'https://cn.agekkkk.com',
  'https://www.acg2day.com',
  'https://bgm1.cc',
  'https://www.jiandandm.com',
  'https://www.acg2day.net',
  'https://www.acg2day.org',
  'https://www.166dm.com',
  'https://www.661dm.com',
  'https://www.788dm.com',
  'https://www.997dm.com',
  'https://www.agekk.com',
];
// from 标识 -> 中文线路名（与 lib/anime-play.js LINE_NAMES 一致）
const LINE_NAMES = { mp4: '精品', bfzym3u8: '暴风', wsym3u8: '西瓜', dyttm3u8: '天堂', lzm3u8: '西瓜' };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TYPES = { '1': '日漫', '2': '国漫', '3': '美漫', '4': '特摄', '5': '动画', '24': '剧场' };
const PAGE_SIZE = 30;

let PREFERRED = MIRRORS[0];
let CATALOG = null;

// ---------- 基础工具 ----------
function mirrorOrder() { return [PREFERRED, ...MIRRORS.filter((m) => m !== PREFERRED)]; }
function hostOf(h) { return (h || MIRRORS[0]).replace(/\/+$/, ''); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchText(url, retries = 3, timeout = 20000) {
  for (let i = 0; i <= retries; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeout);
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) {
      clearTimeout?.();
      if (i === retries) throw e;
      await sleep(400);
    }
  }
  throw new Error('unreachable');
}

// 花括号配平提取 var <name>={...};（player_aaaa / d4ddy）
function extractObj(html, name) {
  const i = html.indexOf(name + '=');
  if (i < 0) return null;
  const start = html.indexOf('{', i);
  if (start < 0) return null;
  let depth = 0;
  let j = start;
  for (; j < html.length; j++) {
    const c = html[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  try { return JSON.parse(html.slice(start, j + 1)); } catch { return null; }
}

// 详情页枚举 线路×集数
function parsePlayLinks(html, id) {
  const re = new RegExp('/anime/' + id + '/play/(\\d+)/(\\d+)\\.html', 'g');
  const set = new Set();
  let m;
  while ((m = re.exec(html)) !== null) set.add(m[1] + '/' + m[2]);
  return [...set].map((s) => { const [line, ep] = s.split('/').map(Number); return { line, ep }; });
}

// ---------- catalog 加载（缓存） ----------
async function loadCatalog() {
  if (CATALOG) return CATALOG;
  let txt;
  if (CATALOG_URL.startsWith('file://') && typeof local !== 'undefined' && local.get) {
    txt = local.get(CATALOG_URL.replace('file://', ''));
  } else {
    txt = await fetch(CATALOG_URL).then((r) => r.text());
  }
  CATALOG = JSON.parse(txt);
  return CATALOG;
}

function filterByType(list, tid) {
  const name = TYPES[String(tid)];
  return name ? list.filter((v) => v.type_name === name) : list;
}
function searchList(list, key) {
  const k = (key || '').trim().toLowerCase();
  if (!k) return [];
  return list.filter((v) =>
    (v.vod_name || '').toLowerCase().includes(k) ||
    (v.vod_actor || '').toLowerCase().includes(k) ||
    (v.vod_director || '').toLowerCase().includes(k));
}
function paginate(arr, pg) {
  const page = Math.max(1, parseInt(pg) || 1);
  const start = (page - 1) * PAGE_SIZE;
  return {
    list: arr.slice(start, start + PAGE_SIZE),
    page,
    pagecount: Math.max(1, Math.ceil(arr.length / PAGE_SIZE)),
    limit: PAGE_SIZE,
    total: arr.length,
  };
}

// ---------- 实时解析（搬自 lib/anime-play.js） ----------
// 取单集播放页，抽 player_aaaa -> 真实 m3u8（m3u8 线路）或哈希（mp4 线路）
async function fetchPlay(id, line, ep) {
  for (const host of mirrorOrder()) {
    try {
      const html = await fetchText(`${hostOf(host)}/anime/${id}/play/${line}/${ep}.html`);
      const pa = extractObj(html, 'player_aaaa');
      if (!pa) continue; // 该镜像无此结构（空 404 页），换下一个
      const raw = pa.url ? decodeURIComponent(pa.url) : '';
      const from = pa.from || '';
      const isM3u8 = /\.m3u8(\?|$)/i.test(raw);
      PREFERRED = host;
      return { raw, from, isM3u8, lineName: LINE_NAMES[from] || from };
    } catch (e) { /* 该镜像失败，换下一个 */ }
  }
  throw new Error('all mirrors failed');
}

// 取详情页 -> 各 m3u8 线路的集数列表（丢弃 mp4 精品线路）
async function resolveLines(id) {
  let links = null;
  for (const host of mirrorOrder()) {
    try {
      const html = await fetchText(`${hostOf(host)}/anime/${id}.html`);
      const ls = parsePlayLinks(html, id);
      if (ls.length) { PREFERRED = host; links = ls; break; }
    } catch (e) { /* 换镜像 */ }
  }
  if (!links || !links.length) return { from: [], url: [] };

  // 按线路分组，去重集数
  const byLine = new Map();
  for (const { line, ep } of links) {
    if (!byLine.has(line)) byLine.set(line, new Set());
    byLine.get(line).add(ep);
  }

  const fromNames = [];
  const urlLines = [];
  for (const line of [...byLine.keys()].sort((a, b) => a - b)) {
    let rec;
    try { rec = await fetchPlay(id, line, 1); } catch (e) { continue; }
    // 仅保留 m3u8 线路，丢弃精品(mp4)
    if (!rec.isM3u8) continue;
    const name = rec.lineName || ('线路' + line);
    const eps = [...byLine.get(line)].sort((a, b) => a - b);
    const lineUrl = eps.map((ep) => `第${ep}集$dijiuju://${id}/${line}/${ep}`).join('#');
    fromNames.push(name);
    urlLines.push(lineUrl);
    await sleep(150);
  }
  return { from: fromNames.join('$$$'), url: urlLines.join('$$$') };
}

// ---------- CatVod Spider 接口（返回 JSON 字符串） ----------
function homeContent() {
  return JSON.stringify({ class: (CATALOG && CATALOG.classes) || Object.entries(TYPES).map(([tid, n]) => ({ type_id: tid, type_name: n })), filters: {} });
}

function homeVideoContent() {
  // 首页放「日漫」第一页，纯展示
  const pg = paginate((CATALOG && CATALOG.list) || [], 1);
  return JSON.stringify({ list: pg.list });
}

async function categoryContent(tid, pg, filter, extend) {
  const c = await loadCatalog();
  const arr = filterByType(c.list, tid);
  const pg2 = paginate(arr, pg);
  return JSON.stringify(pg2);
}

async function searchContent(key, quick, pg) {
  const c = await loadCatalog();
  const arr = searchList(c.list, key);
  const pg2 = paginate(arr, pg || 1);
  return JSON.stringify(pg2);
}

async function detailContent(ids) {
  const list = Array.isArray(ids) ? ids : String(ids || '').split(',').map((s) => s.trim()).filter(Boolean);
  const c = await loadCatalog();
  const out = [];
  for (const id of list) {
    const meta = (c.list || []).find((v) => v.vod_id === id) || {};
    let play = { from: '', url: '' };
    try { play = await resolveLines(id); } catch (e) { /* 源站不可达，仅返回元数据 */ }
    out.push({
      vod_id: id,
      vod_name: meta.vod_name || '',
      vod_pic: meta.vod_pic || '',
      type_name: meta.type_name || '',
      vod_year: meta.vod_year || '',
      vod_area: meta.vod_area || '',
      vod_director: meta.vod_director || '',
      vod_actor: meta.vod_actor || '',
      vod_content: meta.vod_content || '',
      vod_remarks: meta.vod_remarks || '',
      vod_play_from: play.from,
      vod_play_url: play.url,
    });
  }
  return JSON.stringify({ list: out });
}

// playerContent 收到的 id 即 vod_play_url 里的 token：dijiuju://<id>/<line>/<ep>
function b64(s) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < s.length; i += 3) {
    const b1 = s.charCodeAt(i) & 0xff;
    const b2 = i + 1 < s.length ? s.charCodeAt(i + 1) & 0xff : -1;
    const b3 = i + 2 < s.length ? s.charCodeAt(i + 2) & 0xff : -1;
    const e1 = b1 >> 2;
    const e2 = ((b1 & 3) << 4) | (b2 >= 0 ? b2 >> 4 : 0);
    const e3 = b2 >= 0 ? ((b2 & 15) << 2) | (b3 >= 0 ? b3 >> 6 : 0) : 64;
    const e4 = b3 >= 0 ? b3 & 63 : 64;
    out += chars[e1] + chars[e2] + (e3 !== 64 ? chars[e3] : '=') + (e4 !== 64 ? chars[e4] : '=');
  }
  return out;
}

async function playerContent(flag, id, flags) {
  const m = String(id || '').match(/^dijiuju:\/\/([0-9a-f]{24})\/(\d+)\/(\d+)$/);
  if (!m) return JSON.stringify({ parse: 0, playUrl: '', url: '', header: {} });
  const [, vid, line, ep] = m;
  let rec;
  try { rec = await fetchPlay(vid, +line, +ep); } catch (e) {
    return JSON.stringify({ parse: 0, playUrl: '', url: '', header: {} });
  }
  if (!rec || !rec.isM3u8) {
    // 理论上不会到这（detail 已丢弃 mp4），保险返回空
    return JSON.stringify({ parse: 0, playUrl: '', url: '', header: {} });
  }
  if (USE_PROXY) {
    const url = `http://127.0.0.1:${PROXY_PORT}/proxy?do=proxy&url=${b64(rec.raw)}&header=${b64(JSON.stringify({ Referer: REFERRER }))}`;
    return JSON.stringify({ parse: 0, playUrl: '', url, header: {} });
  }
  return JSON.stringify({ parse: 0, playUrl: '', url: rec.raw, header: { Referer: REFERRER } });
}

// 部分构建用 init 传 extend；这里忽略
function init() { return ''; }

// 导出供 CatVod 加载（全局函数声明，供 VM eval）
globalThis.homeContent = homeContent;
globalThis.homeVideoContent = homeVideoContent;
globalThis.categoryContent = categoryContent;
globalThis.searchContent = searchContent;
globalThis.detailContent = detailContent;
globalThis.playerContent = playerContent;
globalThis.init = init;

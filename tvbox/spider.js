// ============================================================================
// CatVod / TVBox (俊版 / FongMi) type:3 JS spider —— dijiuju.cn 动漫源
// 运行环境：CatVod 内嵌 JS 引擎（Rhino / QuickJS），非现代 V8。
// 约束（务必遵守，否则加载即崩）：
//   - 仅 ES5 + JSON/decodeURIComponent/RegExp；禁用 const/let/箭头/模板字符串/
//     Set/Map/for-of/async/await/Promise/AbortController/globalThis。
//   - 宿主注入同步函数 request(url, headers) 返回响应体字符串。
//   - 下列方法为 TVBox 调用入口，必须裸函数声明（挂到全局），返回 JSON 字符串。
//   - 播放流统一走电视本地代理（127.0.0.1:<PROXY_PORT>/proxy），由电视绕过防盗链
//     并重写 .ts 切片，等价于 node 端 serveStream，node 不参与播放。
// ============================================================================

// ---- 可配置项 -------------------------------------------------------------
// 静态 catalog 地址（已部署到 dijiuju.cn，电视公网可拉）
var CATALOG_URL = 'https://dijiuju.cn/tvbox/anime_catalog.json';
// 电视本地播放代理端口（CatVod 默认 9978；与「接口配置」Web 端口无关，仅本机回环）
var PROXY_PORT = 9978;
// 是否走电视本地代理（true=最稳；false=直接给裸 m3u8 并附 header，依赖播放器自行带 Referer）
var USE_PROXY = true;
// omofuns 防盗链 Referer（playContent 透传给本地代理，由代理带去拉 m3u8 与 .ts）
var REFERRER = 'https://www.omofuns.com/';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 主源 + 镜像域名池（与 node/lib/anime-play.js 保持一致）
var MIRRORS = [
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
  'https://www.agekk.com'
];
// player_aaaa.from 标识 -> 中文线路名；mp4(精品) 丢弃，只保留 m3u8 线路
var LINE_NAMES = {
  mp4: '精品',
  bfzym3u8: '暴风',
  wsym3u8: '西瓜',
  dyttm3u8: '天堂',
  lzm3u8: '西瓜'
};

// ---- 工具 -----------------------------------------------------------------
function hostOf(h) {
  h = h || MIRRORS[0];
  while (h.charAt(h.length - 1) === '/') h = h.slice(0, -1);
  return h;
}

// 纯 JS base64（UTF-8 安全），供本地代理参数使用，避免依赖宿主是否提供 base64Encode
function b64(input) {
  var str = String(input);
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  // UTF-8 编码
  var utf8 = '';
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) utf8 += String.fromCharCode(c);
    else if (c < 0x800) {
      utf8 += String.fromCharCode(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0xd800 || c >= 0xe000) {
      utf8 += String.fromCharCode(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      i++;
      var c2 = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
      utf8 += String.fromCharCode(0xf0 | (c2 >> 18), 0x80 | ((c2 >> 12) & 0x3f), 0x80 | ((c2 >> 6) & 0x3f), 0x80 | (c2 & 0x3f));
    }
  }
  var out = '';
  for (var j = 0; j < utf8.length; j += 3) {
    var e1 = utf8.charCodeAt(j);
    var e2 = utf8.charCodeAt(j + 1);
    var e3 = utf8.charCodeAt(j + 2);
    var b0 = e1 >> 2;
    var b1 = ((e1 & 3) << 4) | (isNaN(e2) ? 0 : e2 >> 4);
    var b2 = isNaN(e2) ? 64 : (((e2 & 15) << 2) | (isNaN(e3) ? 0 : e3 >> 6));
    var b3 = isNaN(e3) ? 64 : (e3 & 63);
    out += chars.charAt(b0) + chars.charAt(b1) + chars.charAt(b2) + chars.charAt(b3);
  }
  return out;
}

// 花括号配平提取 var <name>={...};（node 端 extractObj 移植）
function extractObj(html, name) {
  var i = html.indexOf(name + '=');
  if (i < 0) return null;
  var start = html.indexOf('{', i);
  if (start < 0) return null;
  var depth = 0;
  var j = start;
  for (; j < html.length; j++) {
    var c = html.charAt(j);
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  var slice = html.slice(start, j + 1);
  try { return JSON.parse(slice); } catch (e) { return null; }
}

// 同步取数，按镜像顺序 failover（宿主 request 为同步函数）
function reqText(url, headers) {
  var lastErr = null;
  for (var k = 0; k < MIRRORS.length; k++) {
    var host = hostOf(MIRRORS[k]);
    var full = host + url;
    try {
      var html = request(full, headers || { 'User-Agent': UA });
      if (html && html.length) return { html: html, host: host };
    } catch (e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
  throw new Error('所有镜像均不可用: ' + url);
}

function proxyUrl(m3u8) {
  var h = { 'Referer': REFERRER, 'User-Agent': UA };
  return 'http://127.0.0.1:' + PROXY_PORT + '/proxy?do=proxy&url=' + b64(m3u8) + '&header=' + b64(JSON.stringify(h));
}

// ---- catalog 缓存 ---------------------------------------------------------
var _catalog = null;
function getCatalog() {
  if (_catalog) return _catalog;
  var txt = request(CATALOG_URL, { 'User-Agent': UA });
  _catalog = JSON.parse(txt);
  return _catalog;
}
function classMap() {
  var c = getCatalog();
  var m = {};
  var cls = c.classes || [];
  for (var i = 0; i < cls.length; i++) m[String(cls[i].type_id)] = cls[i].type_name;
  return m;
}
function findVod(id) {
  var list = getCatalog().list || [];
  for (var i = 0; i < list.length; i++) if (String(list[i].vod_id) === String(id)) return list[i];
  return null;
}
function paginate(arr, pg, size) {
  size = size || 30;
  var total = arr.length;
  var pagecount = Math.ceil(total / size) || 1;
  var p = parseInt(pg, 10) || 1;
  if (p < 1) p = 1;
  var start = (p - 1) * size;
  var slice = arr.slice(start, start + size);
  return { list: slice, page: p, pagecount: pagecount, total: total, limit: size };
}

// ---- TVBox 调用入口 -------------------------------------------------------
function init(cfg) { /* 可选，预留 */ }

function homeContent() {
  var c = getCatalog();
  var data = {};
  data.class = c.classes || [];
  data.filters = {};
  return JSON.stringify(data);
}

function homeVideoContent() {
  return JSON.stringify({ list: [] });
}

function categoryContent(tid, pg, filter, extend) {
  var c = getCatalog();
  var name = classMap()[String(tid)];
  var all = c.list || [];
  var out = [];
  if (name) {
    for (var i = 0; i < all.length; i++) if (all[i].type_name === name) out.push(all[i]);
  } else {
    out = all.slice();
  }
  var p = paginate(out, pg, 30);
  return JSON.stringify(p);
}

function searchContent(key, quick, pg) {
  key = (key || '').toLowerCase();
  var all = getCatalog().list || [];
  var out = [];
  for (var i = 0; i < all.length; i++) {
    var nm = (all[i].vod_name || '').toLowerCase();
    var actor = (all[i].vod_actor || '').toLowerCase();
    if (nm.indexOf(key) >= 0 || actor.indexOf(key) >= 0) out.push(all[i]);
  }
  var p = paginate(out, pg, 30);
  return JSON.stringify(p);
}

// 点开影片：实时拉 omofuns 详情页枚举线路×集数，返回线路名 + 每集占位 token
// token = <vodId>_<lineNum>_<ep>，playerContent 收到后再解析真实 m3u8
function detailContent(ids) {
  ids = String(ids || '').split(',')[0];
  var meta = findVod(ids) || {};
  var res = reqText('/anime/' + ids + '.html', { 'User-Agent': UA, 'Referer': REFERRER });
  var html = res.html;

  // 枚举全部 线路×集数
  var re = new RegExp('/anime/' + ids + '/play/(\\d+)/(\\d+)\\.html', 'g');
  var byLine = {}; // lineNum -> {eps:[]}
  var m;
  while ((m = re.exec(html))) {
    var ln = parseInt(m[1], 10);
    var ep = parseInt(m[2], 10);
    if (!byLine[ln]) byLine[ln] = { eps: [] };
    byLine[ln].eps.push(ep);
  }
  var lineNums = Object.keys(byLine);
  if (lineNums.length === 0) {
    // 详情页没枚举到链接（空 404 页），返回仅元数据的空播放结构
    return JSON.stringify({ list: [ { vod_id: ids, vod_name: meta.vod_name || ids, vod_pic: meta.vod_pic || '', vod_play_from: '', vod_play_url: '' } ] });
  }

  // 取每条线路名：抓首个播放页拿 from 数组；mp4(精品) 丢弃
  var fromNames = {}; // lineNum -> 中文名
  var playFromArr = [];
  for (var a = 0; a < lineNums.length; a++) {
    var num = parseInt(lineNums[a], 10);
    var eps = byLine[num].eps;
    var firstEp = eps.slice().sort(function (x, y) { return x - y; })[0];
    try {
      var pr = reqText('/anime/' + ids + '/play/' + num + '/' + firstEp + '.html', { 'User-Agent': UA, 'Referer': REFERRER });
      var pa = extractObj(pr.html, 'player_aaaa');
      if (pa && pa.from && pa.from[num] != null) {
        var rawName = pa.from[num];
        var cn = LINE_NAMES[rawName] || rawName;
        if (cn === '精品') continue; // 丢弃 mp4 精品线
        fromNames[num] = cn;
      }
    } catch (e) { /* 该线路取不到名字，跳过 */ }
  }

  // 组装 vod_play_from / vod_play_url（仅 m3u8 线路）
  var keepNums = [];
  for (var b = 0; b < lineNums.length; b++) {
    var n2 = parseInt(lineNums[b], 10);
    if (fromNames[n2]) keepNums.push(n2);
  }
  keepNums.sort(function (x, y) { return x - y; });
  var fromStr = '';
  var urlStr = '';
  for (var x = 0; x < keepNums.length; x++) {
    var ln2 = keepNums[x];
    var eps2 = byLine[ln2].eps.slice().sort(function (p, q) { return p - q; });
    var epsJoined = '';
    for (var y = 0; y < eps2.length; y++) {
      var e = eps2[y];
      var token = ids + '_' + ln2 + '_' + e;
      if (epsJoined) epsJoined += '#';
      epsJoined += '第' + e + '集$' + token;
    }
    if (x > 0) { fromStr += '$$$'; urlStr += '$$$'; }
    fromStr += fromNames[ln2];
    urlStr += epsJoined;
  }

  var item = {
    vod_id: ids,
    vod_name: meta.vod_name || ids,
    vod_pic: meta.vod_pic || '',
    type_name: meta.type_name || '',
    vod_remarks: meta.vod_remarks || '',
    vod_year: meta.vod_year || '',
    vod_area: meta.vod_area || '',
    vod_director: meta.vod_director || '',
    vod_actor: meta.vod_actor || '',
    vod_content: meta.vod_content || '',
    vod_play_from: fromStr,
    vod_play_url: urlStr
  };
  return JSON.stringify({ list: [ item ] });
}

// 点具体某集：解析真实 m3u8，封装成本地代理串返回
function playerContent(flag, id, vipFlags) {
  var parts = String(id).split('_');
  if (parts.length < 3) {
    return JSON.stringify({ parse: 0, url: String(id), header: {} });
  }
  var vid = parts[0];
  var ln = parts[1];
  var ep = parts[2];
  var pr = reqText('/anime/' + vid + '/play/' + ln + '/' + ep + '.html', { 'User-Agent': UA, 'Referer': REFERRER });
  var pa = extractObj(pr.html, 'player_aaaa');
  if (!pa || !pa.url) {
    return JSON.stringify({ parse: 0, url: '', header: {} });
  }
  var raw = decodeURIComponent(pa.url);
  if (USE_PROXY) {
    return JSON.stringify({ parse: 0, url: proxyUrl(raw), header: {} });
  }
  return JSON.stringify({ parse: 0, url: raw, header: { 'Referer': REFERRER, 'User-Agent': UA } });
}

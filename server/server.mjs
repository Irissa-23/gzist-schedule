#!/usr/bin/env node
/**
 * 广理课表 · 本地服务 (零依赖)
 * ------------------------------------------------------------------
 * 职责：
 *   1. 持久化门户登录 Cookie（HttpOnly 也没问题，服务端自己带 Cookie 请求）
 *   2. 定时自动同步课表 → 写 web/data.json + web/data.js（缓存）
 *   3. 会话掉了自动静默续期（走 CAS：CASTGC → ST → portal）
 *   4. 给前端提供 /api/* 接口（含手动更新、状态、扫码/粘贴 Cookie 导入）
 *   5. 静态托管 web/
 *
 * 启动：  node server/server.mjs        （默认 8787 端口）
 * 环境变量： PORT=8787  SYNC_MIN=15
 * ------------------------------------------------------------------
 */

import http from 'node:http';
import https from 'node:https';
import { readFile, writeFile, mkdir, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, '..');
const WEB = join(ROOT, 'web');
const DATA_DIR = join(ROOT, 'data');
const AUTH_FILE = join(DATA_DIR, 'auth.json');
const DATA_JSON = join(WEB, 'data.json');
const DATA_JS = join(WEB, 'data.js');

const PORT = Number(process.env.GL_PORT || 8787);            // 注意：不用 PORT，避免和宿主环境变量冲突
const SYNC_MIN = Number(process.env.SYNC_MIN || 15);          // 自动同步间隔（分钟）
const KEEPALIVE_MIN = Number(process.env.KEEPALIVE_MIN || 5); // 会话保活间隔（分钟）

const BASE = 'https://portal.gzist.edu.cn';
// 课表卡片实例 id：登录门户后在「学生课表」卡片的 api/uppcard 请求里可见；
// 用环境变量 GL_CARD_ID 指定（留空则失败，请自行填写自己的卡片 id）
const DEFAULT_CARD_ID = process.env.GL_CARD_ID || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

// 校内站点证书常见为内网 CA，Node 需放宽校验
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

/* ============================================================
 * Cookie Jar
 * ============================================================ */
let jar = [];          // [{name,value,domain,path,secure,expires}]
let authMeta = {};     // { student:{...}, updatedAt }
let state = {
  status: 'idle',      // idle | syncing | ok | needLogin | error
  message: '',
  lastSyncAt: null,    // ISO
  lastError: null,
  needLogin: false,
  loggedOut: false,    // 用户主动退出登录（区别于 Cookie 自然过期）
};

async function loadJar() {
  try {
    const j = JSON.parse(await readFile(AUTH_FILE, 'utf8'));
    jar = Array.isArray(j.cookies) ? j.cookies : [];
    authMeta = j.meta || {};
    // 把历史 student 记录进「学号→姓名」表，方便换号后再登回同一账号时仍显示姓名
    if (authMeta.student && authMeta.student.userId && authMeta.student.name) {
      authMeta.known = authMeta.known || {};
      authMeta.known[String(authMeta.student.userId)] = { name: authMeta.student.name };
    }
  } catch { jar = []; authMeta = {}; }
}
async function saveJar() {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(AUTH_FILE, JSON.stringify({ cookies: jar, meta: authMeta }, null, 2), 'utf8');
}

function hostMatch(host, domain) {
  host = host.toLowerCase(); domain = String(domain || '').toLowerCase().replace(/^\./, '');
  return host === domain || host.endsWith('.' + domain);
}
function cookiesFor(urlStr) {
  const u = new URL(urlStr);
  const now = Date.now() / 1000;
  const picked = jar.filter(c =>
    hostMatch(u.hostname, c.domain) &&
    (!c.secure || u.protocol === 'https:') &&
    (c.path === '/' || u.pathname.startsWith(c.path || '/')) &&
    (!c.expires || c.expires < 0 || c.expires > now)
  );
  // 更具体的 path 优先（后写覆盖）
  picked.sort((a, b) => (a.path || '/').length - (b.path || '/').length);
  return picked.map(c => `${c.name}=${c.value}`).join('; ');
}
function upsertCookie(c) {
  jar = jar.filter(x => !(x.name === c.name && x.domain === c.domain && x.path === c.path));
  jar.push(c);
}
function absorbSetCookie(setCookies, urlStr) {
  if (!setCookies) return;
  const u = new URL(urlStr);
  for (const sc of [].concat(setCookies)) {
    const parts = String(sc).split(';').map(s => s.trim());
    const [nv, ...attrs] = parts;
    const eq = nv.indexOf('=');
    if (eq < 0) continue;
    const name = nv.slice(0, eq).trim();
    const value = nv.slice(eq + 1).trim();
    let domain = u.hostname, path = '/', secure = false, expires = -1;
    for (const a of attrs) {
      const [k, v] = a.split('=').map(s => (s || '').trim());
      const key = (k || '').toLowerCase();
      if (key === 'domain') domain = v.replace(/^\./, '');
      else if (key === 'path') path = v || '/';
      else if (key === 'secure') secure = true;
      else if (key === 'max-age') expires = Math.floor(Date.now() / 1000) + Number(v);
      else if (key === 'expires') { const t = Date.parse(v); if (!isNaN(t)) expires = Math.floor(t / 1000); }
    }
    if (expires > 0 && expires < Date.now() / 1000) {
      jar = jar.filter(x => !(x.name === name && x.domain === domain && x.path === path));
      continue;
    }
    upsertCookie({ name, value, domain, path, secure, expires });
  }
}

/* ============================================================
 * HTTP（自动带 Cookie、自动跟随重定向、自动收 Set-Cookie）
 * ============================================================ */
function rawRequest(urlStr, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolveP, rejectP) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const cookie = cookiesFor(urlStr);
    const req = mod.request({
      hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
      method, agent: u.protocol === 'https:' ? agent : undefined,
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => (body += d));
      res.on('end', () => resolveP({ status: res.statusCode, headers: res.headers, body, url: urlStr }));
    });
    req.on('error', rejectP);
    req.end();
  });
}

async function httpGet(urlStr, opts = {}, maxHops = 10) {
  let url = urlStr;
  for (let i = 0; i < maxHops; i++) {
    const res = await rawRequest(url, opts);
    absorbSetCookie(res.headers['set-cookie'], url);
    const loc = res.headers.location;
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, url).toString();
      continue;
    }
    return { ...res, finalUrl: url };
  }
  throw new Error('重定向次数过多');
}

/* ============================================================
 * 门户接口
 * ============================================================ */
async function apiGet(path) {
  const res = await httpGet(BASE + '/' + path.replace(/^\/+/, ''), {
    headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/plain, */*' },
  });
  // 被踢回登录页 → 认为需要登录
  if (/\/login|lyuapServer|shiro-cas/i.test(res.finalUrl) && !/\/api\//i.test(res.finalUrl)) {
    const err = new Error('会话已失效'); err.code = 'NEED_LOGIN'; throw err;
  }
  let json;
  try { json = JSON.parse(res.body); }
  catch { const err = new Error('返回非 JSON（可能被重定向到登录页）'); err.code = 'NEED_LOGIN'; throw err; }
  if (!json.meta || json.meta.success !== true) {
    const msg = JSON.stringify(json.meta || json).slice(0, 200);
    const err = new Error('接口失败: ' + msg);
    if (/登录|权限|token|auth|未授权/i.test(msg)) err.code = 'NEED_LOGIN';
    else err.code = 'API_ERROR';
    throw err;
  }
  return json.data;
}

/* ============================================================
 * CAS 账号密码登录（应用内登录，不用再 Copy as cURL）
 * ------------------------------------------------------------
 * 逆向自 ids.gzist.edu.cn 的登录页 app.js：
 *   1) GET  {CAS}/lyuapServer/kaptcha?uid=      → {uid, content(图片 base64)}
 *   2) POST {CAS}/lyuapServer/v1/tickets        → 表单(不是 JSON！)
 *        username / password / service / loginType='' / id=uid / code=验证码答案
 *      成功返回 data.tgt(TGT-…) 或 data.ticket(ST-…)；
 *      失败返回 data.code = CODEFALSE / NOUSER / USERLOCK …
 *   3) 用 ticket 走一次 service 校验（或直接用 CASTGC 静默续期）→ 拿到门户 Cookie
 * ============================================================ */
const CAS = 'https://ids.gzist.edu.cn';
const CAS_SERVICE = 'https://portal.gzist.edu.cn/shiro-cas';

function formPost(urlStr, fields) {
  const body = new URLSearchParams(fields).toString();
  const u = new URL(urlStr);
  const cookie = cookiesFor(urlStr);
  return new Promise((resolveP, rejectP) => {
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST', agent,
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'application/json, text/plain, */*',
        Origin: CAS, Referer: CAS + '/lyuapServer/login',
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, res => {
      absorbSetCookie(res.headers['set-cookie'], urlStr);
      let b = ''; res.setEncoding('utf8');
      res.on('data', d => (b += d));
      res.on('end', () => resolveP({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('error', rejectP);
    req.write(body);
    req.end();
  });
}

const hasPortalAuth = () => jar.some(c => c.name === 'Authorization' && hostMatch('portal.gzist.edu.cn', c.domain));

/* CAS REST：拿着 CASTGC(TGT) 换一张新的 ST，再用 ST 换门户会话（无需密码）。
 * 实测：POST /lyuapServer/v1/tickets/{TGT}  body service=… → 纯文本 ST-…
 *       GET  https://portal.gzist.edu.cn/shiro-cas?ticket=ST-… → 302 + Set-Cookie Authorization/customsid */
async function casRestSession() {
  const tgt = jar.find(c => c.name === 'CASTGC' && hostMatch('ids.gzist.edu.cn', c.domain));
  if (!tgt) return false;
  try {
    const r = await formPost(CAS + '/lyuapServer/v1/tickets/' + encodeURIComponent(tgt.value), { service: CAS_SERVICE });
    const txt = String(r.body || '');
    const st = (txt.match(/ST-[0-9A-Za-z][0-9A-Za-z-]*/) || [])[0]
      || (String(r.headers.location || '').match(/ticket=(ST-[^&]+)/) || [])[1];
    if (!st) return false;
    await httpGet(CAS_SERVICE + (CAS_SERVICE.includes('?') ? '&' : '?') + 'ticket=' + encodeURIComponent(st));
    return hasPortalAuth();
  } catch { return false; }
}

/* 密码必须 RSA 加密后提交。
 * 算法完全复刻登录页 app.js 里的 jsbn 分支（同一份 modulus / 010001）：
 *   1) 明文按「UTF-16 码元」拆成 2 个一组，小端拼成 16 位字，一块 126 字节（=2*(数字个数-1)）
 *   2) 每块做 modPow(block, 65537) mod n
 *   3) 每块输出 256 位十六进制（不足左补 0），多块之间用「空格」连接
 * 已用站点自己的加密函数逐字节对比验证：ASCII 口令全部一致（含 126/140 字长的多块情况）。
 * 实测：明文密码 → 500 系统内部错误；正确密文 → 正常比对密码 */
const CAS_MODULUS = '00b5eeb166e069920e80bebd1fea4829d3d1f3216f2aabe79b6c47a3c18dcee5fd22c2e7ac519cab59198ece036dcf289ea8201e2a0b9ded307f8fb704136eaeb670286f5ad44e691005ba9ea5af04ada5367cd724b5a26fdb5120cc95b6431604bd219c6b7d83a6f8f24b43918ea988a76f93c333aa5a20991493d4eb1117e7b1';
const CAS_RSA_CHUNK = 126;   // 2 * (模数的 16 位数字个数 - 1)
const CAS_RSA_HEX = 256;     // 每块密文的十六进制长度

function rsaEncrypt(plain) {
  const n = BigInt('0x' + CAS_MODULUS), e = 65537n;
  const s = String(plain).replace(/\s+/g, '');   // 站点也会先去掉空白
  const codes = [];
  for (let i = 0; i < s.length; i++) codes.push(s.charCodeAt(i));
  const nblocks = Math.max(1, Math.ceil(codes.length / CAS_RSA_CHUNK));
  while (codes.length < nblocks * CAS_RSA_CHUNK) codes.push(0);

  const out = [];
  for (let off = 0; off < codes.length; off += CAS_RSA_CHUNK) {
    let m = 0n;
    // 小端：低字在前
    for (let i = CAS_RSA_CHUNK / 2 - 1; i >= 0; i--) {
      const lo = codes[off + i * 2] & 0xffff;
      const hi = (codes[off + i * 2 + 1] || 0) & 0xffff;
      m = (m << 16n) | BigInt((lo + (hi << 8)) & 0xffff);
    }
    let c = 1n, b = m % n, x = e;
    while (x > 0n) { if (x & 1n) c = (c * b) % n; b = (b * b) % n; x >>= 1n; }
    out.push(c.toString(16).padStart(CAS_RSA_HEX, '0'));
  }
  return out.join(' ');
}

async function casCaptcha() {
  const r = await httpGet(CAS + '/lyuapServer/kaptcha?uid=', { headers: { Referer: CAS + '/lyuapServer/login' } });
  const j = JSON.parse(r.body);
  if (!j.uid) throw new Error('验证码获取失败');
  return { uid: j.uid, image: j.content, type: j.kaptchaType };
}

const LOGIN_ERRORS = {
  CODEFALSE: '验证码错误',
  PASSERROR: '密码错误',
  NOUSER: '用户名或密码错误',
  USERLOCK: '账号已锁定，请稍后再试',
  USERDISABLED: '账号已被停用',
  USERNOTONLY: '账号不唯一，请联系管理员',
  TWOVERIFY: '需要二次验证（暂不支持，请改用粘贴 Cookie）',
  ISMODIFYPASS: '需要先修改密码才能登录（请先去门户改密）',
  ISPHONEOREMAILORANSWER: '需要手机/密保验证（暂不支持，请改用粘贴 Cookie）',
  ISBINDWX: '需要绑定微信（请改用粘贴 Cookie）',
  NETWORKCOMMITMENT: '需要先签署网络使用承诺书',
  NOREGISTER: '该账号未开通门户权限',
  NOAUTHORIZATION: '该账号未授权访问门户',
};

async function casLogin({ username, password, code, uid, loginType }) {
  if (!username || !password) throw new Error('请填写学号和密码');
  if (!uid || !code) throw new Error('请填写验证码');
  // 用一份干净的 Cookie 罐去登录：成功就换成新账号，失败则原样恢复（不影响当前登录态）
  const snapshot = jar.slice();
  jar.length = 0;
  try {
  const r = await formPost(CAS + '/lyuapServer/v1/tickets', {
    username: String(username).trim(),
    password: rsaEncrypt(String(password)),
    service: CAS_SERVICE,
    ...(loginType ? { loginType } : {}),   // 站点登录时这个字段是 undefined（不发送），别送空串
    id: uid,
    code: String(code).trim(),
  });
  if (process.env.GL_DEBUG) console.log('[login][raw]', r.status, r.body.slice(0, 400));
  else console.log('[login][raw]', r.status, r.body.replace(/\s+/g, ' ').slice(0, 300));
  let j;
  try { j = JSON.parse(r.body); } catch {
    throw new Error(r.body.trim().startsWith('<')
      ? 'CAS 返回了网页而不是数据（验证码可能已过期，请刷新验证码重试）'
      : '登录接口返回异常：' + r.body.slice(0, 120));
  }
  const d = j.data || {};
  if (d && d.code) {
    if (d.code === 'PASSERROR') {
      // data 形如 "5,1" → 「锁定阈值, 已连续错误次数」
      const [limit, count] = String(d.data || '').split(',');
      throw new Error(/^\d+$/.test(String(count))
        ? `密码已连续错误 ${count} 次（连续错 ${limit} 次会锁定账号）`
        : '密码错误');
    }
    throw new Error(LOGIN_ERRORS[d.code] || ('登录失败：' + d.code));
  }
  // 成功的样子有两种（都见过）：
  //   ① {"tgt":"TGT-…","ticket":"ST-…"}          ← 本项目实测到的真实成功回包（没有 meta！）
  //   ② {"meta":{"success":true},"data":{"tgt":…,"ticket":…}}
  const ok = (!j.meta || j.meta.success !== false) && (j.tgt || j.ticket || d.tgt || d.ticket);
  if (!ok) {
    throw new Error('登录失败：' + ((j.meta && (j.meta.message || j.meta.statusCode)) || '未知响应')
      + '〔CAS 回包 ' + r.status + ' ' + r.body.replace(/\s+/g, ' ').slice(0, 200) + '〕');
  }

  const tgt = j.tgt || d.tgt || (typeof j.data === 'string' ? j.data : '');
  const ticket = j.ticket || d.ticket;
  if (tgt) upsertCookie({ name: 'CASTGC', value: tgt, domain: 'ids.gzist.edu.cn', path: '/lyuapServer', secure: false, expires: -1 });

  // 用 ticket 换门户会话；没有 ticket 就走 CAS REST（TGT→ST），再造不出来就当失败
  if (ticket) {
    try { await httpGet(CAS_SERVICE + (CAS_SERVICE.includes('?') ? '&' : '?') + 'ticket=' + encodeURIComponent(ticket)); } catch {}
  }
  if (!hasPortalAuth()) await casRestSession();
  if (!hasPortalAuth()) await silentRenew();
  if (!hasPortalAuth()) throw new Error('已通过 CAS 认证，但没拿到门户会话（CAS 侧的 TGT 已入 jar，稍后重试可能自动恢复）');
  state.loggedOut = false;
  await saveJar();
  return true;
  } catch (e) {
    // 登录失败：恢复原来的 Cookie，当前账号继续可用
    jar.length = 0;
    jar.push(...snapshot);
    throw e;
  }
}

/* 静默续期：优先 CAS REST（TGT→ST→门户会话），退路是让门户自己跳一次 CAS（靠 CASTGC） */
async function silentRenew() {
  if (await casRestSession()) return true;
  try {
    const r = await httpGet(BASE + '/shiro-cas');
    const okPortal = /portal\.gzist\.edu\.cn\/(#|\/|index)/.test(r.finalUrl) && r.status === 200;
    return okPortal && hasPortalAuth();
  } catch { return false; }
}

/* 解析网格 */
const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
function parseCell(str) {
  if (!str) return null;
  const p = str.split(',');
  if (p.length < 2) return { name: str, room: '', teacher: '', cls: '' };
  return { name: p[0], room: p[1], teacher: p[p.length - 1], cls: p.slice(2, p.length - 1).join(',') };
}
function toBlocks(grid) {
  const blocks = [];
  (grid || []).forEach((row, di) => {
    let ci = 0;
    while (ci < row.length) {
      const cell = row[ci];
      if (!cell) { ci++; continue; }
      const info = parseCell(cell);
      let end = ci;
      while (end + 1 < row.length && row[end + 1] === cell) end++;
      blocks.push({ day: di, dayName: DAYS[di], startSection: ci + 1, endSection: end + 1, ...info });
      ci = end + 1;
    }
  });
  return blocks;
}

function cardId() { return authMeta.cardId || DEFAULT_CARD_ID; }

/* --- 从登录态里认出「当前是谁」 ---------------------------------------
 * 门户没有可直接调的"当前用户"接口（都会被 500/401 挡），所以：
 *   学号：解码 Cookie 里 Authorization 这个 JWT 的 sub
 *   班级：从课表教学班名（如 "某某课程-25XX17班-理论"）里抠
 *   姓名：只能沿用之前记录过的（换号时界面就显示学号，不影响使用）
 * ------------------------------------------------------------------ */
function decodeJwtPayload(tok) {
  try {
    const p = String(tok).split('.')[1];
    if (!p) return null;
    const b64 = p.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch { return null; }
}

function studentId() {
  const c = jar.find(x => x.name === 'Authorization' && hostMatch('portal.gzist.edu.cn', x.domain));
  if (!c) return null;
  const p = decodeJwtPayload(c.value);
  return p && p.sub ? String(p.sub) : null;
}

function deptFromBlocks(termsData) {
  const pick = (b) => /-(\d{2}[^-]{0,20}?班)-/.exec(b.cls || '') || /-(\d{2}[^-]{0,20}?班)/.exec(b.cls || '');
  for (const t of Object.values(termsData || {})) {
    const pools = [];
    if (t.blocks) pools.push(t.blocks);
    for (const w of Object.values(t.weeks || {})) pools.push(w.blocks || []);
    for (const pool of pools) for (const b of pool) { const m = pick(b); if (m) return m[1]; }
  }
  return null;
}

/* 一周的数据：results=周次 就是选周（实测 API 的周次参数叫 results，很反直觉） */
async function fetchWeek(cardIdV, xnq, week) {
  const q = `api/uppcard/kbsz/queryAWeekSchedule?cardId=${cardIdV}&results=${week ? week : ''}&years=${encodeURIComponent(xnq)}`;
  const d = await apiGet(q);
  return d || null;
}

async function doFetchAll() {
  const terms = await apiGet(`api/uppcard/kbsz/queryAllTerm?cardId=${cardId()}`);
  const termList = (terms || []).map(t => t.XNXQ);
  const termsData = {};
  for (const xnq of termList) {
    // 不带 results 时返回「当前周」，顺带告诉我们 weekcount / 当前周次
    const base = await fetchWeek(cardId(), xnq, '');
    if (!base) { termsData[xnq] = { blocks: [], weeks: {} }; continue; }
    const weekcount = Math.min(30, Math.max(1, Number(base.weekcount) || 20));
    const currentWeek = Number(base.zs) || null;
    const grids = {};
    if (currentWeek) grids[currentWeek] = base.resultsJsonArr || [];
    for (let w = 1; w <= weekcount; w++) {
      if (grids[w]) continue;
      let d = null;
      try { d = await fetchWeek(cardId(), xnq, w); } catch (e) { if (e.code === 'NEED_LOGIN') throw e; }
      grids[w] = (d && d.resultsJsonArr) || [];
    }
    const weeks = {};
    for (let w = 1; w <= weekcount; w++) weeks[w] = toBlocks(grids[w]);
    const cw = currentWeek || 1;
    termsData[xnq] = {
      xn: base.xn, xq: base.xq, zsms: base.zsms, weekcount, currentWeek,
      swskjc: base.swskjc, xwskjc: base.xwskjc, wsskjc: base.wsskjc,
      weeks,                                   // { "1": blocks[], … }
      zs: String(cw),
      blocks: weeks[cw] || [],                 // 兼容：默认给出当前周
    };
  }
  // 认出当前账号
  const sid = studentId();
  const known = (authMeta.known && sid && authMeta.known[sid]) || {};
  const prev = (authMeta.student && (!sid || String(authMeta.student.userId || '') === sid)) ? authMeta.student : {};
  const dept = prev.dept || deptFromBlocks(termsData);
  const name = prev.name || known.name || null;
  const student = (sid || dept || name)
    ? { userId: sid, name, dept }
    : null;
  if (sid && name) {
    authMeta.known = authMeta.known || {};
    authMeta.known[sid] = { name };
  }
  if (student) authMeta.student = student;

  return {
    fetchedAt: new Date().toISOString(),
    source: 'portal.gzist.edu.cn / ly-upp kbsz',
    cardId: cardId(),
    student,
    terms: termList,
    termsData,
  };
}

/* ============================================================
 * 同步流程
 * ============================================================ */
let syncing = null;
async function sync({ reason = 'auto' } = {}) {
  if (syncing) return syncing;
  syncing = (async () => {
    state.status = 'syncing'; state.message = `同步中（${reason}）`;
    try {
      let data;
      try {
        data = await doFetchAll();
      } catch (e) {
        if (e.code === 'NEED_LOGIN') {
          state.message = '会话失效，尝试静默续期…';
          const renewed = await silentRenew();
          if (!renewed) { const err = new Error('登录已失效，需要重新导入 Cookie'); err.code = 'NEED_LOGIN'; throw err; }
          data = await doFetchAll();
        } else throw e;
      }
      // 保留旧的 student（若接口没给）
      if (!data.student) {
        try { data.student = JSON.parse(await readFile(DATA_JSON, 'utf8')).student || null; } catch {}
      }
      const json = JSON.stringify(data, null, 2);
      await writeFile(DATA_JSON, json, 'utf8');
      await writeFile(DATA_JS, 'window.__KB_DATA__=' + JSON.stringify(data) + ';', 'utf8');
      await saveJar();

      state.status = 'ok'; state.needLogin = false; state.lastError = null;
      state.loggedOut = false;
      state.lastSyncAt = data.fetchedAt; state.message = '同步成功';
      console.log(`[sync] ok ${data.fetchedAt} (${reason})`);
      return data;
    } catch (e) {
      state.status = e.code === 'NEED_LOGIN' ? 'needLogin' : 'error';
      state.needLogin = e.code === 'NEED_LOGIN';
      state.lastError = e.message;
      state.message = e.message;
      console.warn(`[sync] 失败:`, e.message);
      throw e;
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

/* 会话保活：轻量探活，避免服务端 session 闲置过期 */
async function keepAlive() {
  try {
    await apiGet(`api/uppcard/kbsz/queryAllTerm?cardId=${cardId()}`);
    return true;
  } catch (e) {
    if (e.code === 'NEED_LOGIN') { try { return await silentRenew(); } catch { return false; } }
    return false;
  }
}

/* ============================================================
 * HTTP 服务
 * ============================================================ */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(s);
}
function readBody(req) {
  return new Promise((resolveP, rejectP) => {
    let b = ''; req.setEncoding('utf8');
    req.on('data', d => (b += d));
    req.on('end', () => resolveP(b));
    req.on('error', rejectP);
  });
}

async function currentData() {
  try { return JSON.parse(await readFile(DATA_JSON, 'utf8')); } catch { return null; }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  try {
    /* ---------- API ---------- */
    if (p === '/api/status') {
      return json(res, 200, { ok: true, ...state, autoSyncMin: SYNC_MIN, keepaliveMin: KEEPALIVE_MIN, hasCookies: jar.length > 0 });
    }

    if (p === '/api/schedule' && req.method === 'GET') {
      const data = await currentData();
      return json(res, 200, {
        ok: !!data, state: { ...state },
        fetchedAt: data ? data.fetchedAt : null,
        student: data ? data.student : null,
        data,
      });
    }

    if (p === '/api/sync' && req.method === 'POST') {
      try {
        const data = await sync({ reason: 'manual' });
        return json(res, 200, { ok: true, fetchedAt: data.fetchedAt, state });
      } catch (e) {
        return json(res, 200, { ok: false, error: e.message, needLogin: state.needLogin, state });
      }
    }

    /* 取登录验证码（算术题图片，100x25 PNG dataURL） */
    if (p === '/api/auth/captcha' && req.method === 'GET') {
      const cap = await casCaptcha();
      return json(res, 200, { ok: true, uid: cap.uid, image: cap.image, type: cap.type });
    }

    /* 学号+密码+验证码 登录，成功后立刻同步一次课表 */
    if (p === '/api/auth/login' && req.method === 'POST') {
      const raw = await readBody(req);
      let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
      try {
        await casLogin(body);
        const data = await sync({ reason: 'login' });
        console.log('[login]', body.username, '→ 成功', data.student && data.student.userId);
        return json(res, 200, { ok: true, fetchedAt: data.fetchedAt, student: data.student, state });
      } catch (e) {
        console.log('[login]', body.username, '→ 失败:', e.message);
        return json(res, 200, { ok: false, error: e.message, state });
      }
    }

    if (p === '/api/auth/cookies' && req.method === 'POST') {
      const raw = await readBody(req);
      let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
      let imported = 0;
      // 形式一：cookies 数组（CDP Network.getAllCookies 的结果）
      if (Array.isArray(body.cookies)) {
        for (const c of body.cookies) {
          if (!c || !c.name) continue;
          if (body.onlyGzist !== false && !/gzist\.edu\.cn$/i.test(String(c.domain || '').replace(/^\./, ''))) continue;
          upsertCookie({
            name: c.name, value: c.value,
            domain: String(c.domain || '').replace(/^\./, ''),
            path: c.path || '/', secure: !!c.secure,
            expires: typeof c.expires === 'number' && c.expires > 0 ? Math.floor(c.expires) : -1,
          });
          imported++;
        }
      }
      // 形式二：Cookie: 原始串（从 DevTools / cURL 复制）
      if (typeof body.cookie === 'string' && body.cookie.trim()) {
        const domain = body.domain || 'portal.gzist.edu.cn';
        for (const kv of body.cookie.split(';')) {
          const i = kv.indexOf('='); if (i < 0) continue;
          upsertCookie({ name: kv.slice(0, i).trim(), value: kv.slice(i + 1).trim(), domain, path: '/', secure: true, expires: -1 });
          imported++;
        }
      }
      if (body.student) {
        authMeta.student = body.student;
        const sid = studentId() || String(body.student.userId || '');
        if (sid && body.student.name) {
          authMeta.known = authMeta.known || {};
          authMeta.known[sid] = { name: body.student.name };
        }
      }
      if (body.cardId) authMeta.cardId = body.cardId;
      await saveJar();
      return json(res, 200, { ok: true, imported, total: jar.length });
    }

    /* 退出登录 / 切换账号：清空 Cookie（可选连数据一起清），避免看到上一个账号的课表 */
    if (p === '/api/auth/logout' && req.method === 'POST') {
      const raw = await readBody(req);
      let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
      const wipe = body.wipe !== false;
      const removed = jar.length;
      jar = []; authMeta = { known: authMeta.known || {} };   // 保留「学号→姓名」记忆，重登同一账号仍能显示名字
      await saveJar();
      if (wipe) {
        for (const f of [DATA_JSON, DATA_JS]) { try { await unlink(f); } catch {} }
      }
      state = {
        status: 'needLogin', message: '已退出登录', lastSyncAt: null,
        lastError: null, needLogin: true, loggedOut: true,
      };
      console.log(`[auth] 退出登录，清除 ${removed} 个 Cookie${wipe ? '，已清空课表数据' : ''}`);
      return json(res, 200, { ok: true, removed, wiped: wipe, state });
    }

    /* ---------- 静态文件 ---------- */
    let rel = decodeURIComponent(p);
    if (rel === '/' || rel === '') rel = '/index.html';
    const filePath = normalize(join(WEB, rel));
    if (!filePath.startsWith(WEB)) { res.writeHead(403); return res.end('forbidden'); }
    if (existsSync(filePath) && (await stat(filePath)).isFile()) {
      const buf = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      return res.end(buf);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  } catch (e) {
    json(res, 500, { ok: false, error: e.message });
  }
});

/* ============================================================
 * 启动
 * ============================================================ */
await loadJar();
server.listen(PORT, () => {
  console.log(`\n  广理课表服务已启动`);
  console.log(`  → http://127.0.0.1:${PORT}/`);
  console.log(`  Cookie 数量: ${jar.length}   自动同步: 每 ${SYNC_MIN} 分钟   保活: 每 ${KEEPALIVE_MIN} 分钟\n`);
});
sync({ reason: 'startup' }).catch(() => console.warn('  首次同步失败，可先导入 Cookie：POST /api/auth/cookies'));
setInterval(() => sync({ reason: 'auto' }).catch(() => {}), SYNC_MIN * 60 * 1000);
setInterval(() => keepAlive(), KEEPALIVE_MIN * 60 * 1000);

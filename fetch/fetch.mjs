#!/usr/bin/env node
/**
 * 广理课表 · 逆向提取脚本
 * ------------------------------------------------------------------
 * 作用：用门户登录后的 accessToken(JWT) 调用「联奕「ly-upp」融合门户」的
 *       课表接口，抓取本人整学期周课表，输出成结构化 JSON（供前端使用）。
 *
 * 接口（均在 https://portal.gzist.edu.cn 下）：
 *   GET api/uppcard/kbsz/queryAllTerm?cardId=<CARD_ID>
 *   GET api/uppcard/kbsz/queryAWeekSchedule?cardId=<CARD_ID>&results=&years=<学年学期>
 *   请求头：Authorization: <JWT>   (即 sessionStorage.userLogin 里的 tokenId)
 *
 * 用法：
 *   node fetch.mjs --token <JWT> [--card-id <ID>] [--out ./data.json]
 *
 * 如何拿到 token / cardId：见 ../docs/逆向说明.md
 * ------------------------------------------------------------------
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const BASE = 'https://portal.gzist.edu.cn/';
// 系统内置「学生课表」卡片的实例 id（一般全校统一；如失效用 --card-id 覆盖）
const DEFAULT_CARD_ID = process.env.GL_CARD_ID || 'YOUR_CARD_ID';

// ---------- 解析命令行参数 ----------
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      args[key] = val;
    }
  }
  return args;
}

// ---------- 统一请求 ----------
async function api(path, token) {
  const res = await fetch(BASE + path, {
    method: 'GET',
    headers: {
      Authorization: token,
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/plain, */*',
    },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`非 JSON 响应 (HTTP ${res.status}): ${text.slice(0, 200)}`); }
  if (!json.meta || json.meta.success !== true) {
    throw new Error(`接口返回失败: ${JSON.stringify(json.meta || json).slice(0, 200)}`);
  }
  return json.data;
}

// ---------- 解析单个格子 "课程名,教室,教学班...,教师" ----------
function parseCell(str) {
  if (!str) return null;
  const p = str.split(',');
  if (p.length < 2) return { name: str, room: '', teacher: '', cls: '' };
  return {
    name: p[0],
    room: p[1],
    teacher: p[p.length - 1],
    cls: p.slice(2, p.length - 1).join(','),
  };
}

const DAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

// 把 7x12 的原始网格整理成「课程块」列表（相邻同课合并成 start-end 节）
function toBlocks(grid) {
  const blocks = [];
  grid.forEach((row, di) => {
    let ci = 0;
    while (ci < row.length) {
      const cell = row[ci];
      if (!cell) { ci++; continue; }
      const info = parseCell(cell);
      let end = ci;
      while (end + 1 < row.length && row[end + 1] === cell) end++;
      blocks.push({
        day: di,
        dayName: DAY_NAMES[di],
        startSection: ci + 1,
        endSection: end + 1,
        ...info,
      });
      ci = end + 1;
    }
  });
  return blocks;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = args.token || process.env.GL_TOKEN;
  if (!token) {
    console.error('缺少 token。用法: node fetch.mjs --token <JWT>  (token 见 docs/逆向说明.md)');
    process.exit(1);
  }
  const cardId = args['card-id'] || DEFAULT_CARD_ID;

  console.log('[1/3] 获取学期列表 queryAllTerm ...');
  const terms = await api(`api/uppcard/kbsz/queryAllTerm?cardId=${cardId}`, token);
  const termList = (terms || []).map((t) => t.XNXQ);
  console.log('     学期:', termList.join(', ') || '(空)');

  const termsData = {};
  for (const [i, xnq] of termList.entries()) {
    console.log(`[2/3] 获取课表 ${xnq} (queryAWeekSchedule) ...`);
    const d = await api(
      `api/uppcard/kbsz/queryAWeekSchedule?cardId=${cardId}&results=&years=${encodeURIComponent(xnq)}`,
      token,
    );
    if (!d) { termsData[xnq] = null; continue; }
    termsData[xnq] = {
      xn: d.xn, xq: d.xq, zs: d.zs, weekcount: d.weekcount,
      swskjc: d.swskjc, xwskjc: d.xwskjc, wsskjc: d.wsskjc,
      grid: d.resultsJsonArr,
      blocks: toBlocks(d.resultsJsonArr),
    };
  }

  const out = {
    fetchedAt: new Date().toISOString(),
    source: 'portal.gzist.edu.cn / ly-upp kbsz',
    cardId,
    terms: termList,
    termsData,
  };

  const __dir = dirname(fileURLToPath(import.meta.url));
  const outPath = resolve(__dir, args.out || '../web/data.json');
  console.log(`[3/3] 写入 ${outPath} ...`);
  const json = JSON.stringify(out, null, 2);
  await writeFile(outPath, json, 'utf8');
  // 同时产出一份 data.js，前端 <script> 直接引入即可（双击 index.html 也能跑，免 file:// CORS）
  await writeFile(resolve(dirname(outPath), 'data.js'), 'window.__KB_DATA__=' + JSON.stringify(out) + ';', 'utf8');
  console.log('完成 ✓');
}

main().catch((e) => { console.error('失败:', e.message); process.exit(1); });

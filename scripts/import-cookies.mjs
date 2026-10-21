#!/usr/bin/env node
/**
 * 导入门户 Cookie 到本地服务端（用于登录失效后恢复）
 *
 * 用法：
 *   node scripts/import-cookies.mjs                 # 从剪贴板读（Windows）
 *   node scripts/import-cookies.mjs clip.txt        # 从文件读
 *   node scripts/import-cookies.mjs "a=1; b=2"      # 直接给 Cookie 串
 *
 * 支持两种粘贴内容：
 *   1) 浏览器 DevTools 里「Copy as cURL」的整段命令（自动提取 -b / Cookie 头）
 *   2) 纯 Cookie 字符串，如 `SESSION=xxx; token=yyy`
 *
 * 之后会自动调用 /api/sync 立即同步一次课表。
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SERVER = process.env.KB_SERVER || 'http://127.0.0.1:8787';
const DOMAIN = process.env.KB_DOMAIN || 'portal.gzist.edu.cn';

function fromClipboard() {
  try {
    if (process.platform === 'win32') {
      return execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8' });
    }
    if (process.platform === 'darwin') {
      return execFileSync('pbpaste', { encoding: 'utf8' });
    }
    return execFileSync('xclip', ['-selection', 'clipboard', '-o'], { encoding: 'utf8' });
  } catch {
    return '';
  }
}

/** 从任意文本里提取 cookie 串 */
function extractCookie(text) {
  const t = String(text || '').trim();
  if (!t) return '';

  // 1) cURL: -H 'Cookie: xxx' / --header 'cookie: xxx'
  let m = /(?:-H|--header)\s+['"](?:cookie|Cookie):\s*([^'"]+)['"]/i.exec(t);
  if (m) return m[1].trim();

  // 2) cURL: -b 'xxx' / --cookie 'xxx'
  m = /(?:-b|--cookie)\s+['"]([^'"]+)['"]/i.exec(t);
  if (m && m[1].includes('=')) return m[1].trim();

  // 3) 头部行：Cookie: xxx
  m = /(?:^|\n)\s*cookie:\s*(.+)/i.exec(t);
  if (m) return m[1].trim();

  // 4) 纯 cookie 串（含 = 且不含空格命令关键字）
  if (t.includes('=') && !/\bcurl\b/i.test(t)) return t.split('\n')[0].trim();

  return '';
}

async function main() {
  const arg = process.argv.slice(2).join(' ').trim();

  let raw = '';
  if (!arg) {
    raw = fromClipboard();
    if (!raw) {
      console.error('✗ 剪贴板为空。请先复制 cURL 或 Cookie 串，或直接传文件/字符串参数。');
      process.exit(1);
    }
    console.log('· 已从剪贴板读取', raw.length, '字符');
  } else if (arg.length < 260 && /\.(txt|json|har|curl)$/i.test(arg)) {
    raw = readFileSync(arg, 'utf8');
    console.log('· 已读取文件', arg, raw.length, '字符');
  } else {
    raw = arg;
  }

  const cookie = extractCookie(raw);
  if (!cookie) {
    console.error('✗ 没能从内容里提取到 Cookie。请粘贴「Copy as cURL」的完整命令，或纯 Cookie 串。');
    process.exit(1);
  }

  const names = cookie.split(';').map(s => s.split('=')[0].trim()).filter(Boolean);
  console.log('· 提取到 Cookie 字段：', names.join(', ') || '(空)');

  const r = await fetch(`${SERVER}/api/auth/cookies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookie, domain: DOMAIN }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) {
    console.error('✗ 导入失败：', j.error || r.status);
    process.exit(1);
  }
  console.log(`✓ 已导入 ${j.imported} 个 Cookie（当前共 ${j.total} 个）`);

  console.log('· 正在同步课表…');
  const s = await fetch(`${SERVER}/api/sync`, { method: 'POST' }).then(x => x.json()).catch(e => ({ ok: false, error: e.message }));
  if (s.ok) {
    console.log('✓ 同步成功，更新时间：', s.state?.lastSyncAt || s.fetchedAt);
  } else {
    console.error('✗ 同步失败：', s.error || JSON.stringify(s));
    console.error('  若提示需要登录，说明 Cookie 已过期或不是门户域(portal.gzist.edu.cn)的。');
    process.exit(2);
  }
}

main().catch(e => { console.error('✗', e.message); process.exit(1); });

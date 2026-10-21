// 把 web/data.json 里的学生信息补进 data/auth.json 的 meta.student（避免在命令行里传中文）
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, '..');
const AUTH = resolve(ROOT, 'data/auth.json');
const DATA = resolve(ROOT, 'web/data.json');

const auth = JSON.parse(await readFile(AUTH, 'utf8'));
let student = null;
try { student = JSON.parse(await readFile(DATA, 'utf8')).student; } catch {}
auth.meta = auth.meta || {};
if (student) auth.meta.student = student;
auth.meta.cardId = auth.meta.cardId || process.env.GL_CARD_ID || 'YOUR_CARD_ID';
await writeFile(AUTH, JSON.stringify(auth, null, 2), 'utf8');
console.log('ok student =', JSON.stringify(auth.meta.student));

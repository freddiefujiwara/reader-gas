// src/main.js から Apps Script 用の dist/Code.gs を生成する。
// export 文は正規表現で除去するため、src 側の export は必ず1行で書くこと。
// あわせて appsscript.json を dist へコピーする（clasp push に必須）。
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';

const src = readFileSync(new URL('./src/main.js', import.meta.url), 'utf8');
const code = src.replace(/^export\s*\{[^}]*\};?\s*$/m, '');
mkdirSync(new URL('./dist', import.meta.url), { recursive: true });
writeFileSync(new URL('./dist/Code.gs', import.meta.url), code);
copyFileSync(new URL('./appsscript.json', import.meta.url), new URL('./dist/appsscript.json', import.meta.url));
console.log('dist/Code.gs written', code.length, 'chars; dist/appsscript.json copied');

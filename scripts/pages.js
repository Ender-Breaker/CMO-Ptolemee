/* Prépare le site statique pour Cloudflare Pages dans dist/ :
   seulement les pages, le style, les scripts du navigateur et les images.
   Le README, la configuration Firebase et le code serveur ne sont pas publiés.
   Cloudflare Pages : commande de build `node scripts/pages.js`, répertoire de sortie `dist`. */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const file of fs.readdirSync(ROOT)) {
    if (/\.html$/.test(file) || file === 'style.css') fs.copyFileSync(path.join(ROOT, file), path.join(OUT, file));
}
for (const dir of ['js', 'assets']) {
    fs.cpSync(path.join(ROOT, dir), path.join(OUT, dir), { recursive: true });
}

// En-têtes de sécurité (équivalent de l'ancienne section hosting de firebase.json).
fs.writeFileSync(path.join(OUT, '_headers'), [
    '/*',
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    '  X-Frame-Options: SAMEORIGIN',
    '',
    '/*.js',
    '  Cache-Control: no-cache',
    '',
    '/*.css',
    '  Cache-Control: no-cache',
    ''
].join('\n'));

console.log('Site prêt pour Cloudflare Pages : ' + fs.readdirSync(OUT).join(', '));

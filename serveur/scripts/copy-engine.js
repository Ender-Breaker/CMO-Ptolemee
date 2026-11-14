/* Copie le moteur du site (js/) dans serveur/engine/ : les Cloud Functions
   exécutent exactement les mêmes règles que le navigateur. Lancé automatiquement
   avant chaque déploiement (firebase.json → predeploy). */

'use strict';

const fs = require('fs');
const path = require('path');

const FILES = ['core.js', 'research.js', 'ops.js'];
const src = path.join(__dirname, '..', '..', 'js');
const dst = path.join(__dirname, '..', 'engine');

fs.mkdirSync(dst, { recursive: true });
for (const file of FILES) {
    fs.copyFileSync(path.join(src, file), path.join(dst, file));
}
console.log('Moteur copié : ' + FILES.join(', ') + ' → serveur/engine/');

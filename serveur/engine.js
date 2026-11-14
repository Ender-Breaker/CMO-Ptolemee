/* ==========================================================================
   GOC — Division PTOLÉMÉE · Moteur côté serveur
   Charge dans un bac à sable les mêmes fichiers que le navigateur
   (core.js, research.js, ops.js, copiés dans serveur/engine/ au déploiement)
   pour que les règles du jeu soient strictement identiques des deux côtés.
   Les échanges avec le bac à sable se font en texte JSON uniquement.
   ========================================================================== */

'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'engine');
const FILES = ['core.js', 'research.js', 'ops.js'];

let GOC = null;

function boot() {
    if (GOC) return GOC;
    const noop = () => {};
    const sandbox = {
        console: { log: noop, warn: noop, error: (...args) => console.error(...args) },
        localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
        document: { cookie: '', documentElement: { classList: { add: noop, remove: noop } } },
        location: { pathname: '/', search: '', href: '', replace: noop }
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    for (const file of FILES) {
        const code = fs.readFileSync(path.join(DIR, file), 'utf8');
        vm.runInContext(code, sandbox, { filename: file });
    }
    const G = sandbox.GOC;
    if (!G || !G.Ops || G.remote) throw new Error('Moteur PTOLÉMÉE mal chargé.');
    G.Ops.mode = 'server';
    G.Store.save = noop; // la persistance est assurée par store.js
    GOC = G;
    return GOC;
}

/** Applique `action` ({op, args, ids}) — ou seulement la clôture des travaux arrivés
 *  à terme si `action` est nul — pour le compte `meId`.
 *  Renvoie { db, result, changed, finished, snapshot }. */
function run(db, meId, action) {
    const G = boot();
    const out = G.Ops.server(JSON.stringify(db), meId || null, action ? JSON.stringify(action) : '');
    return JSON.parse(out);
}

/** État de jeu neuf (arbre officiel), sans comptes ni journal. */
function freshState() {
    const G = boot();
    const db = JSON.parse(JSON.stringify(G.Store.fresh()));
    delete db.users;
    delete db.sessions;
    delete db.logs;
    return db;
}

function isOp(name) {
    return Object.prototype.hasOwnProperty.call(boot().Ops.LIST, name);
}

function validateRequest(data) {
    return JSON.parse(JSON.stringify(boot().Accounts.validateRequest(JSON.parse(JSON.stringify(data || {})))));
}

function teamLabel(team) {
    return boot().UI.teamLabel(team);
}

module.exports = { run, freshState, isOp, validateRequest, teamLabel };

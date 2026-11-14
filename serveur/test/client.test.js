/* Tests du relais navigateur (mode Firebase) : node test/client.test.js
   Charge les fichiers du site comme un navigateur configuré pour Firebase, sans le SDK,
   et vérifie que chaque action affichée localement est rejouée à l'identique par le serveur. */

'use strict';

const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const engine = require('../engine');

const JS = path.join(__dirname, '..', 'engine');
let passed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('  ok   ' + name);
    } catch (err) {
        console.log('  FAIL ' + name + '\n       ' + err.message);
        process.exitCode = 1;
    }
}

/** Un « navigateur » : fichiers du site chargés avec une configuration Firebase renseignée. */
function browser() {
    const noop = () => {};
    const classes = new Set();
    const storage = {};
    const sandbox = {
        console: { log: noop, warn: noop, error: noop },
        localStorage: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = v; }, removeItem: (k) => { delete storage[k]; } },
        document: { cookie: '', documentElement: { classList: { add: (...c) => c.forEach((x) => classes.add(x)), remove: (c) => classes.delete(c) } } },
        location: { pathname: '/', search: '', href: '', replace: noop },
        GOC_FIREBASE: { apiKey: 'test', projectId: 'test' }
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    for (const f of ['core.js', 'research.js', 'ops.js']) {
        vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), sandbox, { filename: f });
    }
    return { G: sandbox.GOC, storage, classes };
}

const NOW = Date.now();
function serverDb() {
    const db = engine.freshState();
    db.users = [
        { id: 'dev', username: 'Admin', rpName: 'Console', discord: '—', google: 'dev@gmail.com', team: null, role: 'admin', status: 'approved', hidden: true, points: 999999, note: '', createdAt: NOW, approvedAt: NOW, approvedBy: null },
        { id: 'cher', username: 'cher', rpName: 'RP', discord: 'd', google: 'c@gmail.com', team: 'rd', role: 'chercheur', status: 'approved', hidden: false, points: 800, note: '', createdAt: NOW, approvedAt: NOW, approvedBy: null }
    ];
    db.logs = [];
    db.sessions = [];
    return db;
}

/** Navigateur connecté : état reçu du serveur, relais installé. */
function connected(meId) {
    const b = browser();
    const db = serverDb();
    const snap = engine.run(db, meId, null).snapshot;
    b.G.Store.hydrate(JSON.parse(JSON.stringify(snap)), meId);
    b.sent = [];
    b.G.Ops.install((name, args, ids) => b.sent.push({ op: name, args, ids }));
    b.db = db;
    return b;
}

console.log('--- Démarrage ---');
test('mode Firebase détecté, pages mises en attente', () => {
    const { G, classes } = browser();
    assert.strictEqual(G.remote, true);
    assert.strictEqual(G.Ops.mode, 'remote');
    assert.ok(classes.has('mode-remote') && classes.has('is-syncing'));
    const order = [];
    G.ready(() => order.push('a'));
    G.ready(() => order.push('b'));
    assert.deepStrictEqual(order, []);
    G.markReady();
    assert.deepStrictEqual(order, ['a', 'b']);
    assert.ok(!classes.has('is-syncing'));
    G.ready(() => order.push('c'));
    assert.deepStrictEqual(order, ['a', 'b', 'c']);
});
test('rien n\'est jamais écrit dans le navigateur', () => {
    const b = connected('cher');
    const r = b.G.Research.all().find((x) => !x.requires.length);
    b.G.Research.contribute(r.id, 100);
    assert.deepStrictEqual(Object.keys(b.storage), []);
});
test('compte courant retrouvé dans l\'état reçu', () => {
    const b = connected('cher');
    assert.strictEqual(b.G.Auth.current().id, 'cher');
    assert.strictEqual(b.G.Auth.can('chercheur'), true);
    assert.strictEqual(b.G.Auth.can('membre'), false);
});

console.log('--- Relais des actions ---');
test('versement : affiché tout de suite et envoyé une fois', () => {
    const b = connected('cher');
    const r = b.G.Research.all().find((x) => !x.requires.length);
    const res = b.G.Research.contribute(r.id, 300);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(b.G.Auth.current().points, 500);
    assert.strictEqual(b.sent.length, 1);
    assert.strictEqual(b.sent[0].op, 'Research.contribute');
    assert.strictEqual(JSON.stringify(b.sent[0].args), JSON.stringify([r.id, 300]));
});
test('action refusée localement : rien n\'est envoyé', () => {
    const b = connected('cher');
    const r = b.G.Research.all().find((x) => !x.requires.length);
    assert.strictEqual(b.G.Research.contribute(r.id, 5000).ok, false);
    assert.strictEqual(b.sent.length, 0);
});
test('lecture seule jamais envoyée', () => {
    const b = connected('cher');
    b.G.Research.tick();
    b.G.Research.stats();
    b.G.Research.tree('chercheur');
    assert.strictEqual(b.sent.length, 0);
});
test('appels imbriqués : un seul envoi', () => {
    const b = connected('dev');
    const tier = b.G.Research.tiers()[0];
    const res = b.G.Research.upsertResearch({
        name: 'Essai', type: 'secondaire', team: 'rd', tierId: tier.id, cost: 600, duration: 300, requires: []
    });
    assert.ok(res && res.ok !== false, JSON.stringify(res && res.error));
    assert.strictEqual(b.sent.length, 1);
    assert.strictEqual(b.sent[0].op, 'Research.upsertResearch');
    assert.ok(b.sent[0].ids.length >= 1);
});
test('le serveur recrée la recherche avec le même identifiant', () => {
    const b = connected('dev');
    const tier = b.G.Research.tiers()[0];
    b.G.Research.upsertResearch({ name: 'Essai', type: 'secondaire', team: 'rd', tierId: tier.id, cost: 600, duration: 300, requires: [] });
    const local = b.G.Research.all().find((x) => x.name === 'Essai');
    const s = b.sent[0];
    const out = engine.run(b.db, 'dev', { op: s.op, args: s.args, ids: s.ids });
    const remote = out.db.researches.find((x) => x.name === 'Essai');
    assert.strictEqual(remote.id, local.id);
    assert.strictEqual(remote.code, local.code);
});
test('suite d\'actions dépendantes : création puis lien, identiques côté serveur', () => {
    const b = connected('dev');
    const R = b.G.Research;
    const tier = R.tiers()[0];
    R.upsertResearch({ name: 'Essai A', type: 'secondaire', team: 'rd', tierId: tier.id, cost: 600, duration: 300, requires: [] });
    const a = R.all().find((x) => x.name === 'Essai A');
    const target = R.all().find((x) => x.tierId === tier.id && x.id !== a.id && x.type === 'principale');
    R.link(a.id, target.id);
    let db = b.db;
    b.sent.forEach((s) => { db = engine.run(db, 'dev', s).db; });
    const t = db.researches.find((x) => x.id === target.id);
    assert.ok(t.requires.indexOf(a.id) >= 0);
});
test('validation d\'un compte : même résultat des deux côtés', () => {
    const b = connected('dev');
    const db = b.db;
    db.users.push({ id: 'new', username: 'nouveau', rpName: 'N', discord: 'n', google: 'n@gmail.com', team: 'qm', role: 'chercheur', status: 'pending', hidden: false, points: 0, note: '', createdAt: NOW, approvedAt: null, approvedBy: null });
    b.G.Store.hydrate(JSON.parse(JSON.stringify(engine.run(db, 'dev', null).snapshot)), 'dev');
    const res = b.G.Accounts.approve('new', 'membre', 'qm');
    assert.strictEqual(res.ok, true);
    const out = engine.run(db, 'dev', b.sent[0]);
    const local = b.G.Store.load().users.find((u) => u.id === 'new');
    const remote = out.db.users.find((u) => u.id === 'new');
    assert.strictEqual(remote.status, local.status);
    assert.strictEqual(remote.points, local.points);
    assert.strictEqual(remote.role, 'membre');
});

console.log('\n' + passed + ' test(s) réussi(s)' + (process.exitCode ? ', des échecs' : ''));

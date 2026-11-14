/* Tests du moteur serveur (sans base) : node test/engine.test.js
   Vérifie que les règles, les droits et le filtrage des données tiennent côté serveur. */

'use strict';

const assert = require('assert');
const engine = require('../engine');
const store = require('../store');

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

const NOW = Date.now();
function user(id, role, extra) {
    return Object.assign({
        id, username: id, rpName: 'RP ' + id, discord: id + '#d', google: id + '@gmail.com', team: 'rd',
        role, status: 'approved', hidden: false, points: 1000, note: '', createdAt: NOW, approvedAt: NOW, approvedBy: null
    }, extra || {});
}

function baseDb() {
    const db = engine.freshState();
    db.users = [
        user('dev', 'admin', { hidden: true, username: 'Admin', points: 999999, google: 'dev@gmail.com' }),
        user('chef', 'gradé'),
        user('memb', 'membre'),
        user('cher', 'chercheur', { points: 800 }),
        user('attente', 'chercheur', { status: 'pending', points: 0, approvedAt: null })
    ];
    db.logs = [{ id: 'log_dev00001', at: NOW, actor: 'Admin', action: 'Test', detail: 'caché', hidden: true }];
    db.sessions = [];
    return db;
}

/** Première recherche finançable : sans prérequis, non corrompue. */
function openResearch(db) {
    const corruptTiers = new Set(db.tiers.filter((t) => t.corrupted).map((t) => t.id));
    return db.researches.find((r) => !r.requires.length && !r.corrupted && !corruptTiers.has(r.tierId) && r.status !== 'done');
}

const op = (name, args, ids) => ({ op: name, args, ids: ids || [] });

console.log('--- État initial ---');
test('arbre neuf sans comptes ni journal', () => {
    const s = engine.freshState();
    assert.ok(s.tiers.length >= 3 && s.researches.length > 50);
    assert.strictEqual(s.users, undefined);
    assert.strictEqual(s.logs, undefined);
});

console.log('--- Versements (anti double dépense) ---');
test('versement : points débités, recherche créditée, journal', () => {
    const db = baseDb();
    const r = openResearch(db);
    const res = engine.run(db, 'cher', op('Research.contribute', [r.id, 500]));
    assert.strictEqual(res.result.ok, true, JSON.stringify(res.result));
    assert.strictEqual(res.changed, true);
    assert.strictEqual(res.db.users.find((u) => u.id === 'cher').points, 300);
    assert.ok(res.db.researches.find((x) => x.id === r.id).invested > 0);
    assert.strictEqual(res.db.logs[0].action, 'Contribution');
});
test('versement supérieur au solde refusé, rien ne change', () => {
    const db = baseDb();
    const r = openResearch(db);
    const res = engine.run(db, 'cher', op('Research.contribute', [r.id, 801]));
    assert.strictEqual(res.result.ok, false);
    assert.strictEqual(res.changed, false);
    assert.strictEqual(res.db.users.find((u) => u.id === 'cher').points, 800);
});
test('deux versements successifs ne dépensent jamais plus que le solde', () => {
    let db = baseDb();
    const r = openResearch(db);
    const a = engine.run(db, 'cher', op('Research.contribute', [r.id, 500]));
    db = a.db;
    const b = engine.run(db, 'cher', op('Research.contribute', [r.id, 500]));
    assert.strictEqual(b.result.ok, false);
    assert.strictEqual(b.db.users.find((u) => u.id === 'cher').points, 300);
});
test('compte en attente : aucune action', () => {
    const db = baseDb();
    const r = openResearch(db);
    const res = engine.run(db, 'attente', op('Research.contribute', [r.id, 10]));
    assert.strictEqual(res.result.ok, false);
});
test('visiteur anonyme : aucune action', () => {
    const res = engine.run(baseDb(), null, op('Research.contribute', ['x', 10]));
    assert.strictEqual(res.result.ok, false);
});

console.log('--- Droits ---');
test('action hors liste blanche refusée', () => {
    const res = engine.run(baseDb(), 'dev', op('Store.reset', []));
    assert.strictEqual(res.result.error, 'Action inconnue.');
    assert.strictEqual(engine.isOp('Store.reset'), false);
    assert.strictEqual(engine.isOp('Auth.register'), false);
    assert.strictEqual(engine.isOp('Research.contribute'), true);
});
test('chercheur ne peut pas éditer l\'arbre', () => {
    const db = baseDb();
    const res = engine.run(db, 'cher', op('Research.deleteResearch', [db.researches[0].id]));
    assert.strictEqual(res.result.error, 'Accès insuffisant.');
    assert.strictEqual(res.db.researches.length, db.researches.length);
});
test('haut gradé ne peut pas éditer l\'arbre (réservé dev)', () => {
    const db = baseDb();
    const res = engine.run(db, 'chef', op('Research.upsertEvent', [{ name: 'X', type: 'cout', value: -50 }]));
    assert.strictEqual(res.result.ok, false);
});
test('haut gradé : validation d\'une demande (+ PR de base)', () => {
    const res = engine.run(baseDb(), 'chef', op('Accounts.approve', ['attente', 'membre', 'qm']));
    assert.strictEqual(res.result.ok, true, JSON.stringify(res.result));
    const u = res.db.users.find((x) => x.id === 'attente');
    assert.strictEqual(u.status, 'approved');
    assert.strictEqual(u.role, 'membre');
    assert.strictEqual(u.team, 'qm');
    assert.strictEqual(u.points, 300);
    assert.strictEqual(u.approvedBy, 'chef');
});
test('rôle Développeur jamais attribuable', () => {
    const res = engine.run(baseDb(), 'dev', op('Accounts.approve', ['attente', 'admin', 'qm']));
    assert.strictEqual(res.result.ok, false);
});
test('membre ne peut pas valider', () => {
    const res = engine.run(baseDb(), 'memb', op('Accounts.approve', ['attente', 'chercheur', 'qm']));
    assert.strictEqual(res.result.ok, false);
});
test('compte dev intouchable (suspension, suppression)', () => {
    const a = engine.run(baseDb(), 'chef', op('Accounts.toggleSuspend', ['dev']));
    const b = engine.run(baseDb(), 'dev', op('Accounts.remove', ['dev']));
    assert.strictEqual(a.result.ok, false);
    assert.strictEqual(b.result.ok, false);
});
test('haut gradé ne modifie pas un égal', () => {
    const db = baseDb();
    db.users.push(user('chef2', 'gradé'));
    const res = engine.run(db, 'chef', op('Accounts.update', ['chef2', 'chercheur', 'rd']));
    assert.strictEqual(res.result.ok, false);
});
test('suppression de compte par le dev', () => {
    const res = engine.run(baseDb(), 'dev', op('Accounts.remove', ['cher']));
    assert.strictEqual(res.result.ok, true);
    assert.ok(!res.db.users.some((u) => u.id === 'cher'));
});

console.log('--- Données envoyées selon le rôle ---');
test('visiteur : ni comptes, ni journal, textes non publiés masqués', () => {
    const s = engine.run(baseDb(), null, null).snapshot;
    assert.strictEqual(s.users.length, 0);
    assert.strictEqual(s.logs.length, 0);
    const hidden = s.researches.filter((r) => r.name === '██████');
    assert.ok(hidden.length > 0);
    assert.ok(hidden.every((r) => !r.description && !r.report));
});
test('chercheur : compte dev absent, fiches réduites, pas de journal', () => {
    const s = engine.run(baseDb(), 'cher', null).snapshot;
    assert.ok(!s.users.some((u) => u.hidden || u.id === 'dev'));
    assert.ok(!s.users.some((u) => u.id === 'attente'));
    const other = s.users.find((u) => u.id === 'chef');
    assert.strictEqual(other.google, undefined);
    assert.strictEqual(other.discord, undefined);
    assert.strictEqual(s.users.find((u) => u.id === 'cher').google, 'cher@gmail.com');
    assert.strictEqual(s.logs.length, 0);
});
test('haut gradé : coordonnées et demandes visibles, compte dev et ses actions invisibles', () => {
    const s = engine.run(baseDb(), 'chef', null).snapshot;
    assert.ok(!s.users.some((u) => u.id === 'dev'));
    assert.strictEqual(s.users.find((u) => u.id === 'attente').google, 'attente@gmail.com');
    assert.ok(!s.logs.some((l) => l.hidden));
});
test('chercheur : entrées corrompues reçues déjà brouillées, membre : texte intact', () => {
    const db = baseDb();
    const tier = db.tiers.find((t) => t.corrupted);
    assert.ok(tier, 'palier corrompu attendu dans l\'arbre livré');
    const target = db.researches.find((r) => r.tierId === tier.id && (r.description || '').length > 20);
    const cher = engine.run(db, 'cher', null).snapshot.researches.find((r) => r.id === target.id);
    const memb = engine.run(db, 'memb', null).snapshot.researches.find((r) => r.id === target.id);
    assert.notStrictEqual(cher.description, target.description);
    assert.strictEqual(cher.description.length, target.description.length);
    assert.strictEqual(memb.description, target.description);
});
test('dev : tout voir, y compris lui-même', () => {
    const s = engine.run(baseDb(), 'dev', null).snapshot;
    assert.ok(s.users.some((u) => u.id === 'dev'));
    assert.ok(s.logs.some((l) => l.hidden));
});
test('jamais de mot de passe ni de session dans l\'état envoyé', () => {
    const db = baseDb();
    db.users[1].passwordHash = 'abc';
    const s = engine.run(db, 'dev', null).snapshot;
    assert.strictEqual(s.sessions.length, 0);
    const json = JSON.stringify(engine.run(db, 'cher', null).snapshot);
    assert.ok(json.indexOf('passwordHash') < 0);
});

console.log('--- Identifiants rejoués ---');
test('un événement créé garde l\'identifiant fourni par le navigateur', () => {
    const res = engine.run(baseDb(), 'dev', op('Research.upsertEvent',
        [{ name: 'Test', type: 'cout', value: -10, enabled: true }], ['evt_abcd1234']));
    assert.strictEqual(res.result.ok !== false, true, JSON.stringify(res.result));
    assert.ok(res.db.events.some((e) => e.id === 'evt_abcd1234'));
});
test('identifiant au mauvais préfixe ignoré', () => {
    const res = engine.run(baseDb(), 'dev', op('Research.upsertEvent',
        [{ name: 'Test', type: 'cout', value: -10, enabled: true }], ['rch_abcd1234']));
    assert.ok(!res.db.events.some((e) => e.id === 'rch_abcd1234'));
});

console.log('--- Travaux ---');
test('recherche arrivée à terme clôturée par le serveur', () => {
    const db = baseDb();
    const r = openResearch(db);
    r.status = 'running';
    r.startedAt = NOW - 30 * 864e5;
    r.invested = 999999;
    const res = engine.run(db, null, null);
    assert.strictEqual(res.changed, true);
    assert.strictEqual(res.finished, 1);
    assert.ok(res.db.researches.find((x) => x.id === r.id).status !== 'running');
});
test('rien à clôturer : aucune écriture', () => {
    assert.strictEqual(engine.run(baseDb(), 'cher', null).changed, false);
});
test('remise à zéro de l\'arbre : comptes conservés', () => {
    const db = baseDb();
    db.researches = db.researches.slice(0, 3);
    const res = engine.run(db, 'dev', op('Maintenance.reset', []));
    assert.strictEqual(res.result.ok, true);
    assert.ok(res.db.researches.length > 50);
    assert.strictEqual(res.db.users.length, 5);
});

console.log('--- Demande d\'affectation ---');
test('validation d\'une demande correcte', () => {
    const c = engine.validateRequest({ username: 'e.varn', rpName: 'Sgt. Varn', team: 'qm', discord: 'varn', terms: true });
    assert.strictEqual(c.ok, true);
});
test('identifiant réservé et conditions obligatoires', () => {
    assert.strictEqual(engine.validateRequest({ username: 'Admin2', rpName: 'x', team: 'qm', discord: 'xx', terms: true }).ok, false);
    assert.strictEqual(engine.validateRequest({ username: 'e.varn', rpName: 'x', team: 'qm', discord: 'xx', terms: 'true' }).ok, false);
});

console.log('--- Stockage Firestore ---');
test('compte enregistré : champs secondaires conservés, mot de passe local retiré', () => {
    const u = store.cleanUser({
        id: 'a', username: 'u', rpName: 'R', discord: 'd', google: 'e@x.fr', team: 'rd', role: 'chercheur',
        status: 'rejected', hidden: false, points: '12', note: '', createdAt: 5, approvedAt: null,
        approvedBy: null, rejectReason: 'non', passwordHash: 'h'
    });
    assert.strictEqual(u.points, 12);
    assert.strictEqual(u.google, 'e@x.fr');
    assert.strictEqual(u.rejectReason, 'non');
    assert.strictEqual(u.passwordHash, undefined);
});
test('solde négatif et rôle inconnu refusés', () => {
    const base = { id: 'a', username: 'u', role: 'chercheur', status: 'approved', team: 'rd', points: 0 };
    assert.throws(() => store.cleanUser(Object.assign({}, base, { points: -1 })), (e) => e.code === 'negative-points');
    assert.throws(() => store.cleanUser(Object.assign({}, base, { role: 'roi' })));
});
test('doublon d\'identifiant ou d\'adresse détecté (casse ignorée)', () => {
    const users = [{ id: 'a', username: 'Varn', google: 'a@x.fr' }, { id: 'b', username: 'Autre', google: 'b@x.fr' }];
    assert.ok(store.duplicateOf(users, { id: 'c', username: 'varn', google: 'c@x.fr' }));
    assert.ok(store.duplicateOf(users, { id: 'c', username: 'neuf', google: 'A@X.FR' }));
    assert.ok(!store.duplicateOf(users, { id: 'a', username: 'Varn', google: 'a@x.fr' }));
});
test('compression aller-retour', () => {
    const v = { a: [1, [2, 3]], b: 'é' };
    assert.deepStrictEqual(store.decode(store.encode(v)), v);
});

console.log('\n' + passed + ' test(s) réussi(s)' + (process.exitCode ? ', des échecs' : ''));

/* Test d'intégration : vraies Cloud Functions (handlers) + Firestore simulé en mémoire
   (test/fake-firestore.js). Lancé par : npm test */

'use strict';

const path = require('path');
const assert = require('assert');
const FakeFirestore = require('./fake-firestore');

const FN = path.join(__dirname, '..');

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); passed++; console.log('  ok   ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + ((e && e.stack) || e)); }
}

function authOf(uid, email, provider) {
    return { uid, token: { email, email_verified: true, firebase: { sign_in_provider: provider || 'google.com' } } };
}
let reqN = 0;
const rid = () => 'req_it' + (++reqN).toString(36).padStart(4, '0');

(async () => {
    process.env.ADMIN_EMAILS = 'dev@gmail.com';
    const fake = new FakeFirestore();
    const store = require(path.join(FN, 'store.js'));
    store.use(fake);
    const m = require(path.join(FN, 'index.js'));
    const call = (fn, auth, data) => m[fn].run({ auth: auth || undefined, data: data || {}, rawRequest: {} });
    const DEV = authOf('uid_dev', 'dev@gmail.com');
    const A = authOf('uid_a', 'a@gmail.com');
    const B = authOf('uid_b', 'b@gmail.com');

    console.log('--- Firestore (simulé) ---');
    let openId;
    await test('visiteur : état initial généré, aucun dossier', async () => {
        const r = await call('sync', null);
        assert.ok(r.state.researches.length > 50);
        assert.strictEqual(r.state.users.length, 0);
        assert.strictEqual(r.account, null);
        assert.ok(fake.docs.has('division/etat'));
    });
    await test('état stocké compressé, sous la limite de 1 Mo d\'un document', async () => {
        const data = fake.docs.get('division/etat').data;
        assert.ok(Buffer.isBuffer(data));
        assert.ok(data.length < 900 * 1024, data.length + ' octets');
        assert.ok(store.decode(data).researches.length > 50);
    });
    await test('compte dev créé depuis ADMIN_EMAILS, masqué', async () => {
        const r = await call('sync', DEV);
        assert.strictEqual(r.account.role, 'admin');
        assert.ok(r.state.users.some((u) => u.id === 'uid_dev' && u.hidden));
        const again = fake.transactions;
        await call('sync', DEV);
        assert.strictEqual(fake.transactions, again, 'pas de nouvelle écriture pour un compte dev existant');
    });
    await test('demande d\'affectation', async () => {
        const r = await call('register', A, { username: 'e.varn', rpName: 'Sgt. Varn', team: 'rd', discord: 'varn', motivation: 'x', terms: true });
        assert.strictEqual(r.account.status, 'pending');
        assert.strictEqual(r.account.google, 'a@gmail.com');
    });
    await test('seconde demande du même compte refusée', async () => {
        await assert.rejects(call('register', A, { username: 'autre', rpName: 'X', team: 'rd', discord: 'xx', terms: true }), /existe déjà/);
    });
    await test('identifiant déjà pris (casse ignorée)', async () => {
        await assert.rejects(call('register', B, { username: 'E.VARN', rpName: 'X', team: 'rd', discord: 'xx', terms: true }), /déjà pris/);
    });
    await test('connexion autre que Google refusée', async () => {
        await assert.rejects(call('register', authOf('uid_c', 'c@x.fr', 'password'), { username: 'ccc', rpName: 'X', team: 'rd', discord: 'xx', terms: true }), /Google/);
    });
    await test('en attente : pas d\'accès, dossier visible par soi', async () => {
        const r = await call('sync', A);
        assert.strictEqual(r.account.status, 'pending');
        const o = await call('op', A, { op: 'Research.contribute', args: ['x', 10], requestId: rid() });
        assert.strictEqual(o.result.ok, false);
    });
    await test('validation par le dev + attribution de PR', async () => {
        const r = await call('op', DEV, { op: 'Accounts.approve', args: ['uid_a', 'chercheur', 'rd'], requestId: rid() });
        assert.strictEqual(r.result.ok, true, JSON.stringify(r.result));
        const g = await call('op', DEV, { op: 'Research.grantPoints', args: ['uid_a', 700, 'test'], requestId: rid() });
        assert.strictEqual(g.result.ok, true);
        const s = await call('sync', A);
        assert.strictEqual(s.account.status, 'approved');
        assert.strictEqual(s.state.users.find((u) => u.id === 'uid_a').points, 1000);
        const open = s.state.researches.filter((x) => !x.requires.length && x.status !== 'done' && !x.corrupted);
        open.sort((x, y) => y.costPoints - x.costPoints);
        openId = open[0].id;
    });
    await test('10 versements simultanés de 150 PR : jamais plus que le solde', async () => {
        const results = await Promise.all(Array.from({ length: 10 }, () =>
            call('op', A, { op: 'Research.contribute', args: [openId, 150], requestId: rid() })));
        const oks = results.filter((r) => r.result.ok);
        const spent = oks.reduce((a, r) => a + r.result.spent, 0);
        const s = await call('sync', A);
        const pts = s.state.users.find((u) => u.id === 'uid_a').points;
        console.log('       réussis : ' + oks.length + ', dépensé : ' + spent + ', solde : ' + pts);
        assert.ok(pts >= 0);
        assert.strictEqual(pts, 1000 - spent);
    });
    await test('envoi répété (même requestId) appliqué une seule fois', async () => {
        const s0 = await call('sync', A);
        if (s0.state.users.find((u) => u.id === 'uid_a').points < 20) {
            await call('op', DEV, { op: 'Research.grantPoints', args: ['uid_a', 100, ''], requestId: rid() });
        }
        const s1 = await call('sync', A);
        const p1 = s1.state.users.find((u) => u.id === 'uid_a').points;
        const id = rid();
        const r1 = await call('op', A, { op: 'Research.contribute', args: [openId, 10], requestId: id });
        const r2 = await call('op', A, { op: 'Research.contribute', args: [openId, 10], requestId: id });
        assert.strictEqual(r1.result.ok, true, JSON.stringify(r1.result));
        assert.deepStrictEqual(r1.result, r2.result);
        assert.strictEqual(r2.state.users.find((u) => u.id === 'uid_a').points, p1 - r1.result.spent);
    });
    await test('action non autorisée pour un chercheur', async () => {
        const r = await call('op', A, { op: 'Research.deleteResearch', args: [openId], requestId: rid() });
        assert.strictEqual(r.result.error, 'Accès insuffisant.');
    });
    await test('action inconnue rejetée avant la base', async () => {
        await assert.rejects(call('op', A, { op: 'Store.reset', args: [], requestId: rid() }), /Action inconnue/);
    });
    await test('journal : entrées enregistrées, actions dev visibles du seul dev', async () => {
        const r = await call('sync', DEV);
        assert.ok(r.state.logs.length >= 5);
        assert.ok(r.state.logs.some((l) => l.hidden));
        const a = await call('sync', A);
        assert.ok(!(a.state.logs || []).length, 'un chercheur ne reçoit pas le journal');
    });
    await test('clôture planifiée (tick) + purge des vieilles requêtes', async () => {
        fake.docs.set('requetes/uid_a:req_old0001', { compte: 'uid_a', op: 'x', resultat: 'null', at: 0 });
        await call('op', DEV, { op: 'Research.setStatus', args: [openId, 'running'], requestId: rid() });
        await m.tick.run({});
        assert.ok(!fake.docs.has('requetes/uid_a:req_old0001'));
        const s = await call('sync', A);
        assert.ok(s.state.researches.find((x) => x.id === openId));
    });
    await test('identifiants créés par le navigateur conservés en base', async () => {
        const r = await call('op', DEV, { op: 'Research.upsertEvent', args: [{ name: 'Test', type: 'cout', value: -5, enabled: true }], ids: ['evt_itest001'], requestId: rid() });
        assert.ok(r.state.events.some((e) => e.id === 'evt_itest001'));
        const s = await call('sync', DEV);
        assert.ok(s.state.events.some((e) => e.id === 'evt_itest001'));
    });

    console.log('\n' + passed + ' réussi(s), ' + failed + ' échec(s)');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

/* ==========================================================================
   GOC — Division PTOLÉMÉE · Accès Firestore
   Conversion entre les documents Firestore et la base au format du moteur
   ({ settings, tiers, researches, events, announcements, users, logs }).

   Documents :
    division/etat     — état du jeu + comptes, JSON compressé (gzip) : 1 lecture par synchronisation
    division/journal  — 1 000 dernières actions, JSON compressé, lu seulement si nécessaire
    requetes/{uid:id} — requêtes déjà traitées (idempotence), purgées après 7 jours

   Chaque écriture passe par une transaction qui lit `division/etat` : deux actions
   simultanées sont appliquées l'une après l'autre (Firestore rejoue la seconde).
   ========================================================================== */

'use strict';

const zlib = require('zlib');

/** Clés de la base du moteur stockées dans `division/etat` (avec les comptes). */
const STATE_KEYS = ['version', 'createdAt', 'settings', 'tiers', 'researches', 'events', 'announcements'];
const NEVER_STORED = ['passwordHash']; // propre au mode local
const GRADED = ['gradé', 'admin'];
const ROLES = ['chercheur', 'membre', 'gradé', 'admin'];
const STATUSES = ['pending', 'approved', 'rejected', 'suspended'];
const JOURNAL_MAX = 1000;  // entrées conservées
const JOURNAL_SENT = 400;  // entrées transmises au moteur (et donc aux hauts gradés)

let firestore = null;

/** Base Firestore par défaut du projet, initialisée au premier appel. */
function fs() {
    if (!firestore) {
        const { initializeApp, getApps } = require('firebase-admin/app');
        const { getFirestore } = require('firebase-admin/firestore');
        // firebase-functions crée sa propre application (nommée) pour vérifier les jetons :
        // on teste donc la présence de l'application par défaut, pas d'une application quelconque.
        if (!getApps().some((app) => app.name === '[DEFAULT]')) initializeApp();
        firestore = getFirestore();
        firestore.settings({ ignoreUndefinedProperties: true });
    }
    return firestore;
}

/** Remplace la base (tests). */
function use(instance) {
    firestore = instance;
}

const stateRef = () => fs().doc('division/etat');
const journalRef = () => fs().doc('division/journal');
const requestRef = (key) => fs().collection('requetes').doc(key);

/** Lecture dans la transaction `t`, ou lecture simple si `t` est nul. */
const get = (t, ref) => (t ? t.get(ref) : ref.get());

/** Transaction : plusieurs essais en cas d'actions simultanées. */
function tx(fn) {
    return fs().runTransaction(fn, { maxAttempts: 10 });
}

/* --------------------------------------------------------------------------
   Encodage
   -------------------------------------------------------------------------- */

function encode(value) {
    return zlib.gzipSync(Buffer.from(JSON.stringify(value), 'utf8'));
}

function decode(data) {
    if (data === undefined || data === null) return null;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.toUint8Array ? data.toUint8Array() : data);
    return JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
}

function negative(msg) {
    return Object.assign(new Error(msg), { code: 'negative-points' });
}

/** Compte tel qu'enregistré : champs propres au mode local retirés, contraintes vérifiées
 *  (soldes jamais négatifs, rôles, statuts et équipes connus). */
function cleanUser(u) {
    const out = {};
    Object.keys(u).forEach((k) => { if (NEVER_STORED.indexOf(k) < 0 && u[k] !== undefined) out[k] = u[k]; });
    out.points = Math.round(Number(out.points) || 0);
    if (out.points < 0) throw negative('Solde négatif : ' + out.id);
    if (ROLES.indexOf(out.role) < 0) throw new Error('Rôle invalide : ' + out.role);
    if (STATUSES.indexOf(out.status) < 0) throw new Error('Statut invalide : ' + out.status);
    if (out.team !== null && out.team !== undefined && out.team !== 'qm' && out.team !== 'rd') {
        throw new Error('Équipe invalide : ' + out.team);
    }
    return out;
}

/** Un identifiant ou une adresse déjà utilisés par un autre compte (casse ignorée). */
function duplicateOf(users, u) {
    const name = String(u.username || '').toLowerCase();
    const mail = String(u.google || '').toLowerCase();
    return users.find((x) => x.id !== u.id && (
        String(x.username || '').toLowerCase() === name ||
        (mail && String(x.google || '').toLowerCase() === mail)));
}

/* --------------------------------------------------------------------------
   Lecture / écriture de la base complète
   -------------------------------------------------------------------------- */

/** Charge la base au format du moteur. Dans une transaction (`t`), le journal est
 *  toujours lu (il peut recevoir des entrées) ; hors transaction, seulement pour un
 *  haut gradé, seul à pouvoir le lire. Le moteur ne reçoit le journal que pour un
 *  haut gradé, comme avant. */
async function loadDb(t, { uid, freshState }) {
    let snap = await get(t, stateRef());
    let created = false;
    let stored;
    if (snap.exists) {
        stored = decode(snap.get('data'));
    } else if (t) {
        // Premier appel : l'état est créé par l'écriture de fin de transaction.
        stored = Object.assign(freshState(), { users: [] });
        created = true;
    } else {
        try {
            await stateRef().create({ revision: 0, data: encode(Object.assign(freshState(), { users: [] })), updatedAt: Date.now() });
        } catch (err) {
            if (err && err.code !== 6) throw err; // 6 = ALREADY_EXISTS : créé en parallèle
        }
        snap = await stateRef().get();
        stored = decode(snap.get('data'));
    }

    const users = stored.users || [];
    const viewer = users.find((u) => u.id === uid && u.status === 'approved');
    const graded = !!viewer && GRADED.indexOf(viewer.role) >= 0;

    let journal = [];
    if (t || graded) {
        const j = await get(t, journalRef());
        journal = (j.exists && decode(j.get('data'))) || [];
    }
    const logs = graded ? journal.slice(0, JOURNAL_SENT) : [];

    const state = {};
    STATE_KEYS.forEach((k) => { if (stored[k] !== undefined) state[k] = stored[k]; });
    const db = Object.assign(state, { users, logs, sessions: [] });
    return {
        db,
        created,
        revision: snap.exists ? Number(snap.get('revision')) || 0 : 0,
        journal,
        logIds: new Set(journal.map((l) => l.id))
    };
}

/** Enregistre la base renvoyée par le moteur : état, comptes, nouvelles lignes de journal.
 *  À appeler dans la transaction `t` qui a fait le `loadDb`. */
function saveDb(t, ctx, db) {
    const users = (db.users || []).map(cleanUser);
    users.forEach((u) => {
        if (duplicateOf(users, u)) throw Object.assign(new Error('Doublon : ' + u.username), { code: 'duplicate' });
    });

    const state = { users };
    STATE_KEYS.forEach((k) => { if (db[k] !== undefined) state[k] = db[k]; });
    t.set(stateRef(), { revision: ctx.revision + 1, data: encode(state), updatedAt: Date.now() });

    const fresh = (db.logs || []).filter((l) => !ctx.logIds.has(l.id));
    if (fresh.length) {
        const merged = fresh.map((l) => ({
            id: String(l.id), at: Math.round(Number(l.at) || Date.now()), actor: String(l.actor || ''),
            action: String(l.action || ''), detail: String(l.detail || ''), hidden: !!l.hidden
        })).concat(ctx.journal);
        merged.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
        t.set(journalRef(), { data: encode(merged.slice(0, JOURNAL_MAX)), updatedAt: Date.now() });
    }
}

/* --------------------------------------------------------------------------
   Requêtes déjà traitées
   -------------------------------------------------------------------------- */

async function getRequest(t, key) {
    const snap = await t.get(requestRef(key));
    return snap.exists ? { result: JSON.parse(snap.get('resultat')) } : null;
}

function putRequest(t, key, uid, op, result) {
    t.set(requestRef(key), { compte: uid, op, resultat: JSON.stringify(result === undefined ? null : result), at: Date.now() });
}

/** Supprime les requêtes antérieures à `before` (ms). Renvoie le nombre supprimé. */
async function purgeRequests(before) {
    let total = 0;
    for (;;) {
        const snap = await fs().collection('requetes').where('at', '<', before).limit(400).get();
        if (snap.empty) return total;
        const batch = fs().batch();
        snap.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
        total += snap.size;
    }
}

module.exports = {
    use, tx, loadDb, saveDb, getRequest, putRequest, purgeRequests,
    encode, decode, cleanUser, duplicateOf, STATE_KEYS
};

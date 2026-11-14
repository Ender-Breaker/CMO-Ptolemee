/* ==========================================================================
   GOC — Division PTOLÉMÉE · Cloud Functions
    sync     — état officiel filtré selon le rôle (public : visiteurs compris)
    op       — une action de la liste blanche (js/ops.js), rejouée en transaction
    register — demande d'affectation du compte Google connecté
    tick     — toutes les 5 minutes : clôture des travaux, purge des requêtes
   ========================================================================== */

'use strict';

const crypto = require('crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineString } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');

const engine = require('./engine');
const store = require('./store');

setGlobalOptions({ region: 'europe-west1', maxInstances: 10, memory: '512MiB' });

// Pas de valeur par défaut : la CLI la demande au premier déploiement.
const ADMIN_EMAILS = defineString('ADMIN_EMAILS', {
    description: 'Adresses Google du compte dev (invisible), séparées par des virgules'
});

const RUNTIME = {};
const ID_RE = /^[a-z]+_[a-z0-9]{4,24}$/;
const MAX_ARGS_BYTES = 900 * 1024;

const load = (t, uid) => store.loadDb(t, { uid, freshState: engine.freshState });

/** Dossier renvoyé au navigateur pour son propre compte (quel que soit son statut). */
function accountOf(users, uid) {
    const u = uid && (users || []).find((x) => x.id === uid);
    if (!u) return null;
    return {
        id: u.id, username: u.username, rpName: u.rpName, team: u.team, discord: u.discord,
        google: u.google, role: u.role, status: u.status, rejectReason: u.rejectReason || ''
    };
}

/** Les adresses listées dans ADMIN_EMAILS obtiennent le compte dev masqué.
 *  Modifie `users` sur place ; renvoie vrai s'il faut enregistrer. */
function ensureDev(users, auth) {
    const email = auth && auth.token && auth.token.email;
    if (!email || auth.token.email_verified !== true) return false;
    const list = ADMIN_EMAILS.value().split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const i = list.indexOf(email.toLowerCase());
    if (i < 0) return false;
    const u = users.find((x) => x.id === auth.uid);
    if (u) {
        if (u.role === 'admin' && u.hidden === true && u.status === 'approved') return false;
        Object.assign(u, { role: 'admin', hidden: true, status: 'approved' });
        return true;
    }
    const now = Date.now();
    users.push({
        id: auth.uid, username: i ? 'Admin-' + (i + 1) : 'Admin', rpName: 'Console de développement',
        discord: '—', google: email, team: null, role: 'admin', status: 'approved', hidden: true,
        points: 999999, note: '', createdAt: now, approvedAt: now, approvedBy: null
    });
    return true;
}

function fail(err) {
    if (err instanceof HttpsError) throw err;
    logger.error(err);
    if (err && err.code === 'negative-points') throw new HttpsError('failed-precondition', 'Opération refusée : solde de PR insuffisant.');
    if (err && err.code === 'duplicate') throw new HttpsError('already-exists', 'Identifiant ou adresse déjà utilisés.');
    if (err && err.code === 10) throw new HttpsError('aborted', 'Serveur très sollicité, réessayez.');
    throw new HttpsError('internal', 'Erreur serveur.');
}

/* --------------------------------------------------------------------------
   sync
   -------------------------------------------------------------------------- */

exports.sync = onCall(RUNTIME, async (req) => {
    const uid = req.auth ? req.auth.uid : null;
    try {
        // Lecture sans transaction : le cas courant.
        const ctx = await load(null, uid);
        const devMissing = !!req.auth && ensureDev(ctx.db.users.map((u) => Object.assign({}, u)), req.auth);
        let out = engine.run(ctx.db, uid, null);
        // Travaux arrivés à terme ou compte dev à créer : écriture officielle en transaction.
        if (out.changed || devMissing) {
            out = await store.tx(async (t) => {
                const c = await load(t, uid);
                const dev = !!req.auth && ensureDev(c.db.users, req.auth);
                const res = engine.run(c.db, uid, null);
                if (res.changed || dev || c.created) store.saveDb(t, c, res.db);
                return res;
            });
        }
        return { state: out.snapshot, account: accountOf(out.db.users, uid) };
    } catch (err) {
        return fail(err);
    }
});

/* --------------------------------------------------------------------------
   op
   -------------------------------------------------------------------------- */

exports.op = onCall(RUNTIME, async (req) => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Connexion requise.');
    const data = req.data || {};
    const { op, args, ids, requestId } = data;

    if (typeof op !== 'string' || !engine.isOp(op)) throw new HttpsError('invalid-argument', 'Action inconnue.');
    if (!Array.isArray(args) || args.length > 8) throw new HttpsError('invalid-argument', 'Arguments invalides.');
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 5000 || ids.some((x) => typeof x !== 'string' || !ID_RE.test(x)))) {
        throw new HttpsError('invalid-argument', 'Identifiants invalides.');
    }
    if (typeof requestId !== 'string' || !ID_RE.test(requestId)) throw new HttpsError('invalid-argument', 'Requête invalide.');
    if (Buffer.byteLength(JSON.stringify(args)) > MAX_ARGS_BYTES) throw new HttpsError('invalid-argument', 'Données trop volumineuses.');

    const uid = req.auth.uid;
    const key = uid + ':' + requestId;
    try {
        return await store.tx(async (t) => {
            // Toutes les lectures avant la première écriture (règle des transactions Firestore).
            const ctx = await load(t, uid);
            const done = await store.getRequest(t, key);
            const dev = ensureDev(ctx.db.users, req.auth);

            let res;
            let result;
            if (done) {
                // Envoi répété : on renvoie le résultat enregistré sans rejouer l'action.
                res = engine.run(ctx.db, uid, null);
                result = done.result;
            } else {
                res = engine.run(ctx.db, uid, { op, args, ids: ids || [] });
                result = res.result;
            }
            if (res.changed || dev || ctx.created) store.saveDb(t, ctx, res.db);
            if (!done) store.putRequest(t, key, uid, op, result);
            return { result, state: res.snapshot, account: accountOf(res.db.users, uid) };
        });
    } catch (err) {
        return fail(err);
    }
});

/* --------------------------------------------------------------------------
   register
   -------------------------------------------------------------------------- */

exports.register = onCall(RUNTIME, async (req) => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Connectez-vous avec Google.');
    const token = req.auth.token || {};
    if (!token.firebase || token.firebase.sign_in_provider !== 'google.com') {
        throw new HttpsError('permission-denied', 'Seule la connexion Google est acceptée.');
    }
    if (!token.email || token.email_verified !== true) {
        throw new HttpsError('failed-precondition', 'Adresse Google non vérifiée.');
    }
    const check = engine.validateRequest(req.data);
    if (!check.ok) throw new HttpsError('invalid-argument', check.error);
    const c = check.clean;
    const uid = req.auth.uid;
    const lower = (s) => String(s || '').toLowerCase();

    try {
        return await store.tx(async (t) => {
            const ctx = await load(t, uid);
            const users = ctx.db.users;
            if (users.some((u) => u.id === uid)) throw new HttpsError('already-exists', 'Une demande existe déjà pour ce compte Google.');
            if (users.some((u) => lower(u.username) === lower(c.username))) throw new HttpsError('already-exists', 'Cet identifiant est déjà pris.');
            if (users.some((u) => lower(u.google) === lower(token.email))) throw new HttpsError('already-exists', 'Cette adresse Google a déjà un dossier.');

            const now = Date.now();
            const user = {
                id: uid, username: c.username, rpName: c.rpName, discord: c.discord, google: token.email,
                team: c.team, role: 'chercheur', status: 'pending', hidden: false, points: 0,
                note: c.motivation, createdAt: now, approvedAt: null, approvedBy: null
            };
            users.push(user);
            ctx.db.logs = [{
                id: 'log_' + now.toString(36) + crypto.randomBytes(3).toString('hex'),
                at: now,
                actor: c.username,
                action: 'Demande d\'accès',
                detail: c.username + ' (« ' + c.rpName + ' », ' + engine.teamLabel(c.team) + ') a déposé une demande.',
                hidden: false
            }].concat(ctx.db.logs);
            store.saveDb(t, ctx, ctx.db);
            return { account: accountOf([user], uid) };
        });
    } catch (err) {
        return fail(err);
    }
});

/* --------------------------------------------------------------------------
   tick
   -------------------------------------------------------------------------- */

exports.tick = onSchedule({ schedule: 'every 5 minutes', timeZone: 'Europe/Paris' }, async () => {
    await store.tx(async (t) => {
        const ctx = await load(t, null);
        const res = engine.run(ctx.db, null, null);
        if (res.changed || ctx.created) store.saveDb(t, ctx, res.db);
        if (res.changed) logger.info('Travaux clôturés : ' + res.finished);
    });
    await store.purgeRequests(Date.now() - 7 * 864e5);
});

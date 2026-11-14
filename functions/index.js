/* ==========================================================================
   GOC — Division PTOLÉMÉE · Cloud Functions
    sync     — état officiel filtré selon le rôle (public : visiteurs compris)
    op       — une action de la liste blanche (js/ops.js), rejouée sous verrou
    register — demande d'affectation du compte Google connecté
    tick     — toutes les 5 minutes : clôture des travaux, purge des requêtes
   ========================================================================== */

'use strict';

const crypto = require('crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineString, defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');

const engine = require('./engine');
const sql = require('./sql');

setGlobalOptions({ region: 'europe-west1', maxInstances: 10, memory: '512MiB' });

const DB_PASSWORD = defineSecret('DB_PASSWORD');
const SQL_INSTANCE = defineString('SQL_INSTANCE', {
    description: 'Nom de connexion de l\'instance Cloud SQL (projet:région:instance)'
});
const DB_USER = defineString('DB_USER', { default: 'ptolemee' });
const DB_NAME = defineString('DB_NAME', { default: 'ptolemee' });
const DB_HOST = defineString('DB_HOST', {
    default: '',
    description: 'Laisser vide en production. En local : 127.0.0.1 ou 127.0.0.1:5433 (proxy Cloud SQL)'
});
// Pas de valeur par défaut : la CLI la demande au premier déploiement.
const ADMIN_EMAILS = defineString('ADMIN_EMAILS', {
    description: 'Adresses Google du compte dev (invisible), séparées par des virgules'
});

const RUNTIME = { secrets: [DB_PASSWORD] };
const ID_RE = /^[a-z]+_[a-z0-9]{4,24}$/;
const MAX_ARGS_BYTES = 900 * 1024;

function pool() {
    const [host, port] = (DB_HOST.value() || '').split(':');
    return sql.getPool({
        instance: SQL_INSTANCE.value(),
        host: host || null,
        port: port || 5432,
        user: DB_USER.value(),
        password: DB_PASSWORD.value(),
        database: DB_NAME.value()
    });
}

const load = (client, lock, uid) => sql.loadDb(client, { lock, uid, freshState: engine.freshState });

/** Dossier renvoyé au navigateur pour son propre compte (quel que soit son statut). */
function accountOf(users, uid) {
    const u = uid && (users || []).find((x) => x.id === uid);
    if (!u) return null;
    return {
        id: u.id, username: u.username, rpName: u.rpName, team: u.team, discord: u.discord,
        google: u.google, role: u.role, status: u.status, rejectReason: u.rejectReason || ''
    };
}

/** Les adresses listées dans ADMIN_EMAILS obtiennent le compte dev masqué. */
async function ensureDev(client, auth) {
    const email = auth && auth.token && auth.token.email;
    if (!email || auth.token.email_verified !== true) return;
    const list = ADMIN_EMAILS.value().split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const i = list.indexOf(email.toLowerCase());
    if (i < 0) return;
    const now = Date.now();
    await client.query(
        `INSERT INTO comptes (id, username, rp_name, discord, email, team, role, status, hidden, points,
                              note, created_at, approved_at, approved_by)
         VALUES ($1, $2, 'Console de développement', '—', $3, NULL, 'admin', 'approved', TRUE, 999999, '', $4, $4, NULL)
         ON CONFLICT (id) DO UPDATE SET role = 'admin', hidden = TRUE, status = 'approved'
         WHERE comptes.role <> 'admin' OR NOT comptes.hidden OR comptes.status <> 'approved'`,
        [auth.uid, i ? 'Admin-' + (i + 1) : 'Admin', email, now]
    );
}

function fail(err) {
    if (err instanceof HttpsError) throw err;
    logger.error(err);
    if (err && err.code === '23514') throw new HttpsError('failed-precondition', 'Opération refusée : solde de PR insuffisant.');
    if (err && err.code === '23505') throw new HttpsError('already-exists', 'Identifiant ou adresse déjà utilisés.');
    throw new HttpsError('internal', 'Erreur serveur.');
}

/* --------------------------------------------------------------------------
   sync
   -------------------------------------------------------------------------- */

exports.sync = onCall(RUNTIME, async (req) => {
    const uid = req.auth ? req.auth.uid : null;
    try {
        const p = await pool();
        // Lecture sans verrou : le cas courant.
        let out = await sql.withClient(p, async (client) => {
            if (req.auth) await ensureDev(client, req.auth);
            const ctx = await load(client, false, uid);
            return engine.run(ctx.db, uid, null);
        });
        // Des travaux sont arrivés à terme : clôture officielle sous verrou.
        if (out.changed) {
            out = await sql.tx(p, async (client) => {
                const ctx = await load(client, true, uid);
                const res = engine.run(ctx.db, uid, null);
                if (res.changed) await sql.saveDb(client, ctx, res.db);
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
        const p = await pool();
        return await sql.tx(p, async (client) => {
            await ensureDev(client, req.auth);
            const ctx = await load(client, true, uid);
            const done = await client.query('SELECT resultat FROM requetes WHERE id = $1', [key]);

            let res;
            let result;
            if (done.rowCount) {
                // Envoi répété : on renvoie le résultat enregistré sans rejouer l'action.
                res = engine.run(ctx.db, uid, null);
                result = done.rows[0].resultat;
            } else {
                res = engine.run(ctx.db, uid, { op, args, ids: ids || [] });
                result = res.result;
                await client.query(
                    'INSERT INTO requetes (id, compte, op, resultat, at) VALUES ($1, $2, $3, $4::jsonb, $5)',
                    [key, uid, op, JSON.stringify(result), Date.now()]
                );
            }
            if (res.changed) await sql.saveDb(client, ctx, res.db);
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

    try {
        const p = await pool();
        return await sql.tx(p, async (client) => {
            const mine = await client.query('SELECT 1 FROM comptes WHERE id = $1', [uid]);
            if (mine.rowCount) throw new HttpsError('already-exists', 'Une demande existe déjà pour ce compte Google.');
            const taken = await client.query('SELECT 1 FROM comptes WHERE lower(username) = lower($1)', [c.username]);
            if (taken.rowCount) throw new HttpsError('already-exists', 'Cet identifiant est déjà pris.');
            const mail = await client.query('SELECT 1 FROM comptes WHERE lower(email) = lower($1)', [token.email]);
            if (mail.rowCount) throw new HttpsError('already-exists', 'Cette adresse Google a déjà un dossier.');

            const now = Date.now();
            const user = {
                id: uid, username: c.username, rpName: c.rpName, discord: c.discord, google: token.email,
                team: c.team, role: 'chercheur', status: 'pending', hidden: false, points: 0,
                note: c.motivation, createdAt: now, approvedAt: null, approvedBy: null
            };
            await sql.upsertUser(client, user);
            await sql.insertLog(client, {
                id: 'log_' + now.toString(36) + crypto.randomBytes(3).toString('hex'),
                at: now,
                actor: c.username,
                action: 'Demande d\'accès',
                detail: c.username + ' (« ' + c.rpName + ' », ' + engine.teamLabel(c.team) + ') a déposé une demande.',
                hidden: false
            });
            return { account: accountOf([user], uid) };
        });
    } catch (err) {
        return fail(err);
    }
});

/* --------------------------------------------------------------------------
   tick
   -------------------------------------------------------------------------- */

exports.tick = onSchedule({ schedule: 'every 5 minutes', timeZone: 'Europe/Paris', secrets: [DB_PASSWORD] }, async () => {
    const p = await pool();
    await sql.tx(p, async (client) => {
        const ctx = await load(client, true, null);
        const res = engine.run(ctx.db, null, null);
        if (res.changed) {
            await sql.saveDb(client, ctx, res.db);
            logger.info('Travaux clôturés : ' + res.finished);
        }
        await client.query('DELETE FROM requetes WHERE at < $1', [Date.now() - 7 * 864e5]);
        await client.query('DELETE FROM journal WHERE id IN (SELECT id FROM journal ORDER BY at DESC OFFSET 5000)');
    });
});

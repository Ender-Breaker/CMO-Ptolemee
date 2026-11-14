/* ==========================================================================
   GOC — Division PTOLÉMÉE · Accès PostgreSQL (Cloud SQL)
   Conversion entre les tables SQL et la base au format du moteur
   ({ settings, tiers, researches, events, announcements, users, logs }).
   ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

/** Clés de la base du moteur stockées dans la ligne unique `etat`. */
const STATE_KEYS = ['version', 'createdAt', 'settings', 'tiers', 'researches', 'events', 'announcements'];
const USER_KEYS = ['id', 'username', 'rpName', 'discord', 'google', 'team', 'role', 'status', 'hidden',
    'points', 'note', 'createdAt', 'approvedAt', 'approvedBy'];
const NEVER_STORED = ['passwordHash']; // propre au mode local
const GRADED = ['gradé', 'admin'];

let poolPromise = null;

/** Pool de connexions, créé au premier appel. `cfg.host` : connexion directe (proxy Cloud SQL
 *  en local) ; sinon connecteur Cloud SQL avec le nom d'instance « projet:région:instance ». */
function getPool(cfg) {
    if (!poolPromise) {
        poolPromise = (async () => {
            let target;
            if (cfg.host) {
                target = { host: cfg.host, port: Number(cfg.port) || 5432 };
            } else {
                const { Connector, IpAddressTypes } = require('@google-cloud/cloud-sql-connector');
                const connector = new Connector();
                target = await connector.getOptions({
                    instanceConnectionName: cfg.instance,
                    ipType: cfg.privateIp ? IpAddressTypes.PRIVATE : IpAddressTypes.PUBLIC
                });
            }
            const pool = new Pool(Object.assign(target, {
                user: cfg.user,
                password: cfg.password,
                database: cfg.database,
                max: 4,
                idleTimeoutMillis: 30000
            }));
            await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
            return pool;
        })().catch((err) => {
            poolPromise = null;
            throw err;
        });
    }
    return poolPromise;
}

async function withClient(pool, fn) {
    const client = await pool.connect();
    try {
        return await fn(client);
    } finally {
        client.release();
    }
}

async function tx(pool, fn) {
    return withClient(pool, async (client) => {
        await client.query('BEGIN');
        try {
            const out = await fn(client);
            await client.query('COMMIT');
            return out;
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        }
    });
}

/* --------------------------------------------------------------------------
   Conversions
   -------------------------------------------------------------------------- */

function num(v) {
    return v === null || v === undefined ? null : Number(v);
}

function rowToUser(r) {
    return Object.assign({
        id: r.id,
        username: r.username,
        rpName: r.rp_name,
        discord: r.discord,
        google: r.email,
        team: r.team,
        role: r.role,
        status: r.status,
        hidden: r.hidden,
        points: Number(r.points),
        note: r.note,
        createdAt: Number(r.created_at),
        approvedAt: num(r.approved_at),
        approvedBy: r.approved_by
    }, r.extra || {});
}

function rowToLog(r) {
    return { id: r.id, at: Number(r.at), actor: r.actor, action: r.action, detail: r.detail, hidden: r.hidden };
}

async function upsertUser(client, u) {
    const extra = {};
    Object.keys(u).forEach((k) => {
        if (USER_KEYS.indexOf(k) < 0 && NEVER_STORED.indexOf(k) < 0) extra[k] = u[k];
    });
    await client.query(
        `INSERT INTO comptes (id, username, rp_name, discord, email, team, role, status, hidden, points,
                              note, created_at, approved_at, approved_by, extra)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
         ON CONFLICT (id) DO UPDATE SET
             username = EXCLUDED.username, rp_name = EXCLUDED.rp_name, discord = EXCLUDED.discord,
             email = EXCLUDED.email, team = EXCLUDED.team, role = EXCLUDED.role, status = EXCLUDED.status,
             hidden = EXCLUDED.hidden, points = EXCLUDED.points, note = EXCLUDED.note,
             approved_at = EXCLUDED.approved_at, approved_by = EXCLUDED.approved_by, extra = EXCLUDED.extra`,
        [u.id, u.username, u.rpName || '', u.discord || '', u.google || '', u.team || null, u.role, u.status,
            !!u.hidden, Math.round(Number(u.points) || 0), u.note || '', Math.round(Number(u.createdAt) || Date.now()),
            num(u.approvedAt), u.approvedBy || null, JSON.stringify(extra)]
    );
}

async function insertLog(client, l) {
    await client.query(
        'INSERT INTO journal (id, at, actor, action, detail, hidden) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING',
        [l.id, Math.round(Number(l.at) || Date.now()), String(l.actor || ''), String(l.action || ''),
            String(l.detail || ''), !!l.hidden]
    );
}

/* --------------------------------------------------------------------------
   Lecture / écriture de la base complète
   -------------------------------------------------------------------------- */

/** Charge la base au format du moteur. `lock` : verrouille l'état jusqu'à la fin
 *  de la transaction (obligatoire avant toute écriture). Le journal n'est chargé
 *  que pour un haut gradé, seul à pouvoir le lire. */
async function loadDb(client, { lock, uid, freshState }) {
    const select = 'SELECT revision, data FROM etat WHERE id = 1' + (lock ? ' FOR UPDATE' : '');
    let st = await client.query(select);
    if (!st.rowCount) {
        const fresh = freshState();
        await client.query(
            'INSERT INTO etat (id, revision, data, updated_at) VALUES (1, 0, $1::jsonb, $2) ON CONFLICT (id) DO NOTHING',
            [JSON.stringify(fresh), Date.now()]
        );
        st = await client.query(select);
    }

    const users = (await client.query('SELECT * FROM comptes ORDER BY created_at, id')).rows.map(rowToUser);
    const viewer = users.find((u) => u.id === uid && u.status === 'approved');
    const logs = viewer && GRADED.indexOf(viewer.role) >= 0
        ? (await client.query('SELECT * FROM journal ORDER BY at DESC, id DESC LIMIT 400')).rows.map(rowToLog)
        : [];

    const db = Object.assign({}, st.rows[0].data, { users, logs, sessions: [] });
    return {
        db,
        revision: Number(st.rows[0].revision),
        before: new Map(users.map((u) => [u.id, JSON.stringify(u)])),
        logIds: new Set(logs.map((l) => l.id))
    };
}

/** Enregistre la base renvoyée par le moteur : état, comptes modifiés ou supprimés,
 *  nouvelles lignes de journal. À appeler dans la transaction de `loadDb({lock: true})`. */
async function saveDb(client, ctx, db) {
    const state = {};
    STATE_KEYS.forEach((k) => { if (db[k] !== undefined) state[k] = db[k]; });
    await client.query(
        'UPDATE etat SET data = $1::jsonb, revision = revision + 1, updated_at = $2 WHERE id = 1',
        [JSON.stringify(state), Date.now()]
    );

    const seen = new Set();
    for (const u of db.users || []) {
        seen.add(u.id);
        if (ctx.before.get(u.id) !== JSON.stringify(u)) await upsertUser(client, u);
    }
    for (const id of ctx.before.keys()) {
        if (!seen.has(id)) await client.query('DELETE FROM comptes WHERE id = $1', [id]);
    }

    const fresh = (db.logs || []).filter((l) => !ctx.logIds.has(l.id)).reverse();
    for (const l of fresh) await insertLog(client, l);
}

module.exports = { getPool, withClient, tx, loadDb, saveDb, upsertUser, insertLog, rowToUser, STATE_KEYS };

/* ==========================================================================
   GOC — Division PTOLÉMÉE · Actions partagées navigateur / serveur
   Ce fichier est chargé tel quel par les pages ET par les Cloud Functions
   (serveur/engine.js). Il définit :
    - les actions sur les comptes (validation, refus, suspension…) ;
    - la maintenance (restauration, remise à zéro de l'arbre) ;
    - la liste blanche des actions autorisées et le rôle minimal de chacune ;
    - la copie d'état envoyée à chaque visiteur (filtrée selon son rôle) ;
    - l'exécution côté serveur (Ops.server) et le relais côté navigateur (Ops.install).
   ========================================================================== */

(function (global) {
    'use strict';

    var GOC = global.GOC;
    var Store = GOC.Store, Auth = GOC.Auth, ROLES = GOC.ROLES, TEAMS = GOC.TEAMS;

    function fail(message) {
        return { ok: false, error: message };
    }

    function userById(id) {
        return Store.load().users.filter(function (u) { return u.id === id; })[0];
    }

    function levelOf(role) {
        return (ROLES[role] || ROLES.guest).level;
    }

    /** On ne gère que les comptes strictement inférieurs à soi, jamais le compte dev ni soi-même. */
    function manageable(u) {
        var me = Auth.current();
        return !!(u && me && !u.hidden && u.id !== me.id && levelOf(u.role) < Auth.level());
    }

    /** Le rôle « Développeur » n'est jamais attribuable, ni un rôle supérieur au sien. */
    function assignable(role) {
        return !!ROLES[role] && role !== 'guest' && role !== 'admin' && levelOf(role) <= Auth.level();
    }

    /* ----------------------------------------------------------------------
       Comptes
       ---------------------------------------------------------------------- */

    var Accounts = {
        /** Contrôle d'une demande d'affectation (mode Firebase : l'adresse vient de Google). */
        validateRequest: function (data) {
            data = data || {};
            var username = String(data.username || '').trim();
            var rpName = String(data.rpName || '').trim();
            var discord = String(data.discord || '').trim();
            var motivation = String(data.motivation || '').trim();

            if (username.length < 3 || username.length > 24) return fail('L\'identifiant doit contenir entre 3 et 24 caractères.');
            if (!/^[A-Za-z0-9_.-]+$/.test(username)) return fail('Identifiant : lettres, chiffres, - _ . uniquement.');
            if (/^admin/i.test(username)) return fail('Cet identifiant est réservé.');
            if (!rpName || rpName.length > 60) return fail('Le nom RP est obligatoire (60 caractères au plus).');
            if (!TEAMS[data.team]) return fail('Choisissez votre équipe.');
            if (discord.length < 2 || discord.length > 40) return fail('Pseudo Discord invalide.');
            if (motivation.length > 500) return fail('Motivation : 500 caractères au plus.');
            if (data.terms !== true) return fail('Vous devez accepter les conditions d\'utilisation.');

            return {
                ok: true,
                clean: { username: username, rpName: rpName, team: data.team, discord: discord, motivation: motivation }
            };
        },

        approve: function (id, role, team) {
            var me = Auth.current();
            if (!me || !Auth.can('gradé')) return fail('Accès insuffisant.');
            var u = userById(id);
            if (!u || u.hidden) return fail('Compte introuvable.');
            if (u.status !== 'pending') return fail('Cette demande a déjà été traitée.');
            if (!assignable(role)) return fail('Vous ne pouvez pas attribuer un rôle supérieur au vôtre.');

            var db = Store.load();
            u.status = 'approved';
            u.role = role;
            u.team = TEAMS[team] ? team : u.team;
            u.approvedAt = Date.now();
            u.approvedBy = me.hidden ? 'Commandement' : me.username;
            u.points = (u.points || 0) + ((db.settings && db.settings.basePoints) || 0);
            Store.save();
            Store.log('Accès validé', u.username + ' (' + u.rpName + ') → ' + ROLES[role].label + ', ' + GOC.UI.teamLabel(u.team));
            return { ok: true, user: u };
        },

        reject: function (id, reason) {
            if (!Auth.can('gradé')) return fail('Accès insuffisant.');
            var u = userById(id);
            if (!u || u.hidden) return fail('Compte introuvable.');
            if (u.status !== 'pending') return fail('Cette demande a déjà été traitée.');
            u.status = 'rejected';
            u.rejectedAt = Date.now();
            u.rejectReason = String(reason || '').trim().slice(0, 200);
            Store.save();
            Store.log('Demande refusée', u.username + (u.rejectReason ? ' — ' + u.rejectReason : ''));
            return { ok: true };
        },

        update: function (id, role, team) {
            var u = userById(id);
            if (!manageable(u)) return fail('Vous ne pouvez pas modifier ce compte.');
            if (!assignable(role)) return fail('Rôle refusé.');
            u.role = role;
            if (TEAMS[team]) u.team = team;
            Store.save();
            Store.log('Dossier modifié', u.username + ' → ' + ROLES[role].label + ', ' + GOC.UI.teamLabel(u.team));
            return { ok: true };
        },

        toggleSuspend: function (id) {
            var u = userById(id);
            if (!manageable(u)) return fail('Vous ne pouvez pas modifier ce compte.');
            if (u.status !== 'approved' && u.status !== 'suspended') return fail('Ce compte n\'est pas actif.');
            u.status = u.status === 'suspended' ? 'approved' : 'suspended';
            Store.save();
            Store.log('Statut de compte', u.username + ' → ' + u.status);
            return { ok: true, status: u.status };
        },

        remove: function (id) {
            if (!Auth.can('admin')) return fail('Accès insuffisant.');
            var u = userById(id);
            if (!manageable(u)) return fail('Vous ne pouvez pas supprimer ce compte.');
            var db = Store.load();
            db.users = db.users.filter(function (x) { return x.id !== id; });
            Store.save();
            Store.log('Compte supprimé', u.username);
            return { ok: true };
        }
    };

    /* ----------------------------------------------------------------------
       Maintenance (compte dev)
       En mode Firebase, les comptes vivent dans leur propre table : seules les
       données de jeu sont restaurées ou régénérées.
       ---------------------------------------------------------------------- */

    var GAME_KEYS = ['settings', 'tiers', 'researches', 'events', 'announcements'];

    var Maintenance = {
        restore: function (data) {
            if (!data || typeof data !== 'object' || !data.researches || !data.tiers) return fail('Structure inattendue.');
            if (Ops.mode === 'local') {
                if (!data.users) return fail('Structure inattendue.');
                Store.replace(data);
                return { ok: true, full: true };
            }
            var db = Store.load();
            GAME_KEYS.forEach(function (k) { if (data[k]) db[k] = data[k]; });
            if (!db.announcements) db.announcements = [];
            Store.save();
            Store.log('Base restaurée', db.researches.length + ' recherches, ' + db.tiers.length + ' paliers');
            return { ok: true, full: false };
        },

        reset: function () {
            if (Ops.mode === 'local') {
                Store.reset();
                return { ok: true, full: true };
            }
            var db = Store.load();
            var fresh = Store.fresh();
            GAME_KEYS.forEach(function (k) { db[k] = fresh[k]; });
            Store.save();
            Store.log('Arbre réinitialisé', 'Paliers, recherches, directives et annonces régénérés.');
            return { ok: true, full: false };
        }
    };

    /* ----------------------------------------------------------------------
       Liste blanche : action → rôle minimal. Tout le reste est refusé par le serveur.
       ---------------------------------------------------------------------- */

    var OPS = {
        'Research.contribute': 'chercheur',
        'Research.start': 'chercheur',

        'Research.grantPoints': 'gradé',
        'Accounts.approve': 'gradé',
        'Accounts.reject': 'gradé',
        'Accounts.update': 'gradé',
        'Accounts.toggleSuspend': 'gradé',

        'Accounts.remove': 'admin',
        'Research.setTierBox': 'admin',
        'Research.setRepeatScaling': 'admin',
        'Research.setDebuffsEnabled': 'admin',
        'Research.link': 'admin',
        'Research.unlink': 'admin',
        'Research.setRequireCount': 'admin',
        'Research.setPosition': 'admin',
        'Research.upsertTier': 'admin',
        'Research.setTierCorruption': 'admin',
        'Research.deleteTier': 'admin',
        'Research.upsertResearch': 'admin',
        'Research.deleteResearch': 'admin',
        'Research.setStatus': 'admin',
        'Research.resetResearch': 'admin',
        'Research.upsertEvent': 'admin',
        'Research.deleteEvent': 'admin',
        'Research.toggleEvent': 'admin',
        'News.upsert': 'admin',
        'News.remove': 'admin',
        'News.toggle': 'admin',
        'Maintenance.restore': 'admin',
        'Maintenance.reset': 'admin'
    };

    function resolve(name) {
        if (!Object.prototype.hasOwnProperty.call(OPS, name)) return null;
        var parts = name.split('.');
        var owner = GOC[parts[0]];
        if (!owner || typeof owner[parts[1]] !== 'function') return null;
        return { owner: owner, key: parts[1], min: OPS[name] };
    }

    function copy(obj) {
        return JSON.parse(JSON.stringify(obj));
    }

    /** Fiche réduite d'un compte vu par un simple chercheur ou membre. */
    function publicUser(u) {
        return { id: u.id, username: u.username, rpName: u.rpName, team: u.team, role: u.role, status: u.status, points: 0, hidden: false };
    }

    var MAX_TAPE = 5000;
    /** Part de caractères brouillés à la source pour un chercheur (le navigateur en ajoute). */
    var SERVER_VEIL = 0.35;
    var depth = 0;

    var Ops = {
        /** 'local' (prototype), 'remote' (navigateur relié à Firebase) ou 'server' (Cloud Functions). */
        mode: GOC.remote ? 'remote' : 'local',
        LIST: OPS,

        /** Exécute une action de la liste blanche pour le compte courant. */
        exec: function (name, args, ids) {
            var target = resolve(name);
            if (!target) return fail('Action inconnue.');
            if (!Auth.can(target.min)) return fail('Accès insuffisant.');
            if (!(args instanceof Array)) args = [];
            GOC._tape(ids && ids.length ? { mode: 'replay', list: ids.slice(0, MAX_TAPE) } : null);
            var res;
            try {
                res = target.owner[target.key].apply(target.owner, args);
            } finally {
                GOC._tape(null);
            }
            return res === undefined ? { ok: true } : res;
        },

        /** Copie de l'état adaptée au rôle du visiteur. Le compte dev n'apparaît qu'à lui-même,
         *  les coordonnées et le journal ne sortent que vers les hauts gradés. */
        snapshot: function (db, me) {
            var level = me && me.status === 'approved' ? levelOf(me.role) : 0;
            var admin = level >= ROLES.admin.level;
            var grade = level >= ROLES['gradé'].level;
            var out = {};
            Object.keys(db).forEach(function (k) {
                if (k !== 'users' && k !== 'logs' && k !== 'sessions') out[k] = db[k];
            });
            out.sessions = [];
            out.users = (db.users || []).filter(function (u) {
                if (me && u.id === me.id) return true;
                if (!level) return false; // les visiteurs ne voient aucun dossier
                if (u.hidden) return admin;
                return grade || u.status === 'approved';
            }).map(function (u) {
                return grade || (me && u.id === me.id) ? u : publicUser(u);
            });
            out.logs = grade ? (db.logs || []).filter(function (l) { return admin || !l.hidden; }) : [];

            // Les visiteurs anonymes ne reçoivent que le texte des découvertes publiées.
            if (!level && GOC.Research) {
                var R = GOC.Research;
                out.tiers = (db.tiers || []).map(function (t) {
                    if (!t.corrupted) return t;
                    var c = copy(t);
                    c.name = '██████';
                    c.description = '';
                    return c;
                });
                out.researches = (db.researches || []).map(function (r) {
                    if (R.researchVisible(r, 'public')) return r;
                    var c = copy(r);
                    c.name = '██████';
                    c.description = '';
                    c.report = '';
                    c.startedBy = null;
                    return c;
                });
            }

            // Les chercheurs ne reçoivent qu'un texte déjà en partie brouillé des entrées corrompues :
            // le voile du laboratoire ne se lève pas en inspectant la page.
            if (level && level < ROLES.membre.level && GOC.Research) {
                var Rc = GOC.Research, glitch = GOC.UI.glitch;
                out.tiers = (db.tiers || []).map(function (t) {
                    if (!t.corrupted) return t;
                    var c = copy(t);
                    c.name = glitch(c.name, SERVER_VEIL);
                    c.description = glitch(c.description, SERVER_VEIL);
                    return c;
                });
                out.researches = (db.researches || []).map(function (r) {
                    if (!Rc.isCorrupted(r)) return r;
                    var c = copy(r);
                    ['code', 'name', 'description', 'report'].forEach(function (k) { c[k] = glitch(c[k], SERVER_VEIL); });
                    return c;
                });
            }
            return copy(out);
        },

        /** Côté serveur : applique une action ({op, args, ids}, en JSON) à la base reçue en JSON
         *  et renvoie du JSON.
         *  Tout se passe en un seul appel synchrone : aucune autre requête ne peut
         *  s'intercaler dans l'état partagé du moteur. */
        server: function (dbJson, meId, actionJson) {
            // Tout arrive en texte : des objets venus d'un autre contexte JS fausseraient `instanceof`.
            var action = actionJson ? JSON.parse(actionJson) : {};
            Store._db = JSON.parse(dbJson);
            var me = Store._db.users.filter(function (u) { return u.id === meId && u.status === 'approved'; })[0] || null;
            Auth._cache = me;
            try {
                var migrated = Store.migrate(Store._db) === true;
                var finished = GOC.Research.tick();
                var result = action.op ? Ops.exec(action.op, action.args, action.ids) : null;
                var viewer = Auth._cache; // un compte peut perdre son accès pendant l'action
                if (viewer && viewer.status !== 'approved') viewer = null;
                return JSON.stringify({
                    db: Store._db,
                    result: result,
                    changed: migrated || finished.length > 0 || !!(result && result.ok !== false),
                    finished: finished.length,
                    snapshot: Ops.snapshot(Store._db, viewer)
                });
            } finally {
                Store._db = null;
                Auth._cache = undefined;
            }
        },

        /** Côté navigateur (mode Firebase) : chaque action de la liste blanche s'exécute
         *  d'abord localement pour un affichage immédiat, puis part au serveur qui la
         *  rejoue sur l'état officiel. `send(name, args, ids)` gère l'envoi. */
        install: function (send) {
            Object.keys(OPS).forEach(function (name) {
                var target = resolve(name);
                if (!target) return; // module absent de cette page
                var original = target.owner[target.key];
                target.owner[target.key] = function () {
                    var args = Array.prototype.slice.call(arguments);
                    if (depth > 0) return original.apply(target.owner, args);
                    var tape = { mode: 'record', list: [] };
                    depth++;
                    GOC._tape(tape);
                    var res;
                    try {
                        res = original.apply(target.owner, args);
                    } finally {
                        depth--;
                        GOC._tape(null);
                    }
                    if (!(res && res.ok === false)) send(name, copy(args), tape.list);
                    return res;
                };
            });
        }
    };

    GOC.Accounts = Accounts;
    GOC.Maintenance = Maintenance;
    GOC.Ops = Ops;
})(window);

/* ==========================================================================
   GOC — Division PTOLÉMÉE · Moteur de recherche
   Paliers, recherches, prérequis, points de recherche (PR), directives,
   positions dans l'arbre graphique.
   ========================================================================== */

(function (global) {
    'use strict';

    var Store = global.GOC.Store;
    var Auth = global.GOC.Auth;
    var uid = global.GOC.uid;

    /** États possibles d'une recherche :
     *  locked  — prérequis non remplis
     *  funding — ouverte au financement (PR insuffisants)
     *  ready   — financée, en attente de lancement
     *  running — en cours, compte à rebours actif
     *  done    — terminée, rapport consultable
     */
    var STATES = {
        locked:  { label: 'Verrouillée', badge: 'badge-lock' },
        funding: { label: 'Financement', badge: 'badge-warn' },
        ready:   { label: 'Prête',       badge: 'badge-main' },
        running: { label: 'En cours',    badge: 'badge-run' },
        done:    { label: 'Terminée',    badge: 'badge-ok' }
    };

    var EFFECTS = {
        temps: 'durée des recherches',
        cout: 'coût en PR',
        rendement: 'rendement des versements'
    };

    var Research = {
        STATES: STATES,
        EFFECTS: EFFECTS,

        /** Largeur d'une colonne interne de palier dans l'arbre graphique (unités monde). */
        LANE_W: global.GOC.LANE_W,

        /** Taille minimale d'une zone de palier (unités monde). */
        MIN_TIER_W: 160,
        MIN_TIER_H: 240,

        /** Largeur libre si elle a été réglée, sinon nombre de colonnes internes. */
        tierWidth: function (tier) {
            if (tier && Number(tier.width) > 0) return Number(tier.width);
            return Math.max(1, Number(tier && tier.span) || 1) * Research.LANE_W;
        },

        /** Bornes de redimensionnement : une zone ne peut pas rogner ses propres points
         *  (marges comprises pour les étiquettes et le titre du palier). */
        tierLimits: function (tierId) {
            var own = Research.all().filter(function (r) { return r.tierId === tierId; });
            if (!own.length) return { minWidth: Research.MIN_TIER_W, maxTop: null, minBottom: null };
            var maxDx = -Infinity, minY = Infinity, maxY = -Infinity;
            own.forEach(function (r) {
                maxDx = Math.max(maxDx, r.dx || 0);
                minY = Math.min(minY, r.y || 0);
                maxY = Math.max(maxY, r.y || 0);
            });
            return {
                minWidth: Math.max(Research.MIN_TIER_W, Math.ceil((maxDx + 100) / 10) * 10),
                maxTop: minY - 110,
                minBottom: maxY + 90
            };
        },

        /** Redimensionne la zone d'un palier : { width?, top?, bottom? }.
         *  `top` / `bottom` à null rétablissent la hauteur automatique. */
        setTierBox: function (id, box) {
            var tier = Research.tierById(id);
            if (!tier) return fail('Palier introuvable.');
            var lim = Research.tierLimits(id);
            var snap = function (v) { return Math.round(Number(v) / 10) * 10; };

            if (box.width !== undefined) {
                tier.width = Math.min(6000, Math.max(lim.minWidth, snap(box.width) || 0));
                tier.span = Math.max(1, Math.round(tier.width / Research.LANE_W));
            }
            if (box.top !== undefined) {
                if (box.top === null) delete tier.top;
                else tier.top = lim.maxTop == null ? snap(box.top) : Math.min(snap(box.top), lim.maxTop);
            }
            if (box.bottom !== undefined) {
                if (box.bottom === null) delete tier.bottom;
                else tier.bottom = lim.minBottom == null ? snap(box.bottom) : Math.max(snap(box.bottom), lim.minBottom);
            }
            if (tier.top != null && tier.bottom != null && tier.bottom - tier.top < Research.MIN_TIER_H) {
                tier.bottom = tier.top + Research.MIN_TIER_H;
            }
            Store.save();
            Store.log('Palier redimensionné', tier.name + ' — ' + Research.tierWidth(tier) + ' px');
            return { ok: true, tier: tier };
        },

        /** Colonnes de l'arbre, de gauche à droite : [{tier, x, width}]. */
        layout: function () {
            var x = 0;
            return Research.tiers().map(function (t) {
                var col = { tier: t, x: x, width: Research.tierWidth(t) };
                x += col.width;
                return col;
            });
        },

        /** Plancher d'équilibrage appliqué à toute recherche enregistrée. */
        MIN_COST: 500,
        MIN_DURATION: 240,

        all: function () { return Store.load().researches; },

        byId: function (id) {
            return Store.load().researches.filter(function (r) { return r.id === id; })[0] || null;
        },

        tiers: function () {
            return Store.load().tiers.slice().sort(function (a, b) { return a.order - b.order; });
        },

        tierById: function (id) {
            return Store.load().tiers.filter(function (t) { return t.id === id; })[0] || null;
        },

        /** Rang dans la progression : longueur de la plus longue chaîne de prérequis. */
        depth: function (r, seen) {
            seen = seen || {};
            if (seen[r.id]) return 0;
            seen[r.id] = true;
            var d = 0;
            (r.requires || []).forEach(function (id) {
                var dep = Research.byId(id);
                if (dep) d = Math.max(d, Research.depth(dep, seen) + 1);
            });
            delete seen[r.id];
            return d;
        },

        /** Recherches qui exigent `id` comme prérequis. */
        dependents: function (id) {
            return Research.all().filter(function (r) { return (r.requires || []).indexOf(id) >= 0; });
        },

        /* ------------------------------------------------------------------
           Visibilité selon la vue
           mode : 'public' (invités) | 'chercheur' | 'complet' | 'edit'
           ------------------------------------------------------------------ */

        /** Les paliers corrompus n'échappent qu'au registre public : ailleurs, ils sont affichés brouillés. */
        tierVisible: function (tier, mode) {
            if (!tier) return false;
            return mode !== 'public' || !tier.corrupted;
        },

        researchVisible: function (r, mode) {
            if (mode === 'edit') return true;
            if (!Research.tierVisible(Research.tierById(r.tierId), mode)) return false;
            if (mode === 'public') return !r.corrupted && Research.times(r) > 0;
            return true;
        },

        /** Vrai si la recherche ou son palier est corrompu. */
        isCorrupted: function (r) {
            var tier = Research.tierById(r.tierId);
            return !!(r.corrupted || (tier && tier.corrupted));
        },

        /** Part des caractères brouillés pour une entrée corrompue : les archives restent à peine
         *  déchiffrables, le laboratoire presque plus du tout. */
        veilRatio: function (mode) {
            return { complet: 0.45, chercheur: 0.75 }[mode] || 0;
        },

        /** Seuls les membres habilités agissent sur une entrée corrompue. */
        canAccess: function (r) {
            return !Research.isCorrupted(r) || Auth.can('membre');
        },

        /* ------------------------------------------------------------------
           Directives temporaires
           ------------------------------------------------------------------ */

        eventActive: function (e) {
            var now = Date.now();
            if (!e.enabled) return false;
            if (e.startsAt && now < e.startsAt) return false;
            if (e.endsAt && now > e.endsAt) return false;
            return true;
        },

        activeEvents: function () {
            return Store.load().events.filter(Research.eventActive);
        },

        /** Une directive est positive si elle aide les chercheurs :
         *  moins de temps, moins de coût, ou plus de rendement. */
        polarity: function (e) {
            var v = Number(e.value) || 0;
            if (!v) return 'neutre';
            var good = e.type === 'rendement' ? v > 0 : v < 0;
            return good ? 'positif' : 'negatif';
        },

        effectText: function (e) {
            var v = Number(e.value) || 0;
            return (v > 0 ? '+' : '') + v + ' % ' + (EFFECTS[e.type] || e.type);
        },

        /** Multiplicateurs cumulés issus des directives actives. */
        modifiers: function () {
            var mods = { temps: 1, cout: 1, rendement: 1 };
            Research.activeEvents().forEach(function (e) {
                if (mods[e.type] === undefined) return;
                mods[e.type] *= (1 + Number(e.value || 0) / 100);
            });
            Research.activeDebuffs().forEach(function (d) {
                if (mods[d.type] !== undefined) mods[d.type] *= (1 + d.value / 100);
            });
            Object.keys(mods).forEach(function (k) {
                mods[k] = Math.max(0.05, mods[k]);
            });
            return mods;
        },

        /* ------------------------------------------------------------------
           Recherches répétables
           ------------------------------------------------------------------ */

        /** Nombre d'achèvements. Une recherche classique terminée compte pour un. */
        times: function (r) {
            if (typeof r.completions === 'number') return r.completions;
            return r.status === 'done' ? 1 : 0;
        },

        /** Achèvements de `depId` exigés par `r` (1 par défaut). */
        requiredCount: function (r, depId) {
            return Math.max(1, Math.floor(Number((r.requireCounts || {})[depId])) || 1);
        },

        /** Vrai si la recherche pourra encore être relancée après son dernier achèvement. */
        canRepeatAgain: function (r) {
            return !!r.repeatable && (!r.maxRepeats || Research.times(r) < r.maxRepeats);
        },

        /** Interrupteur global de la progression par répétition. */
        scalingEnabled: function () {
            return Store.load().settings.repeatScaling !== false;
        },

        setRepeatScaling: function (enabled) {
            Store.load().settings.repeatScaling = !!enabled;
            Store.save();
            Store.log('Progression par répétition', enabled ? 'activée' : 'désactivée');
            return { ok: true };
        },

        /* ------------------------------------------------------------------
           Malus d'abandon
           ------------------------------------------------------------------ */

        /** Interrupteur global des malus d'abandon. */
        debuffsEnabled: function () {
            return Store.load().settings.debuffs !== false;
        },

        setDebuffsEnabled: function (enabled) {
            Store.load().settings.debuffs = !!enabled;
            Store.save();
            Store.log('Malus d\'abandon', enabled ? 'activés' : 'désactivés');
            return { ok: true };
        },

        /** Recherches de la même famille (elle comprise). Sans famille : la recherche seule. */
        family: function (r) {
            var key = familyKey(r);
            if (!key) return [r];
            return Research.all().filter(function (x) { return x === r || familyKey(x) === key; });
        },

        /** État du malus d'abandon de `r` : null s'il ne peut pas s'appliquer, sinon
         *  { active, startsAt, days, value (en %, positif), type }.
         *  Il se déclenche quand ni la recherche ni sa famille n'a été achevée depuis `graceDays` jours,
         *  vaut `start` % le premier jour, gagne `perDay` % chaque jour suivant, sans dépasser `max` %. */
        debuffState: function (r, now) {
            var d = r.debuff;
            if (!d || !d.enabled || !Research.debuffsEnabled()) return null;
            var members = Research.family(r);
            // On ne pénalise pas l'abandon d'une famille qui ne peut plus être relancée.
            if (!members.some(function (x) { return Research.canRepeatAgain(x); })) return null;
            var last = 0;
            members.forEach(function (x) {
                if (Research.times(x) > 0 && x.completedAt) last = Math.max(last, x.completedAt);
            });
            if (!last) return null; // jamais achevée : rien à délaisser
            now = now || Date.now();
            var startsAt = last + (Number(d.graceDays) || 0) * 864e5;
            if (now < startsAt) return { active: false, last: last, startsAt: startsAt, days: 0, value: 0, type: d.type };
            var days = Math.floor((now - startsAt) / 864e5);
            var value = Math.min(Number(d.max) || 0, (Number(d.start) || 0) + days * (Number(d.perDay) || 0));
            return { active: value > 0, last: last, startsAt: startsAt, days: days, value: value, type: d.type };
        },

        /** Malus actifs, sous forme d'effets signés comme les événements.
         *  Une famille n'en porte qu'un par effet : le plus fort. */
        activeDebuffs: function (now) {
            var byKey = {};
            Research.all().forEach(function (r) {
                if (!r.debuff || !r.debuff.enabled) return;
                var s = Research.debuffState(r, now);
                if (!s || !s.active) return;
                var key = (familyKey(r) ? 'f:' + familyKey(r) : 'r:' + r.id) + ':' + s.type;
                if (byKey[key] && byKey[key].magnitude >= s.value) return;
                byKey[key] = {
                    sourceId: r.id, family: r.group || '', type: s.type,
                    magnitude: s.value, value: s.type === 'rendement' ? -s.value : s.value,
                    days: s.days, startsAt: s.startsAt, last: s.last,
                    name: 'Délaissement — ' + (r.group ? 'famille ' + r.group : r.name)
                };
            });
            return Object.keys(byKey).map(function (k) { return byKey[k]; });
        },

        /** Multiplicateur de progression pour `key` (temps | cout | vitesse) : +x % composé à chaque
         *  répétition déjà effectuée. Neutre si la recherche n'est pas répétable, si sa progression
         *  est coupée ou si l'interrupteur global est désactivé. */
        repeatFactor: function (r, key) {
            var s = r.scaling;
            if (!r.repeatable || !s || !s.enabled || !Research.scalingEnabled()) return 1;
            var pct = Number(s[key]) || 0;
            if (!pct) return 1;
            return Math.max(0.05, Math.min(1000, Math.pow(1 + pct / 100, Research.times(r))));
        },

        effectiveDuration: function (r) {
            return Math.max(1, Math.round(r.durationMinutes * Research.repeatFactor(r, 'temps') * Research.modifiers().temps));
        },

        effectiveCost: function (r) {
            return Math.max(0, Math.round(r.costPoints * Research.repeatFactor(r, 'cout') * Research.modifiers().cout));
        },

        /** Clôt un cycle : compte l'achèvement, accorde le boost et, si la recherche est
         *  répétable, la remet en financement pour la répétition suivante. */
        complete: function (r, now) {
            now = now || Date.now();
            r.completions = Research.times(r) + 1;
            r.completedAt = now;
            var boost = Research.applyBoost(r, now);
            if (Research.canRepeatAgain(r)) {
                r.status = 'idle';
                r.invested = 0;
                r.startedAt = null;
            } else {
                r.status = 'done';
            }
            return boost;
        },

        /** Boost temporaire accordé à l'achèvement, sous forme d'événement lié à la recherche.
         *  Non cumulable (par défaut) : un nouvel achèvement prolonge le boost encore actif. */
        applyBoost: function (r, now) {
            var b = r.boost;
            if (!b || !b.enabled || !EFFECTS[b.type] || !Number(b.value) || !(Number(b.hours) > 0)) return null;
            now = now || Date.now();
            var db = Store.load();
            var endsAt = now + Number(b.hours) * 3600000;
            var current = b.stack ? null : db.events.filter(function (e) {
                return e.sourceId === r.id && e.enabled && (!e.endsAt || e.endsAt >= now);
            })[0];
            if (current) {
                current.type = b.type;
                current.value = Number(b.value);
                current.endsAt = Math.max(current.endsAt || 0, endsAt);
                return current;
            }
            var event = {
                id: uid('evt'), name: 'Boost — ' + r.name, sourceId: r.id,
                description: 'Accordé par l\'achèvement de ' + r.code + '.',
                type: b.type, value: Number(b.value), startsAt: now, endsAt: endsAt, enabled: true, createdAt: now
            };
            db.events.push(event);
            return event;
        },

        /* ------------------------------------------------------------------
           États
           ------------------------------------------------------------------ */

        requirementsMet: function (r) {
            return (r.requires || []).every(function (id) {
                var dep = Research.byId(id);
                return dep && Research.times(dep) >= Research.requiredCount(r, id);
            });
        },

        missingRequirements: function (r) {
            return (r.requires || []).map(Research.byId).filter(function (dep) {
                return dep && Research.times(dep) < Research.requiredCount(r, dep.id);
            });
        },

        state: function (r) {
            if (r.status === 'done') return 'done';
            if (!Research.requirementsMet(r)) return 'locked';
            if (r.status === 'running') return 'running';
            if (r.invested < Research.effectiveCost(r)) return 'funding';
            return 'ready';
        },

        remainingMs: function (r) {
            if (r.status !== 'running' || !r.startedAt) return 0;
            var end = r.startedAt + Research.effectiveDuration(r) * 60000;
            return Math.max(0, end - Date.now());
        },

        timeProgress: function (r) {
            if (r.status === 'done') return 1;
            if (r.status !== 'running' || !r.startedAt) return 0;
            var total = Research.effectiveDuration(r) * 60000;
            return Math.min(1, (Date.now() - r.startedAt) / total);
        },

        /** Avancement affiché sur l'anneau d'un point : financement puis temps. */
        ringProgress: function (r) {
            var state = Research.state(r);
            if (state === 'done' || state === 'ready') return 1;
            if (state === 'running') return Research.timeProgress(r);
            if (state === 'funding') {
                var cost = Research.effectiveCost(r);
                return cost ? Math.min(1, r.invested / cost) : 1;
            }
            return 0;
        },

        /** À appeler périodiquement : clôture les recherches arrivées à terme. */
        tick: function () {
            var db = Store.load();
            var now = Date.now();
            var changed = [];
            db.researches.forEach(function (r) {
                if (r.status === 'running' && Research.remainingMs(r) <= 0) {
                    Research.complete(r, now);
                    changed.push(r);
                }
            });
            // Les boosts expirés depuis plus d'une semaine quittent la liste des événements.
            var before = db.events.length;
            db.events = db.events.filter(function (e) {
                return !e.sourceId || !e.endsAt || e.endsAt > now - 7 * 864e5;
            });
            if (changed.length || db.events.length !== before) {
                Store.save();
                changed.forEach(function (r) {
                    Store.log(r.repeatable ? 'Répétition achevée' : 'Recherche achevée',
                        r.code + ' — ' + r.name + (r.repeatable ? ' (×' + Research.times(r) + ')' : ''), 'système');
                });
            }
            return changed;
        },

        /* ------------------------------------------------------------------
           Actions des agents
           ------------------------------------------------------------------ */

        /** Un agent verse une partie de ses PR dans une recherche.
         *  Le pool est commun : la progression profite à tout le monde. */
        contribute: function (researchId, amount) {
            var user = Auth.current();
            if (!user) return fail('Vous devez être connecté.');
            if (!Auth.can('chercheur')) return fail('Accès insuffisant.');

            var r = Research.byId(researchId);
            if (!r) return fail('Recherche introuvable.');
            if (!Research.canAccess(r)) return fail('Données instables : accès refusé.');
            if (r.status === 'done') return fail('Cette recherche est déjà terminée.');
            if (!Research.requirementsMet(r)) return fail('Les prérequis ne sont pas remplis.');

            amount = Math.floor(Number(amount));
            if (!amount || amount <= 0) return fail('Montant invalide.');
            if (amount > user.points) return fail('Vous n\'avez pas assez de points de recherche.');

            var cost = Research.effectiveCost(r);
            var missing = Math.max(0, cost - r.invested);
            if (missing === 0) return fail('Cette recherche est déjà entièrement financée.');

            var spent = Math.min(amount, missing);
            var credited = Math.round(spent * Research.modifiers().rendement * Research.repeatFactor(r, 'vitesse'));

            user.points -= spent;
            r.invested = Math.min(cost, r.invested + credited);
            Store.save();
            Store.log('Contribution', user.rpName + ' a versé ' + spent + ' PR sur ' + r.code +
                (credited !== spent ? ' (crédité ' + credited + ' PR)' : ''), user.username);

            return { ok: true, spent: spent, credited: credited, funded: r.invested >= cost };
        },

        /** Lance une recherche financée. */
        start: function (researchId) {
            var user = Auth.current();
            if (!user) return fail('Vous devez être connecté.');
            if (!Auth.can('chercheur')) return fail('Accès insuffisant.');

            var r = Research.byId(researchId);
            if (!r) return fail('Recherche introuvable.');
            if (!Research.canAccess(r)) return fail('Données instables : accès refusé.');
            if (Research.state(r) !== 'ready') return fail('Cette recherche ne peut pas être lancée maintenant.');

            r.status = 'running';
            r.startedAt = Date.now();
            r.startedBy = user.hidden ? null : user.rpName;
            Store.save();
            Store.log('Lancement', r.code + ' — ' + r.name + (r.startedBy ? ' lancée par ' + r.startedBy : ''), user.username);
            return { ok: true, research: r };
        },

        /* ------------------------------------------------------------------
           Édition de l'arbre
           ------------------------------------------------------------------ */

        /** Vrai si donner `requires` à `selfId` crée une boucle de dépendances. */
        createsCycle: function (selfId, requires) {
            if (!selfId) return false;
            var seen = {};
            var stack = (requires || []).slice();
            while (stack.length) {
                var id = stack.pop();
                if (id === selfId) return true;
                if (seen[id]) continue;
                seen[id] = true;
                var dep = Research.byId(id);
                if (dep) stack = stack.concat(dep.requires || []);
            }
            return false;
        },

        /** `targetId` exigera désormais `sourceId`. */
        link: function (sourceId, targetId) {
            var target = Research.byId(targetId);
            var source = Research.byId(sourceId);
            if (!target || !source) return fail('Recherche introuvable.');
            if (sourceId === targetId) return fail('Une recherche ne peut pas se requérir elle-même.');
            if ((target.requires || []).indexOf(sourceId) >= 0) return fail('Ce lien existe déjà.');
            var next = (target.requires || []).concat([sourceId]);
            if (Research.createsCycle(targetId, next)) return fail('Lien refusé : il créerait une boucle de prérequis.');
            target.requires = next;
            Store.save();
            Store.log('Prérequis ajouté', source.code + ' → ' + target.code);
            return { ok: true };
        },

        unlink: function (sourceId, targetId) {
            var target = Research.byId(targetId);
            if (!target) return fail('Recherche introuvable.');
            target.requires = (target.requires || []).filter(function (id) { return id !== sourceId; });
            if (target.requireCounts) delete target.requireCounts[sourceId];
            Store.save();
            var source = Research.byId(sourceId);
            Store.log('Prérequis retiré', (source ? source.code : sourceId) + ' → ' + target.code);
            return { ok: true };
        },

        /** Nombre d'achèvements de `sourceId` exigés pour débloquer `targetId`.
         *  Au-delà de 1, la source doit être répétable. */
        setRequireCount: function (sourceId, targetId, count) {
            var target = Research.byId(targetId), source = Research.byId(sourceId);
            if (!target || !source || (target.requires || []).indexOf(sourceId) < 0) return fail('Lien introuvable.');
            count = Math.max(1, Math.min(9999, Math.floor(Number(count)) || 1));
            if (count > 1 && !source.repeatable) return fail('Seule une recherche répétable peut être exigée plusieurs fois.');
            target.requireCounts = target.requireCounts || {};
            if (count > 1) target.requireCounts[sourceId] = count;
            else delete target.requireCounts[sourceId];
            Store.save();
            Store.log('Prérequis ajusté', source.code + ' ×' + count + ' → ' + target.code);
            return { ok: true, count: count };
        },

        /** Place un point : la colonne choisie détermine le palier. */
        setPosition: function (id, tierId, dx, y) {
            var r = Research.byId(id);
            if (!r) return fail('Recherche introuvable.');
            var moved = r.tierId !== tierId;
            r.tierId = tierId;
            r.dx = Math.round(dx);
            r.y = Math.round(y);
            Store.save();
            if (moved) {
                var tier = Research.tierById(tierId);
                Store.log('Recherche déplacée', r.code + ' → ' + (tier ? tier.name : tierId));
            }
            return { ok: true, tierChanged: moved };
        },

        upsertTier: function (data) {
            var db = Store.load();
            var tier = data.id ? Research.tierById(data.id) : null;
            if (!tier) {
                tier = { id: uid('tier'), createdAt: Date.now() };
                db.tiers.push(tier);
            }
            tier.name = data.name;
            tier.description = data.description || '';
            tier.order = Number(data.order) || 0;
            tier.corrupted = !!data.corrupted;
            if (data.width !== undefined && data.width !== '') {
                tier.width = Math.min(6000, Math.max(Research.MIN_TIER_W, Math.round(Number(data.width) / 10) * 10 || 0));
                tier.span = Math.max(1, Math.round(tier.width / Research.LANE_W));
            } else if (data.span !== undefined && data.span !== '') {
                tier.span = Math.max(1, Math.min(12, Math.round(Number(data.span)) || 1));
                delete tier.width;
            } else if (!tier.span) {
                tier.span = 1;
            }
            if (data.autoHeight) {
                delete tier.top;
                delete tier.bottom;
            }

            // Un palier rétréci ne doit pas laisser de points déborder sur son voisin.
            var width = Research.tierWidth(tier);
            db.researches.forEach(function (r) {
                if (r.tierId === tier.id && r.dx > width - 40) r.dx = width - 40;
            });
            Store.save();
            Store.log('Palier enregistré', tier.name);
            return tier;
        },

        /** Corrompt un palier ou purge sa corruption. `withResearches` (par défaut) applique le
         *  même état à ses recherches : sans cela, un palier purgé resterait vide pour les chercheurs. */
        setTierCorruption: function (id, corrupted, withResearches) {
            var tier = Research.tierById(id);
            if (!tier) return fail('Palier introuvable.');
            corrupted = !!corrupted;
            tier.corrupted = corrupted;
            var touched = 0;
            if (withResearches !== false) {
                Store.load().researches.forEach(function (r) {
                    if (r.tierId === id && !!r.corrupted !== corrupted) {
                        r.corrupted = corrupted;
                        touched++;
                    }
                });
            }
            Store.save();
            Store.log(corrupted ? 'Palier corrompu' : 'Corruption purgée',
                tier.name + (touched ? ' (' + touched + ' recherche(s))' : ''));
            return { ok: true, tier: tier, touched: touched };
        },

        deleteTier: function (id) {
            var db = Store.load();
            var used = db.researches.filter(function (r) { return r.tierId === id; });
            if (used.length) return fail('Ce palier contient encore ' + used.length + ' recherche(s).');
            db.tiers = db.tiers.filter(function (t) { return t.id !== id; });
            Store.save();
            Store.log('Palier supprimé', id);
            return { ok: true };
        },

        upsertResearch: function (data) {
            var db = Store.load();
            var r = data.id ? Research.byId(data.id) : null;
            var isNew = !r;
            if (!r) {
                r = {
                    id: uid('rch'), invested: 0, status: 'idle', startedBy: null,
                    startedAt: null, completedAt: null, createdAt: Date.now(),
                    dx: Research.LANE_W / 2, y: 0
                };
                db.researches.push(r);
            }
            r.code = (data.code || '').trim() || r.code || autoCode(db);
            r.name = data.name;
            r.description = data.description || '';
            r.tierId = data.tierId;
            r.type = data.type === 'principale' ? 'principale' : 'secondaire';
            r.branch = data.branch === 'qm' ? 'qm' : 'rd';
            r.icon = data.icon || 'flask';
            r.iconType = data.iconType === 'image' ? 'image' : 'emoji';
            r.durationMinutes = Math.max(Research.MIN_DURATION, Number(data.durationMinutes) || 0);
            r.costPoints = Math.max(Research.MIN_COST, Number(data.costPoints) || 0);
            r.requires = (data.requires || []).filter(function (id) { return id && id !== r.id; });
            r.report = data.report || '';
            r.corrupted = !!data.corrupted;

            // Répétition, progression et boost : champs facultatifs, modifiés seulement s'ils sont fournis.
            if (data.repeatable !== undefined) r.repeatable = !!data.repeatable;
            if (data.maxRepeats !== undefined) r.maxRepeats = Math.max(0, Math.floor(Number(data.maxRepeats)) || 0);
            if (data.completions !== undefined && data.completions !== '') {
                r.completions = Math.max(0, Math.floor(Number(data.completions)) || 0);
            }
            if (data.scaling !== undefined) r.scaling = cleanScaling(data.scaling);
            if (data.boost !== undefined) r.boost = cleanBoost(data.boost);
            if (data.group !== undefined) r.group = String(data.group || '').trim().slice(0, 40);
            if (data.debuff !== undefined) r.debuff = cleanDebuff(data.debuff);
            if (r.status !== 'running') {
                if (!r.repeatable && r.status === 'idle' && Research.times(r) > 0) r.status = 'done';
                if (r.repeatable && r.status === 'done' && Research.canRepeatAgain(r)) {
                    r.status = 'idle';
                    r.invested = 0;
                }
                if (r.repeatable && r.status === 'idle' && Research.times(r) > 0 && !Research.canRepeatAgain(r)) r.status = 'done';
            }

            // Nombre d'achèvements exigés par prérequis (> 1 seulement pour une source répétable).
            var counts = data.requireCounts !== undefined ? (data.requireCounts || {}) : (r.requireCounts || {});
            r.requireCounts = {};
            r.requires.forEach(function (id) {
                var n = Math.floor(Number(counts[id])) || 1;
                var dep = Research.byId(id);
                if (n > 1 && dep && dep.repeatable) r.requireCounts[id] = Math.min(9999, n);
            });

            if (data.invested !== undefined) r.invested = Math.max(0, Number(data.invested) || 0);
            if (data.dx !== undefined) r.dx = Math.round(Number(data.dx));
            if (data.y !== undefined) r.y = Math.round(Number(data.y));
            Store.save();
            Store.log(isNew ? 'Recherche créée' : 'Recherche modifiée', r.code + ' — ' + r.name);
            return r;
        },

        deleteResearch: function (id) {
            var db = Store.load();
            db.researches = db.researches.filter(function (r) { return r.id !== id; });
            db.researches.forEach(function (r) {
                r.requires = (r.requires || []).filter(function (x) { return x !== id; });
                if (r.requireCounts) delete r.requireCounts[id];
            });
            Store.save();
            Store.log('Recherche supprimée', id);
            return { ok: true };
        },

        setStatus: function (id, status) {
            var r = Research.byId(id);
            if (!r) return fail('Recherche introuvable.');
            if (status === 'done') {
                // Pour une recherche répétable, « terminer » compte une répétition de plus.
                if (r.status === 'done') return { ok: true };
                r.invested = Research.effectiveCost(r);
                Research.complete(r, Date.now());
            } else {
                r.status = status;
                if (status === 'idle') {
                    r.startedAt = null;
                    if (!r.repeatable) {
                        r.completedAt = null;
                        r.completions = 0;
                    }
                }
                if (status === 'running') r.startedAt = Date.now();
            }
            Store.save();
            Store.log('Statut forcé', r.code + ' → ' + status);
            return { ok: true };
        },

        resetResearch: function (id) {
            var r = Research.byId(id);
            if (!r) return fail('Recherche introuvable.');
            r.status = 'idle';
            r.invested = 0;
            r.startedAt = null;
            r.completedAt = null;
            r.startedBy = null;
            r.completions = 0;
            Store.save();
            Store.log('Recherche réinitialisée', r.code);
            return { ok: true };
        },

        upsertEvent: function (data) {
            var db = Store.load();
            var e = data.id ? db.events.filter(function (x) { return x.id === data.id; })[0] : null;
            if (!e) {
                e = { id: uid('evt'), createdAt: Date.now() };
                db.events.push(e);
            }
            e.name = data.name;
            e.description = data.description || '';
            e.type = EFFECTS[data.type] ? data.type : 'temps';
            e.value = Number(data.value) || 0;
            e.startsAt = data.startsAt ? new Date(data.startsAt).getTime() : Date.now();
            e.endsAt = data.endsAt ? new Date(data.endsAt).getTime() : null;
            e.enabled = data.enabled !== false;
            Store.save();
            Store.log('Directive enregistrée', e.name + ' (' + Research.effectText(e) + ')');
            return e;
        },

        deleteEvent: function (id) {
            var db = Store.load();
            db.events = db.events.filter(function (e) { return e.id !== id; });
            Store.save();
            Store.log('Directive supprimée', id);
            return { ok: true };
        },

        toggleEvent: function (id) {
            var e = Store.load().events.filter(function (x) { return x.id === id; })[0];
            if (!e) return fail('Directive introuvable.');
            e.enabled = !e.enabled;
            Store.save();
            Store.log('Directive ' + (e.enabled ? 'activée' : 'désactivée'), e.name);
            return { ok: true, enabled: e.enabled };
        },

        /** Attribution de PR : à un compte, à un rôle, à une équipe ou à tous.
         *  Le compte dev n'est jamais inclus dans une attribution collective. */
        grantPoints: function (target, amount, reason) {
            var db = Store.load();
            amount = Math.round(Number(amount) || 0);
            if (!amount) return fail('Montant invalide.');

            var actives = db.users.filter(function (u) { return u.status === 'approved' && !u.hidden; });
            var receivers;
            if (target === '*') {
                receivers = actives;
            } else if (target === 'chercheurs') {
                receivers = actives.filter(function (u) { return u.role === 'chercheur'; });
            } else if (target === 'membres') {
                receivers = actives.filter(function (u) { return u.role !== 'chercheur'; });
            } else if (target === 'team:qm' || target === 'team:rd') {
                var team = target.slice(5);
                receivers = actives.filter(function (u) { return u.team === team; });
            } else {
                receivers = db.users.filter(function (u) { return u.id === target; });
            }
            if (!receivers.length) return fail('Aucun destinataire.');

            receivers.forEach(function (u) {
                u.points = Math.max(0, u.points + amount);
            });
            Store.save();
            Store.log('Attribution de PR',
                (amount > 0 ? '+' : '') + amount + ' PR à ' + receivers.length + ' compte(s)' +
                (reason ? ' — ' + reason : ''));
            return { ok: true, count: receivers.length };
        },

        /* ------------------------------------------------------------------
           Vues
           ------------------------------------------------------------------ */

        /** Renvoie [{tier, researches}] selon la vue demandée. */
        tree: function (mode) {
            var all = Research.all();
            return Research.tiers().filter(function (t) {
                return Research.tierVisible(t, mode);
            }).map(function (t) {
                var list = all.filter(function (r) {
                    return r.tierId === t.id && Research.researchVisible(r, mode);
                }).sort(function (a, b) {
                    // Ordre de progression : prérequis d'abord, puis de haut en bas.
                    var da = Research.depth(a), dz = Research.depth(b);
                    if (da !== dz) return da - dz;
                    if ((a.y || 0) !== (b.y || 0)) return (a.y || 0) - (b.y || 0);
                    return String(a.code).localeCompare(String(b.code));
                });
                return { tier: t, researches: list };
            }).filter(function (group) {
                return mode !== 'public' || group.researches.length > 0;
            });
        },

        /** Statistiques publiques : les entrées altérées ne sont jamais comptées. */
        stats: function () {
            var all = Research.all().filter(function (r) {
                var t = Research.tierById(r.tierId);
                return !r.corrupted && !(t && t.corrupted);
            });
            var done = all.filter(function (r) { return Research.times(r) > 0; });
            var running = all.filter(function (r) { return r.status === 'running'; });
            var pool = all.reduce(function (sum, r) { return sum + (r.invested || 0); }, 0);
            return {
                total: all.length,
                done: done.length,
                running: running.length,
                pool: pool,
                percent: all.length ? Math.round((done.length / all.length) * 100) : 0
            };
        }
    };

    /** Prochain code libre : on repart du plus grand suffixe numérique existant
     *  plutôt que du nombre d'entrées, pour éviter les collisions après une
     *  suppression. */
    function autoCode(db) {
        var max = 0;
        db.researches.forEach(function (r) {
            var m = /(\d+)\s*$/.exec(r.code || '');
            if (m) max = Math.max(max, Number(m[1]));
        });
        return 'PTL-' + String(max + 1).padStart(3, '0');
    }

    function clampPercent(value, lo, hi) {
        value = Number(value);
        return isFinite(value) ? Math.max(lo, Math.min(hi, Math.round(value * 10) / 10)) : 0;
    }

    /** Progression par répétition : pourcentage composé appliqué à chaque répétition effectuée. */
    function cleanScaling(s) {
        s = s || {};
        return {
            enabled: !!s.enabled,
            temps: clampPercent(s.temps, -90, 500),
            cout: clampPercent(s.cout, -90, 500),
            vitesse: clampPercent(s.vitesse, -90, 500)
        };
    }

    /** Boost accordé à l'achèvement (même effets que les événements). */
    function cleanBoost(b) {
        b = b || {};
        return {
            enabled: !!b.enabled,
            type: EFFECTS[b.type] ? b.type : 'cout',
            value: clampPercent(b.value, -90, 500),
            hours: Math.max(0, Math.min(720, Number(b.hours) || 0)),
            stack: !!b.stack
        };
    }

    /** Malus d'abandon : pourcentages positifs, le sens découle de l'effet choisi. */
    function cleanDebuff(d) {
        d = d || {};
        return {
            enabled: !!d.enabled,
            type: EFFECTS[d.type] ? d.type : 'cout',
            graceDays: Math.max(0, Math.min(365, Number(d.graceDays) || 0)),
            start: clampPercent(d.start, 0, 500),
            perDay: clampPercent(d.perDay, 0, 500),
            max: clampPercent(d.max, 0, 500)
        };
    }

    /** Clé de famille, insensible à la casse et aux espaces autour. */
    function familyKey(r) {
        return String((r && r.group) || '').trim().toLowerCase();
    }

    function fail(message) {
        return { ok: false, error: message };
    }

    global.GOC.Research = Research;
})(window);

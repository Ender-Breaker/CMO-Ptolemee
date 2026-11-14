/* ==========================================================================
   GOC — Division PTOLÉMÉE · Console de commandement / développement
   Hauts gradés : demandes, personnel, points, journal.
   Compte dev (admin) : en plus, éditeur graphique, catalogue, paliers,
   événements, annonces et maintenance.
   ========================================================================== */

GOC.ready(function () {
    'use strict';

    var ICONS = window.GOC && window.GOC.Icons;

    var Auth = GOC.Auth, UI = GOC.UI, Store = GOC.Store, R = GOC.Research;
    var ROLES = GOC.ROLES, TEAMS = GOC.TEAMS, News = GOC.News;
    var Accounts = GOC.Accounts, Maintenance = GOC.Maintenance;

    if (!Auth.can('gradé')) return;

    var esc = UI.escape;
    var editorGraph = null;
    var editorSelection = null;

    /* ------------------------------------------------------------------
       Onglets
       ------------------------------------------------------------------ */

    var tabs = document.getElementById('admin-tabs');

    tabs.querySelectorAll('[data-tab]').forEach(function (btn) {
        var name = btn.getAttribute('data-tab');
        if (!Auth.can(btn.getAttribute('data-min'))) {
            btn.remove();
            var panel = document.querySelector('[data-panel="' + name + '"]');
            if (panel) panel.remove();
            return;
        }
        btn.addEventListener('click', function () { show(name); });
    });

    function show(name) {
        tabs.querySelectorAll('[data-tab]').forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-tab') === name);
        });
        document.querySelectorAll('[data-panel]').forEach(function (p) {
            p.hidden = p.getAttribute('data-panel') !== name;
        });
        UI.pref('admin-tab', name);
        if (name === 'arbre') ensureEditor();
        renderAll();
    }

    /* ------------------------------------------------------------------
       Barre de statistiques
       ------------------------------------------------------------------ */

    function renderBar() {
        var host = document.querySelector('[data-bar]');
        if (!host) return;
        var users = Store.load().users.filter(function (u) { return !u.hidden; });
        var s = R.stats();
        var pending = users.filter(function (u) { return u.status === 'pending'; }).length;
        host.innerHTML = [
            ['<b style="color:' + (pending ? 'var(--warn)' : 'var(--frost)') + '">' + pending + '</b>', 'Demandes en attente'],
            [users.filter(function (u) { return u.status === 'approved'; }).length, 'Personnel actif'],
            [s.done + ' / ' + s.total, 'Recherches achevées'],
            [R.activeEvents().length, 'Directives actives'],
            [UI.number(users.reduce(function (a, u) { return a + (u.points || 0); }, 0)), 'PR en circulation']
        ].map(function (c) {
            return '<div class="stat"><span class="val">' + c[0] + '</span><span class="lbl">' + c[1] + '</span></div>';
        }).join('');

        var counter = document.getElementById('tab-count-demandes');
        if (counter) counter.textContent = pending;

        var hdr = document.getElementById('hdr-points');
        var me = Auth.current();
        if (hdr && me) hdr.textContent = UI.number(me.points) + ' PR';
    }

    /* ------------------------------------------------------------------
       Demandes d'accès
       ------------------------------------------------------------------ */

    function renderDemandes() {
        var host = document.getElementById('pane-demandes');
        if (!host) return;
        var pending = Auth.visibleUsers().filter(function (u) { return u.status === 'pending'; });

        if (!pending.length) {
            host.innerHTML = '<div class="panel"><h3>Aucune demande en attente</h3>' +
                '<p>Toutes les candidatures ont été traitées.</p></div>';
            return;
        }

        host.innerHTML = '<div class="grid grid-2">' + pending.map(function (u) {
            return '<article class="panel" data-user="' + u.id + '">' +
                '<span class="badge badge-warn">En attente</span> ' +
                '<span class="badge">' + esc(UI.teamLabel(u.team)) + '</span>' +
                '<h3 style="margin-top:.7rem">' + esc(u.rpName) + '</h3>' +
                '<p class="dim mono">' + esc(u.username) + ' · déposée le ' + UI.date(u.createdAt) + '</p>' +
                '<p style="margin-top:.8rem">🎮 <b>' + esc(u.discord) + '</b><br>' +
                '🔑 <b>' + esc(u.google) + '</b></p>' +
                (u.note ? '<p style="margin-top:.8rem"><i>« ' + esc(u.note) + ' »</i></p>' : '') +
                '<div class="form-row" style="margin-top:1rem">' +
                    '<div class="field"><label>Rôle</label><select data-role>' + roleOptions('chercheur') + '</select></div>' +
                    '<div class="field"><label>Équipe</label><select data-team>' + teamOptions(u.team) + '</select></div>' +
                '</div>' +
                '<div class="rcard-actions">' +
                    '<button class="btn btn-ok btn-sm" type="button" data-approve>Valider l\'accès</button>' +
                    '<button class="btn btn-danger btn-sm" type="button" data-reject>Refuser</button>' +
                '</div></article>';
        }).join('') + '</div>';

        host.querySelectorAll('[data-user]').forEach(function (card) {
            var id = card.getAttribute('data-user');
            card.querySelector('[data-approve]').addEventListener('click', function () {
                approve(id, card.querySelector('[data-role]').value, card.querySelector('[data-team]').value);
            });
            card.querySelector('[data-reject]').addEventListener('click', function () { reject(id); });
        });
    }

    /** Le rôle « Développeur » n'est jamais attribuable. */
    function roleOptions(selected) {
        return Object.keys(ROLES).filter(function (k) {
            return k !== 'guest' && k !== 'admin' && ROLES[k].level <= Auth.level();
        }).map(function (k) {
            return '<option value="' + k + '"' + (k === selected ? ' selected' : '') + '>' + ROLES[k].label + '</option>';
        }).join('');
    }

    function teamOptions(selected) {
        return Object.keys(TEAMS).map(function (k) {
            return '<option value="' + k + '"' + (k === selected ? ' selected' : '') + '>' + TEAMS[k].label + '</option>';
        }).join('');
    }

    function approve(id, role, team) {
        var res = Accounts.approve(id, role, team);
        if (!res.ok) return UI.toast(res.error, 'error');
        UI.toast('Accès accordé à ' + res.user.username + '.', 'ok');
        renderAll();
    }

    function reject(id) {
        var u = userById(id);
        if (!u) return;
        UI.modal('Refuser la demande',
            '<div class="field"><label>Motif (consigné au journal)</label>' +
            '<input type="text" data-motif placeholder="Compte Discord introuvable sur le serveur"></div>' +
            '<button class="btn btn-danger btn-block" type="button" data-confirm>Confirmer le refus</button>',
            function (body, close) {
                body.querySelector('[data-confirm]').addEventListener('click', function () {
                    var res = Accounts.reject(id, body.querySelector('[data-motif]').value);
                    if (!res.ok) return UI.toast(res.error, 'error');
                    close();
                    UI.toast('Demande refusée.');
                    renderAll();
                });
            });
    }

    /* ------------------------------------------------------------------
       Personnel
       ------------------------------------------------------------------ */

    function renderMembres() {
        var host = document.getElementById('pane-membres');
        if (!host) return;
        var me = Auth.current();

        var rows = Auth.visibleUsers().sort(function (a, b) {
            return ROLES[b.role].level - ROLES[a.role].level;
        }).map(function (u) {
            // On ne modifie que les comptes strictement inférieurs à soi.
            var editable = !u.hidden && u.id !== me.id && ROLES[u.role].level < Auth.level();
            return '<tr data-user="' + u.id + '">' +
                '<td><b>' + esc(u.username) + '</b>' +
                    (u.id === me.id ? ' <span class="badge">vous</span>' : '') +
                    (u.hidden ? ' <span class="badge badge-corrupt">dev · invisible</span>' : '') +
                    '<br><span class="dim">' + esc(u.rpName) + '</span></td>' +
                '<td class="mono" style="font-size:.78rem">' + esc(u.discord) + '<br>' + esc(u.google) + '</td>' +
                '<td>' + (editable ? '<select data-role>' + roleOptions(u.role) + '</select>'
                    : '<span class="badge badge-main">' + ROLES[u.role].label + '</span>') + '</td>' +
                '<td>' + (editable ? '<select data-team>' + teamOptions(u.team) + '</select>'
                    : esc(UI.teamLabel(u.team))) + '</td>' +
                '<td>' + statusBadge(u.status) + '</td>' +
                '<td class="mono">' + (u.hidden ? '∞' : UI.number(u.points)) + '</td>' +
                '<td style="white-space:nowrap">' + (editable
                    ? '<button class="btn btn-ghost btn-sm" type="button" data-save>Appliquer</button> ' +
                      '<button class="btn btn-ghost btn-sm" type="button" data-toggle>' +
                      (u.status === 'suspended' ? 'Réactiver' : 'Suspendre') + '</button> ' +
                      (Auth.can('admin') ? '<button class="btn btn-danger btn-sm" type="button" data-del>Supprimer</button>' : '')
                    : '<span class="dim">—</span>') + '</td>' +
                '</tr>';
        }).join('');

        host.innerHTML = '<table><thead><tr><th>Compte</th><th>Liaisons</th><th>Rôle</th><th>Équipe</th>' +
            '<th>Statut</th><th>PR</th><th>Actions</th></tr></thead><tbody>' + rows + '</tbody></table>';

        host.querySelectorAll('[data-user]').forEach(function (tr) {
            var id = tr.getAttribute('data-user');

            var save = tr.querySelector('[data-save]');
            if (save) save.addEventListener('click', function () {
                var res = Accounts.update(id, tr.querySelector('[data-role]').value, tr.querySelector('[data-team]').value);
                if (!res.ok) return UI.toast(res.error, 'error');
                UI.toast('Dossier mis à jour.', 'ok');
                renderAll();
            });

            var toggle = tr.querySelector('[data-toggle]');
            if (toggle) toggle.addEventListener('click', function () {
                var res = Accounts.toggleSuspend(id);
                if (!res.ok) return UI.toast(res.error, 'error');
                renderAll();
            });

            var del = tr.querySelector('[data-del]');
            if (del) del.addEventListener('click', function () {
                var u = userById(id);
                confirmBox('Supprimer le compte « ' + u.username + ' » ?',
                    'La suppression est définitive. Les PR déjà versés dans les recherches restent acquis.',
                    function () {
                        var res = Accounts.remove(id);
                        if (!res.ok) return UI.toast(res.error, 'error');
                        UI.toast('Compte supprimé.');
                        renderAll();
                    });
            });
        });
    }

    function statusBadge(status) {
        var map = {
            approved: ['badge-ok', 'Actif'],
            pending: ['badge-warn', 'En attente'],
            rejected: ['badge-lock', 'Refusé'],
            suspended: ['badge-corrupt', 'Suspendu']
        };
        var m = map[status] || ['badge', status];
        return '<span class="badge ' + m[0] + '">' + m[1] + '</span>';
    }

    function userById(id) {
        return Store.load().users.filter(function (u) { return u.id === id; })[0];
    }

    /* ------------------------------------------------------------------
       Points de recherche
       ------------------------------------------------------------------ */

    function renderPoints() {
        var select = document.getElementById('gp-target');
        if (!select) return;
        var actives = Store.load().users.filter(function (u) { return u.status === 'approved' && !u.hidden; });
        var previous = select.value;

        select.innerHTML =
            '<option value="*">Tout le personnel (' + actives.length + ')</option>' +
            '<option value="team:rd">Équipe Recherche & Développement</option>' +
            '<option value="team:qm">Équipe Quartier-maître</option>' +
            '<option value="chercheurs">Tous les chercheurs</option>' +
            '<option value="membres">Membres et hauts gradés</option>' +
            '<optgroup label="Individuel">' +
            actives.map(function (u) {
                return '<option value="' + u.id + '">' + esc(u.rpName) + ' (' + esc(u.username) + ')</option>';
            }).join('') + '</optgroup>';
        if (previous) select.value = previous;

        document.getElementById('pane-points').innerHTML = actives.length
            ? '<table><thead><tr><th>Nom RP</th><th>Équipe</th><th>Rôle</th><th>Réserve</th><th>Ajustement rapide</th></tr></thead><tbody>' +
                actives.map(function (u) {
                    return '<tr data-u="' + u.id + '"><td>' + esc(u.rpName) + '</td>' +
                        '<td>' + esc(UI.teamLabel(u.team)) + '</td>' +
                        '<td>' + ROLES[u.role].label + '</td>' +
                        '<td class="mono">' + UI.number(u.points) + ' PR</td>' +
                        '<td style="white-space:nowrap">' +
                        '<button class="btn btn-ghost btn-sm" type="button" data-add="500">+500</button> ' +
                        '<button class="btn btn-ghost btn-sm" type="button" data-add="2500">+2 500</button> ' +
                        '<button class="btn btn-ghost btn-sm" type="button" data-add="-500">−500</button></td></tr>';
                }).join('') + '</tbody></table>'
            : '<p class="dim">Aucun personnel actif.</p>';

        document.querySelectorAll('#pane-points [data-u]').forEach(function (tr) {
            tr.querySelectorAll('[data-add]').forEach(function (b) {
                b.addEventListener('click', function () {
                    R.grantPoints(tr.getAttribute('data-u'), Number(b.getAttribute('data-add')), 'Ajustement rapide');
                    renderAll();
                });
            });
        });
    }

    bind('gp-send', function () {
        var res = R.grantPoints(
            document.getElementById('gp-target').value,
            document.getElementById('gp-amount').value,
            document.getElementById('gp-reason').value.trim()
        );
        if (!res.ok) return UI.toast(res.error, 'error');
        UI.toast('PR attribués à ' + res.count + ' compte(s).', 'ok');
        renderAll();
    });

    /* ------------------------------------------------------------------
       Éditeur graphique de l'arbre (dev)
       ------------------------------------------------------------------ */

    function ensureEditor() {
        var host = document.getElementById('editor-graph');
        if (!host || editorGraph) return;
        editorGraph = GOC.Graph.create(host, {
            mode: 'edit',
            onSelect: function (sel) {
                editorSelection = sel;
                renderInspector();
            },
            onChange: function () {
                renderInspector();
                renderRecherches();
                renderPaliers();
            },
            onCreateAt: function (preset) { researchForm(null, preset); },
            onOpen: function (id) { researchForm(R.byId(id)); },
            onOpenTier: function (tierId) { tierForm(R.tierById(tierId)); }
        });
    }

    function renderArbre() {
        if (!editorGraph) return;
        if (editorSelection && editorSelection.type === 'node' && !R.byId(editorSelection.id)) editorSelection = null;
        editorGraph.render();
        renderInspector();
    }

    function renderInspector() {
        var host = document.getElementById('editor-inspector');
        if (!host) return;
        var sel = editorSelection;

        if (sel && sel.type === 'edge') {
            var from = R.byId(sel.from), to = R.byId(sel.to);
            if (!from || !to) { editorSelection = null; return renderInspector(); }
            host.innerHTML =
                '<span class="eyebrow">Lien de prérequis</span>' +
                '<h3 style="margin:.4rem 0 .8rem">' + esc(from.code) + ' → ' + esc(to.code) + '</h3>' +
                '<p class="muted" style="font-size:.88rem"><b>' + esc(to.name) + '</b> exige que <b>' +
                    esc(from.name) + '</b> soit achevée.</p>' +
                (from.repeatable
                    ? '<div class="field" style="margin-top:1rem"><label>Achèvements exigés</label>' +
                        '<div style="display:flex; gap:.4rem"><input type="number" min="1" max="9999" data-edge-count value="' +
                            R.requiredCount(to, from.id) + '">' +
                        '<button class="btn btn-sm" type="button" data-edge-count-save>Appliquer</button></div>' +
                        '<span class="hint">' + esc(from.code) + ' a été achevée ' + R.times(from) + ' fois.</span></div>'
                    : '<p class="dim" style="font-size:.8rem; margin-top:.8rem">Rendez ' + esc(from.code) +
                        ' répétable pour exiger plusieurs achèvements.</p>') +
                '<div class="rcard-actions" style="margin-top:1.2rem">' +
                    '<button class="btn btn-danger btn-sm" type="button" data-unlink-sel>Supprimer le lien</button></div>';
            host.querySelector('[data-unlink-sel]').addEventListener('click', function () {
                editorGraph.unlinkSelected();
            });
            var countSave = host.querySelector('[data-edge-count-save]');
            if (countSave) countSave.addEventListener('click', function () {
                var res = R.setRequireCount(from.id, to.id, host.querySelector('[data-edge-count]').value);
                if (!res.ok) return UI.toast(res.error, 'error');
                UI.toast('Prérequis : ' + from.code + ' ×' + res.count + '.', 'ok');
                renderAll();
            });
            return;
        }

        var r = sel && sel.type === 'node' ? R.byId(sel.id) : null;
        if (!r) {
            host.innerHTML =
                '<span class="eyebrow">Éditeur</span>' +
                '<h3 style="margin:.4rem 0 .8rem">Mode d\'emploi</h3>' +
                '<ul class="help-list">' +
                    '<li><b>Double-clic</b> dans une colonne vide : créer une recherche à cet endroit.</li>' +
                    '<li><b>Glisser</b> un point : le déplacer. Le poser dans une autre colonne change son palier.</li>' +
                    '<li><b>Tirer</b> depuis le petit cercle ● à droite d\'un point jusqu\'à un autre : ce dernier exigera le premier.</li>' +
                    '<li><b>Cliquer un lien</b> puis <kbd>Suppr</kbd> : retirer le prérequis.</li>' +
                    '<li><b>Double-clic</b> sur un point : fiche complète.</li>' +
                    '<li><b>Tirer le bord</b> droit, haut ou bas d\'une zone de palier : l\'agrandir ou la rétrécir. ' +
                        'Double-clic sur un bord : ajuster au contenu.</li>' +
                    '<li><b>Double-clic</b> sur le titre d\'un palier : modifier le palier.</li>' +
                    '<li><b>Molette</b> : zoom · <b>glisser le fond</b> : se déplacer.</li>' +
                '</ul>' +
                '<p class="dim" style="margin-top:1rem">Hexagone = principale · cercle = secondaire.</p>';
            return;
        }

        var tier = R.tierById(r.tierId);
        var state = R.state(r);
        var cost = R.effectiveCost(r);
        var reqs = (r.requires || []).map(R.byId).filter(Boolean);
        var deps = R.dependents(r.id);

        host.innerHTML =
            '<div class="detail-head">' +
                '<div class="rcard-icon detail-icon">' + UI.iconHTML(r) + '</div>' +
                '<div><span class="mono dim" style="font-size:.72rem">' + esc(r.code) + '</span>' +
                '<h3>' + esc(r.name) + '</h3></div>' +
            '</div>' +
            '<div class="tags">' +
                '<span class="badge ' + R.STATES[state].badge + '">' + R.STATES[state].label + '</span>' +
                (r.type === 'principale' ? '<span class="badge badge-main">Principale</span>' : '<span class="badge">Secondaire</span>') +
                '<span class="badge">' + (TEAMS[r.branch] ? TEAMS[r.branch].short : 'R&D') + '</span>' +
                (r.corrupted ? '<span class="badge badge-corrupt">Corrompue</span>' : '') +
            '</div>' +
            '<dl class="facts">' +
                '<dt>Palier</dt><dd>' + esc(tier ? tier.name : '—') + '</dd>' +
                '<dt>Durée</dt><dd>' + UI.duration(r.durationMinutes) + '</dd>' +
                '<dt>Coût</dt><dd>' + UI.number(r.costPoints) + ' PR' +
                    (cost !== r.costPoints ? ' <span class="dim">(effectif ' + UI.number(cost) + ')</span>' : '') + '</dd>' +
                '<dt>Financé</dt><dd>' + UI.number(r.invested) + ' PR</dd>' +
                (r.repeatable ? '<dt>Répétitions</dt><dd>↻ ' + R.times(r) + (r.maxRepeats ? ' / ' + r.maxRepeats : '') + '</dd>' : '') +
                (function () {
                    var ds = R.debuffState(r);
                    if (!ds) return '';
                    return '<dt>Malus</dt><dd' + (ds.active ? ' class="warn-text">Actif : ' + esc(debuffEffect(ds.type, ds.value))
                        : '>Dès le ' + UI.date(ds.startsAt)) + '</dd>';
                })() +
                '<dt>Position</dt><dd class="mono">x ' + r.dx + ' · y ' + r.y + '</dd>' +
            '</dl>' +
            (tier ? '<div class="detail-section"><h4>Zone du palier</h4><div class="rcard-actions">' +
                '<button class="btn btn-ghost btn-sm" type="button" data-widen="-1" aria-label="Rétrécir">−</button>' +
                '<span class="mono">' + R.tierWidth(tier) + ' px</span>' +
                '<button class="btn btn-ghost btn-sm" type="button" data-widen="1" aria-label="Élargir">＋</button>' +
                (tier.top != null || tier.bottom != null
                    ? '<button class="btn btn-ghost btn-sm" type="button" data-autoh>Hauteur auto</button>' : '') +
                '<button class="btn btn-ghost btn-sm" type="button" data-tier-edit>Palier…</button>' +
                '<button class="btn btn-ghost btn-sm" type="button" data-tier-corrupt>' +
                    (tier.corrupted ? '✦ Purger' : '☣ Corrompre') + '</button>' +
                '</div></div>' : '') +
            '<div class="detail-section"><h4>Prérequis</h4>' +
                (reqs.length ? '<div class="chip-list">' + reqs.map(function (d) {
                    var need = R.requiredCount(r, d.id);
                    return '<span class="chip">' + esc(d.code) + (need > 1 ? ' ×' + need : '') +
                        ' <button type="button" class="chip-x" data-unlink="' + d.id + '" aria-label="Retirer">✕</button></span>';
                }).join('') + '</div>' : '<p class="dim">Aucun — tirez un lien depuis un autre point.</p>') +
            '</div>' +
            '<div class="detail-section"><h4>Débloque</h4>' +
                (deps.length ? '<div class="chip-list">' + deps.map(function (d) {
                    return '<button type="button" class="chip" data-goto="' + d.id + '">' + esc(d.code) + '</button>';
                }).join('') + '</div>' : '<p class="dim">Rien pour l\'instant.</p>') +
            '</div>' +
            '<div class="detail-section rcard-actions">' +
                '<button class="btn btn-sm" type="button" data-edit>Éditer la fiche</button>' +
                '<button class="btn btn-ghost btn-sm" type="button" data-state>Statut</button>' +
                '<button class="btn btn-ghost btn-sm" type="button" data-dup>Dupliquer</button>' +
                '<button class="btn btn-danger btn-sm" type="button" data-del>Supprimer</button>' +
            '</div>';

        host.querySelector('[data-edit]').addEventListener('click', function () { researchForm(r); });
        host.querySelector('[data-state]').addEventListener('click', function () { statusForm(r); });
        host.querySelectorAll('[data-widen]').forEach(function (b) {
            b.addEventListener('click', function () {
                var step = Number(b.getAttribute('data-widen'));
                var before = R.tierWidth(tier);
                R.setTierBox(tier.id, { width: before + step * R.LANE_W });
                if (step < 0 && R.tierWidth(tier) === before) {
                    UI.toast('Impossible de rétrécir davantage : des recherches occupent la zone.', 'error');
                }
                renderAll();
            });
        });
        var autoHeight = host.querySelector('[data-autoh]');
        if (autoHeight) autoHeight.addEventListener('click', function () {
            R.setTierBox(tier.id, { top: null, bottom: null });
            renderAll();
        });
        var editTier = host.querySelector('[data-tier-edit]');
        if (editTier) editTier.addEventListener('click', function () { tierForm(tier); });
        var corruptTier = host.querySelector('[data-tier-corrupt]');
        if (corruptTier) corruptTier.addEventListener('click', function () { corruptionForm(tier); });
        host.querySelector('[data-dup]').addEventListener('click', function () {
            var copy = R.upsertResearch({
                code: '', name: r.name + ' (copie)', description: r.description, tierId: r.tierId,
                type: r.type, branch: r.branch, icon: r.icon, iconType: r.iconType,
                durationMinutes: r.durationMinutes, costPoints: r.costPoints,
                requires: (r.requires || []).slice(), report: r.report, corrupted: r.corrupted,
                dx: r.dx, y: (r.y || 0) + 120
            });
            UI.toast('Copie créée : ' + copy.code, 'ok');
            editorSelection = { type: 'node', id: copy.id };
            renderAll();
            editorGraph.select(copy.id);
        });
        host.querySelector('[data-del]').addEventListener('click', function () {
            confirmBox('Supprimer « ' + r.name + ' » ?',
                'La recherche sera retirée de tous les prérequis qui la citent.',
                function () {
                    R.deleteResearch(r.id);
                    editorSelection = null;
                    UI.toast('Recherche supprimée.');
                    renderAll();
                });
        });
        host.querySelectorAll('[data-unlink]').forEach(function (b) {
            b.addEventListener('click', function () {
                R.unlink(b.getAttribute('data-unlink'), r.id);
                renderAll();
            });
        });
        host.querySelectorAll('[data-goto]').forEach(function (b) {
            b.addEventListener('click', function () {
                var id = b.getAttribute('data-goto');
                editorGraph.select(id);
                editorGraph.focusOn(id);
            });
        });
    }

    bind('ed-new-research', function () {
        if (!R.tiers().length) return UI.toast('Créez d\'abord un palier.', 'error');
        researchForm(null, editorGraph ? editorGraph.center() : null);
    });
    bind('ed-new-tier', function () { tierForm(null); });
    bind('ed-fit', function () { if (editorGraph) editorGraph.fit(); });

    /* ------------------------------------------------------------------
       Catalogue (vue tableau)
       ------------------------------------------------------------------ */

    var tierFilter = 'tous';

    function renderRecherches() {
        var host = document.getElementById('pane-recherches');
        if (!host) return;

        var select = document.getElementById('adm-filter-tier');
        select.innerHTML = '<option value="tous">Tous les paliers</option>' +
            R.tiers().map(function (t) {
                return '<option value="' + t.id + '"' + (t.id === tierFilter ? ' selected' : '') + '>' + esc(t.name) + '</option>';
            }).join('');
        select.onchange = function () { tierFilter = select.value; renderRecherches(); };

        var list = R.all().filter(function (r) {
            return tierFilter === 'tous' || r.tierId === tierFilter;
        }).sort(function (a, b) {
            var ta = R.tierById(a.tierId), tb = R.tierById(b.tierId);
            var oa = ta ? ta.order : 99, ob = tb ? tb.order : 99;
            if (oa !== ob) return oa - ob;
            return String(a.code).localeCompare(String(b.code));
        });

        host.innerHTML = '<table><thead><tr><th></th><th>Code / Nom</th><th>Palier</th><th>Type</th><th>Équipe</th>' +
            '<th>Durée</th><th>Coût</th><th>Financé</th><th>Prérequis</th><th>État</th><th>Actions</th></tr></thead><tbody>' +
            list.map(function (r) {
                var state = R.state(r);
                return '<tr data-r="' + r.id + '">' +
                    '<td><span class="rcard-icon" style="width:32px;height:32px;flex:0 0 32px;font-size:1rem">' + UI.iconHTML(r) + '</span></td>' +
                    '<td><b>' + esc(r.name) + '</b>' + (r.corrupted ? ' <span class="badge badge-corrupt">corrompue</span>' : '') +
                        '<br><span class="dim mono">' + esc(r.code) + '</span></td>' +
                    '<td>' + esc((R.tierById(r.tierId) || {}).name || '—') + '</td>' +
                    '<td>' + (r.type === 'principale' ? '<span class="badge badge-main">Principale</span>' : '<span class="badge">Secondaire</span>') + '</td>' +
                    '<td>' + (TEAMS[r.branch] ? TEAMS[r.branch].short : 'R&D') + '</td>' +
                    '<td class="mono">' + UI.duration(r.durationMinutes) + '</td>' +
                    '<td class="mono">' + UI.number(r.costPoints) + '</td>' +
                    '<td class="mono">' + UI.number(r.invested) + '</td>' +
                    '<td class="mono dim">' + (r.requires || []).map(function (id) {
                        var d = R.byId(id); return d ? esc(d.code) : '?';
                    }).join(', ') + '</td>' +
                    '<td><span class="badge ' + R.STATES[state].badge + '">' + R.STATES[state].label + '</span></td>' +
                    '<td style="white-space:nowrap">' +
                        '<button class="btn btn-ghost btn-sm" type="button" data-edit>Éditer</button> ' +
                        '<button class="btn btn-ghost btn-sm" type="button" data-state>Statut</button> ' +
                        '<button class="btn btn-danger btn-sm" type="button" data-del>✕</button></td>' +
                    '</tr>';
            }).join('') + '</tbody></table>';

        host.querySelectorAll('[data-r]').forEach(function (tr) {
            var id = tr.getAttribute('data-r');
            tr.querySelector('[data-edit]').addEventListener('click', function () { researchForm(R.byId(id)); });
            tr.querySelector('[data-state]').addEventListener('click', function () { statusForm(R.byId(id)); });
            tr.querySelector('[data-del]').addEventListener('click', function () {
                var r = R.byId(id);
                confirmBox('Supprimer « ' + r.name + ' » ?',
                    'La recherche sera retirée de tous les prérequis qui la citent.',
                    function () {
                        R.deleteResearch(id);
                        UI.toast('Recherche supprimée.');
                        renderAll();
                    });
            });
        });
    }

    function researchForm(r, preset) {
        var isNew = !r;
        preset = preset || {};
        r = r || {
            code: '', name: '', description: '', tierId: preset.tierId || (R.tiers()[0] || {}).id,
            type: 'secondaire', branch: 'rd', icon: 'flask', iconType: 'emoji',
            durationMinutes: 1440, costPoints: 5000, invested: 0,
            requires: [], report: '', corrupted: false,
            repeatable: false, maxRepeats: 0,
            scaling: { enabled: false, temps: 0, cout: 0, vitesse: 0 },
            boost: { enabled: false, type: 'cout', value: -5, hours: 12, stack: false },
            group: '',
            debuff: { enabled: false, type: 'cout', graceDays: 14, start: 1, perDay: 1, max: 20 }
        };

        var dur = splitDuration(r.durationMinutes);

        var body =
            '<div class="form-row">' +
                '<div class="field"><label>Code</label><input type="text" data-code value="' + esc(r.code) +
                    '" placeholder="PTL-042"><span class="hint">Laisser vide pour générer.</span></div>' +
                '<div class="field"><label>Palier</label><select data-tier>' +
                    R.tiers().map(function (t) {
                        return '<option value="' + t.id + '"' + (t.id === r.tierId ? ' selected' : '') + '>' +
                            esc(t.name) + (t.corrupted ? ' (corrompu)' : '') + '</option>';
                    }).join('') + '</select></div>' +
            '</div>' +

            '<div class="field"><label>Nom de la recherche</label>' +
                '<input type="text" data-name value="' + esc(r.name) + '" placeholder="Blindage composite Mk.II"></div>' +

            '<div class="field"><label>Description</label>' +
                '<textarea data-desc placeholder="Ce que la recherche vise à produire…">' + esc(r.description) + '</textarea></div>' +

            '<div class="form-row">' +
                '<div class="field"><label>Type</label><select data-type>' +
                    '<option value="principale"' + (r.type === 'principale' ? ' selected' : '') + '>Principale (hexagone)</option>' +
                    '<option value="secondaire"' + (r.type === 'secondaire' ? ' selected' : '') + '>Secondaire (cercle)</option>' +
                '</select></div>' +
                '<div class="field"><label>Équipe</label><select data-branch>' + teamOptions(r.branch || 'rd') + '</select></div>' +
            '</div>' +

            '<div class="field"><label>Icône</label><select data-icontype>' +
                '<option value="emoji"' + (r.iconType === 'emoji' ? ' selected' : '') + '>Preset du jeu d\'icônes</option>' +
                '<option value="image"' + (r.iconType === 'image' ? ' selected' : '') + '>Image (URL)</option>' +
            '</select></div>' +

            '<div class="field" data-icon-preset' + (r.iconType === 'image' ? ' hidden' : '') + '>' +
                '<label>Preset — rangés par type</label>' +
                (ICONS ? ICONS.pickerHTML(r.icon) : '') +
                '<span class="hint">Trait fin, monochrome : l\'icône suit la couleur de l\'état sur la carte et sur le point de l\'arbre.</span>' +
            '</div>' +

            '<div class="field" data-icon-url' + (r.iconType === 'image' ? '' : ' hidden') + '>' +
                '<label>URL de l\'image</label>' +
                '<input type="text" data-icon value="' + esc(r.iconType === 'image' ? r.icon : (ICONS ? ICONS.keyFor(r.icon) : r.icon)) +
                    '" placeholder="https://…/icone.png"></div>' +

            '<div class="form-row">' +
                '<div class="field"><label>Durée</label>' +
                    '<div style="display:flex; gap:.4rem">' +
                        '<input type="number" min="1" data-dur value="' + dur.value + '">' +
                        '<select data-durunit style="max-width:110px">' +
                            '<option value="1"' + (dur.unit === 1 ? ' selected' : '') + '>minutes</option>' +
                            '<option value="60"' + (dur.unit === 60 ? ' selected' : '') + '>heures</option>' +
                            '<option value="1440"' + (dur.unit === 1440 ? ' selected' : '') + '>jours</option>' +
                        '</select></div></div>' +
                '<div class="field"><label>Coût en PR</label>' +
                    '<input type="number" min="' + R.MIN_COST + '" step="500" data-cost value="' + Number(r.costPoints) + '"></div>' +
            '</div>' +
            '<p class="hint" style="margin:-.4rem 0 1rem">Minimum : ' + UI.duration(R.MIN_DURATION) + ' et ' +
                UI.number(R.MIN_COST) + ' PR. Repère : le palier III plafonne à 3 j et 40 000 PR.</p>' +

            (isNew ? '' :
                '<div class="field"><label>PR déjà versés</label>' +
                '<input type="number" min="0" data-invested value="' + Number(r.invested) + '">' +
                '<span class="hint">Correction manuelle de la cagnotte commune.</span></div>') +

            '<div class="field"><label>Prérequis</label>' +
                '<div class="req-box">' + requirementChecklist(r) + '</div>' +
                '<span class="hint">Aussi modifiable dans l\'éditeur en tirant des liens.</span></div>' +

            '<div class="field"><label>Rapport publié à l\'achèvement</label>' +
                '<textarea data-report placeholder="Texte lu par les invités une fois la recherche terminée.">' +
                esc(r.report) + '</textarea></div>' +

            repeatSection(r, isNew) +
            boostSection(r) +
            debuffSection(r) +

            '<label class="check"><input type="checkbox" data-corrupt' + (r.corrupted ? ' checked' : '') +
                '><span>Entrée corrompue</span></label>' +

            '<button class="btn btn-block" type="button" data-save>Enregistrer</button>';

        UI.modal(isNew ? 'Nouvelle recherche' : 'Modifier — ' + r.code, body, function (root, close) {
            root.querySelector('[data-name]').focus();

            // Sélecteur de preset ↔ champ d'URL, selon le type d'icône choisi.
            var iconInput = root.querySelector('[data-icon]');
            var presetBox = root.querySelector('[data-icon-preset]');
            var urlBox = root.querySelector('[data-icon-url]');
            var iconTypeSel = root.querySelector('[data-icontype]');
            if (ICONS) ICONS.wirePicker(root, iconInput);
            if (iconTypeSel) {
                iconTypeSel.addEventListener('change', function () {
                    var isImage = iconTypeSel.value === 'image';
                    if (presetBox) presetBox.hidden = isImage;
                    if (urlBox) urlBox.hidden = !isImage;
                    if (!isImage && ICONS && /^https?:/i.test(iconInput.value)) {
                        iconInput.value = ICONS.keyFor('');
                    }
                });
            }
            root.querySelector('[data-save]').addEventListener('click', function () {
                var name = root.querySelector('[data-name]').value.trim();
                if (!name) return UI.toast('Le nom est obligatoire.', 'error');

                var unit = Number(root.querySelector('[data-durunit]').value);
                var minutes = Number(root.querySelector('[data-dur]').value) * unit;
                var costValue = Number(root.querySelector('[data-cost]').value);
                if (!(minutes >= R.MIN_DURATION)) {
                    return UI.toast('Durée minimale : ' + UI.duration(R.MIN_DURATION) + '.', 'error');
                }
                if (!(costValue >= R.MIN_COST)) {
                    return UI.toast('Coût minimal : ' + UI.number(R.MIN_COST) + ' PR.', 'error');
                }
                var payload = {
                    id: r.id,
                    code: root.querySelector('[data-code]').value,
                    name: name,
                    description: root.querySelector('[data-desc]').value.trim(),
                    tierId: root.querySelector('[data-tier]').value,
                    type: root.querySelector('[data-type]').value,
                    branch: root.querySelector('[data-branch]').value,
                    icon: root.querySelector('[data-icon]').value.trim(),
                    iconType: root.querySelector('[data-icontype]').value,
                    durationMinutes: minutes,
                    costPoints: costValue,
                    requires: Array.prototype.slice.call(root.querySelectorAll('[data-req]:checked'))
                        .map(function (c) { return c.value; }),
                    report: root.querySelector('[data-report]').value.trim(),
                    corrupted: root.querySelector('[data-corrupt]').checked,
                    repeatable: root.querySelector('[data-repeat]').checked,
                    maxRepeats: root.querySelector('[data-maxrep]').value,
                    scaling: {
                        enabled: root.querySelector('[data-scale]').checked,
                        temps: root.querySelector('[data-scale-temps]').value,
                        cout: root.querySelector('[data-scale-cout]').value,
                        vitesse: root.querySelector('[data-scale-vitesse]').value
                    },
                    boost: {
                        enabled: root.querySelector('[data-boost]').checked,
                        type: root.querySelector('[data-boost-type]').value,
                        value: root.querySelector('[data-boost-value]').value,
                        hours: root.querySelector('[data-boost-hours]').value,
                        stack: root.querySelector('[data-boost-stack]').checked
                    },
                    requireCounts: readRequireCounts(root),
                    group: root.querySelector('[data-group]').value,
                    debuff: {
                        enabled: root.querySelector('[data-debuff]').checked,
                        type: root.querySelector('[data-debuff-type]').value,
                        graceDays: root.querySelector('[data-debuff-grace]').value,
                        start: root.querySelector('[data-debuff-start]').value,
                        perDay: root.querySelector('[data-debuff-perday]').value,
                        max: root.querySelector('[data-debuff-max]').value
                    }
                };
                if (payload.debuff.enabled && !(Number(payload.debuff.max) > 0)) {
                    return UI.toast('Malus d\'abandon : indiquez un maximum supérieur à 0 %.', 'error');
                }
                if (payload.debuff.enabled && !payload.repeatable && !payload.group.trim()) {
                    UI.toast('Attention : le malus ne s\'applique qu\'à une recherche répétable ou à une famille qui en contient une.');
                }
                if (payload.boost.enabled && !(Number(payload.boost.hours) >= 1 && Number(payload.boost.value))) {
                    return UI.toast('Boost : indiquez une variation non nulle et une durée d\'au moins 1 heure.', 'error');
                }
                var inv = root.querySelector('[data-invested]');
                if (inv) payload.invested = inv.value;
                var completions = root.querySelector('[data-completions]');
                if (completions) payload.completions = completions.value;
                if (isNew && preset.dx !== undefined) {
                    payload.dx = preset.dx;
                    payload.y = preset.y;
                }

                if (R.createsCycle(r.id, payload.requires)) {
                    return UI.toast('Dépendance circulaire : ces prérequis se bouclent sur eux-mêmes.', 'error');
                }

                var saved = R.upsertResearch(payload);
                close();
                UI.toast('Recherche enregistrée.', 'ok');
                if (editorGraph) editorSelection = { type: 'node', id: saved.id };
                renderAll();
                if (editorGraph) editorGraph.select(saved.id);
            });
        });
    }

    function requirementChecklist(r) {
        var groups = R.tiers().map(function (t) {
            var items = R.all().filter(function (x) { return x.tierId === t.id && x.id !== r.id; });
            if (!items.length) return '';
            return '<p class="dim mono" style="margin:.5rem 0 .2rem">' + esc(t.name) + '</p>' +
                items.map(function (x) {
                    var checked = (r.requires || []).indexOf(x.id) >= 0 ? ' checked' : '';
                    // Une source répétable peut être exigée plusieurs fois.
                    var count = x.repeatable
                        ? '<span class="req-count">× <input type="number" min="1" max="9999" data-req-count="' + x.id +
                          '" value="' + R.requiredCount(r, x.id) + '" aria-label="Achèvements exigés de ' + esc(x.code) + '"></span>'
                        : '';
                    return '<label class="check req-line" style="margin-bottom:.3rem">' +
                        '<input type="checkbox" data-req value="' + x.id + '"' + checked + '>' +
                        '<span>' + esc(x.code) + ' — ' + esc(x.name) +
                            (x.repeatable ? ' <span class="badge">↻ répétable</span>' : '') + '</span>' + count + '</label>';
                }).join('');
        }).join('');
        return groups || '<p class="dim">Aucune autre recherche disponible.</p>';
    }

    function readRequireCounts(root) {
        var counts = {};
        root.querySelectorAll('[data-req-count]').forEach(function (input) {
            counts[input.getAttribute('data-req-count')] = input.value;
        });
        return counts;
    }

    function repeatSection(r, isNew) {
        var s = r.scaling || {};
        return '<fieldset class="form-section"><legend>Répétition</legend>' +
            '<label class="check"><input type="checkbox" data-repeat' + (r.repeatable ? ' checked' : '') +
                '><span>Recherche répétable : après chaque achèvement, elle repart en financement</span></label>' +
            '<div class="form-row">' +
                '<div class="field"><label>Répétitions max</label>' +
                    '<input type="number" min="0" data-maxrep value="' + Number(r.maxRepeats || 0) + '">' +
                    '<span class="hint">0 = illimité.</span></div>' +
                (isNew ? '' : '<div class="field"><label>Déjà effectuées</label>' +
                    '<input type="number" min="0" data-completions value="' + R.times(r) + '"></div>') +
            '</div>' +
            '<label class="check"><input type="checkbox" data-scale' + (s.enabled ? ' checked' : '') +
                '><span>Progression à chaque répétition' +
                (R.scalingEnabled() ? '' : ' <b class="warn-text">— désactivée pour tout l\'arbre (Catalogue)</b>') + '</span></label>' +
            '<div class="form-row form-row-3">' +
                scaleField('temps', 'Durée', s.temps) +
                scaleField('cout', 'Coût', s.cout) +
                scaleField('vitesse', 'Vitesse de financement', s.vitesse) +
            '</div>' +
            '<span class="hint">En % par répétition, composé : +10 % après 5 répétitions = ×1,61. 0 = inchangé. ' +
                'La vitesse multiplie les PR crédités à chaque versement.</span>' +
            '</fieldset>';

        function scaleField(key, label, value) {
            return '<div class="field"><label>' + label + ' (%)</label>' +
                '<input type="number" step="1" min="-90" max="500" data-scale-' + key + ' value="' + (Number(value) || 0) + '"></div>';
        }
    }

    function boostSection(r) {
        var b = r.boost || {};
        return '<fieldset class="form-section"><legend>Boost à l\'achèvement</legend>' +
            '<label class="check"><input type="checkbox" data-boost' + (b.enabled ? ' checked' : '') +
                '><span>Accorder un boost temporaire à toute la division</span></label>' +
            '<div class="form-row form-row-3">' +
                '<div class="field"><label>Effet</label><select data-boost-type>' +
                    ['cout', 'temps', 'rendement'].map(function (k) {
                        return '<option value="' + k + '"' + ((b.type || 'cout') === k ? ' selected' : '') + '>' +
                            esc(R.EFFECTS[k]) + '</option>';
                    }).join('') + '</select></div>' +
                '<div class="field"><label>Variation (%)</label>' +
                    '<input type="number" step="1" data-boost-value value="' + (b.value != null ? Number(b.value) : -5) + '"></div>' +
                '<div class="field"><label>Durée (heures)</label>' +
                    '<input type="number" min="1" max="720" data-boost-hours value="' + (Number(b.hours) || 12) + '"></div>' +
            '</div>' +
            '<label class="check"><input type="checkbox" data-boost-stack' + (b.stack ? ' checked' : '') +
                '><span>Cumulable (sinon, un nouvel achèvement prolonge le boost en cours)</span></label>' +
            '</fieldset>';
    }

    /** Texte signé d'un malus : plus de coût ou de durée, moins de rendement. */
    function debuffEffect(type, value) {
        return R.effectText({ type: type, value: type === 'rendement' ? -value : value });
    }

    function debuffSection(r) {
        var d = r.debuff || {};
        var num = function (value, fallback) { return value != null && value !== '' ? Number(value) : fallback; };
        var state = r.id ? R.debuffState(r) : null;
        var status = '';
        if (state && state.active) {
            status = '<div class="alert alert-error" style="margin:.6rem 0 .4rem">Actif : ' + esc(debuffEffect(state.type, state.value)) +
                ' — dernier achèvement de la famille le ' + UI.date(state.last) + '.</div>';
        } else if (state) {
            status = '<p class="dim" style="font-size:.82rem; margin:.6rem 0 .2rem">Se déclenchera le ' + UI.date(state.startsAt) +
                ' sans nouvel achèvement.</p>';
        }

        return '<fieldset class="form-section"><legend>Malus d\'abandon</legend>' +
            '<div class="field"><label>Famille</label>' +
                '<input type="text" maxlength="40" data-group value="' + esc(r.group || '') + '" placeholder="café">' +
                '<span class="hint">Les recherches d\'une même famille partagent leur dernier achèvement : ' +
                    'en achever une suffit à suspendre le malus.</span></div>' +
            '<label class="check"><input type="checkbox" data-debuff' + (d.enabled ? ' checked' : '') +
                '><span>Pénaliser la division si la recherche (ou sa famille) est délaissée' +
                (R.debuffsEnabled() ? '' : ' <b class="warn-text">— malus désactivés pour tout l\'arbre (Catalogue)</b>') + '</span></label>' +
            '<div class="form-row form-row-3">' +
                '<div class="field"><label>Effet</label><select data-debuff-type>' +
                    [['cout', 'Coût en hausse'], ['temps', 'Durée en hausse'], ['rendement', 'Rendement en baisse']].map(function (o) {
                        return '<option value="' + o[0] + '"' + ((d.type || 'cout') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
                    }).join('') + '</select></div>' +
                '<div class="field"><label>Délai de grâce (jours)</label>' +
                    '<input type="number" min="0" max="365" step="1" data-debuff-grace value="' + num(d.graceDays, 14) + '"></div>' +
                '<div class="field"><label>Malus au départ (%)</label>' +
                    '<input type="number" min="0" max="500" step="0.5" data-debuff-start value="' + num(d.start, 1) + '"></div>' +
            '</div>' +
            '<div class="form-row">' +
                '<div class="field"><label>Hausse par jour (%)</label>' +
                    '<input type="number" min="0" max="500" step="0.5" data-debuff-perday value="' + num(d.perDay, 1) + '"></div>' +
                '<div class="field"><label>Malus maximum (%)</label>' +
                    '<input type="number" min="0" max="500" step="1" data-debuff-max value="' + num(d.max, 20) + '"></div>' +
            '</div>' +
            '<span class="hint">Exemple : 14 j, 1 %, +1 %/jour, 25 % → le 15ᵉ jour sans achèvement, +1 % de coût ; le 20ᵉ, +6 % ; ' +
                'jamais plus de 25 %. Aucun malus avant le premier achèvement, ni pour une famille qui ne peut plus être relancée.</span>' +
            status +
            '</fieldset>';
    }

    function splitDuration(minutes) {
        if (minutes % 1440 === 0 && minutes >= 1440) return { value: minutes / 1440, unit: 1440 };
        if (minutes % 60 === 0 && minutes >= 60) return { value: minutes / 60, unit: 60 };
        return { value: minutes, unit: 1 };
    }

    function statusForm(r) {
        var body =
            '<p class="muted">Forcer l\'état de <b>' + esc(r.code) + ' — ' + esc(r.name) + '</b>. ' +
            'Pour corriger un incident ou débloquer un scénario.</p>' +
            '<div class="rcard-actions" style="margin-top:1.2rem">' +
                '<button class="btn btn-ok btn-sm" type="button" data-s="done">' +
                    (r.repeatable ? 'Compter une répétition' : 'Marquer terminée') + '</button>' +
                '<button class="btn btn-sm" type="button" data-s="running">Relancer le chrono</button>' +
                '<button class="btn btn-ghost btn-sm" type="button" data-s="idle">Remettre en attente</button>' +
                '<button class="btn btn-danger btn-sm" type="button" data-reset>Réinitialiser (PR' +
                    (r.repeatable ? ' et répétitions' : '') + ' compris)</button>' +
            '</div>';
        UI.modal('Statut de la recherche', body, function (root, close) {
            root.querySelectorAll('[data-s]').forEach(function (b) {
                b.addEventListener('click', function () {
                    R.setStatus(r.id, b.getAttribute('data-s'));
                    close(); UI.toast('Statut modifié.', 'ok'); renderAll();
                });
            });
            root.querySelector('[data-reset]').addEventListener('click', function () {
                R.resetResearch(r.id);
                close(); UI.toast('Recherche réinitialisée.'); renderAll();
            });
        });
    }

    bind('new-research', function () {
        if (!R.tiers().length) return UI.toast('Créez d\'abord un palier.', 'error');
        researchForm(null);
    });

    // Interrupteur global : coupe la progression par répétition de toutes les recherches.
    var scalingToggle = document.getElementById('adm-repeat-scaling');
    if (scalingToggle) {
        scalingToggle.checked = R.scalingEnabled();
        scalingToggle.addEventListener('change', function () {
            R.setRepeatScaling(scalingToggle.checked);
            UI.toast('Progression par répétition ' + (scalingToggle.checked ? 'activée.' : 'désactivée.'), 'ok');
            renderAll();
        });
    }

    // Interrupteur global des malus d'abandon.
    var debuffToggle = document.getElementById('adm-debuffs');
    if (debuffToggle) {
        debuffToggle.checked = R.debuffsEnabled();
        debuffToggle.addEventListener('change', function () {
            R.setDebuffsEnabled(debuffToggle.checked);
            UI.toast('Malus d\'abandon ' + (debuffToggle.checked ? 'activés.' : 'désactivés.'), 'ok');
            renderAll();
        });
    }

    /* ------------------------------------------------------------------
       Paliers
       ------------------------------------------------------------------ */

    function renderPaliers() {
        var host = document.getElementById('pane-paliers');
        if (!host) return;

        host.innerHTML = '<table><thead><tr><th>Colonne</th><th>Palier</th><th>Recherches</th>' +
            '<th>Intégrité</th><th>Actions</th></tr></thead><tbody>' +
            R.tiers().map(function (t, i) {
                var count = R.all().filter(function (r) { return r.tierId === t.id; }).length;
                return '<tr data-t="' + t.id + '"><td class="mono">' + (i + 1) + ' <span class="dim">(ordre ' + t.order + ' · ' + R.tierWidth(t) + ' px)</span></td>' +
                    '<td><b>' + esc(t.name) + '</b><br><span class="dim">' + esc(t.description || '') + '</span></td>' +
                    '<td class="mono">' + count + '</td>' +
                    '<td>' + (t.corrupted ? '<span class="badge badge-corrupt">Corrompu</span>' : '<span class="badge badge-ok">Stable</span>') + '</td>' +
                    '<td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" type="button" data-edit>Modifier</button> ' +
                    '<button class="btn btn-ghost btn-sm" type="button" data-corrupt-toggle>' +
                        (t.corrupted ? '✦ Purger' : '☣ Corrompre') + '</button> ' +
                    '<button class="btn btn-danger btn-sm" type="button" data-del>Supprimer</button></td></tr>';
            }).join('') + '</tbody></table>';

        host.querySelectorAll('[data-t]').forEach(function (tr) {
            var id = tr.getAttribute('data-t');
            tr.querySelector('[data-edit]').addEventListener('click', function () { tierForm(R.tierById(id)); });
            tr.querySelector('[data-corrupt-toggle]').addEventListener('click', function () { corruptionForm(R.tierById(id)); });
            tr.querySelector('[data-del]').addEventListener('click', function () {
                var res = R.deleteTier(id);
                if (!res.ok) return UI.toast(res.error, 'error');
                UI.toast('Palier supprimé.');
                renderAll();
            });
        });
    }

    /** Corrompre un palier, ou purger sa corruption, avec confirmation. */
    function corruptionForm(tier) {
        if (!tier) return;
        var own = R.all().filter(function (r) { return r.tierId === tier.id; });
        var corrupt = !tier.corrupted;
        UI.modal(corrupt ? 'Corrompre le palier' : 'Purger la corruption',
            '<p class="muted">' + (corrupt
                ? '« ' + esc(tier.name) + ' » disparaîtra pour les invités et les chercheurs. ' +
                  'Les chercheurs ne l\'apercevront plus que par intermittence dans l\'arbre.'
                : '« ' + esc(tier.name) + ' » redeviendra visible et consultable par tous les chercheurs.') + '</p>' +
            (own.length
                ? '<label class="check" style="margin-top:1rem"><input type="checkbox" data-with checked><span>' +
                  (corrupt ? 'Corrompre' : 'Purger') + ' aussi ses ' + own.length + ' recherche(s)</span></label>'
                : '') +
            '<div class="rcard-actions" style="margin-top:1.2rem">' +
                '<button class="btn ' + (corrupt ? 'btn-danger' : 'btn-ok') + '" type="button" data-yes>' +
                    (corrupt ? '☣ Corrompre' : '✦ Purger') + '</button>' +
                '<button class="btn btn-ghost" type="button" data-no>Annuler</button></div>',
            function (root, close) {
                root.querySelector('[data-no]').addEventListener('click', close);
                root.querySelector('[data-yes]').addEventListener('click', function () {
                    var withBox = root.querySelector('[data-with]');
                    R.setTierCorruption(tier.id, corrupt, withBox ? withBox.checked : false);
                    close();
                    UI.toast(corrupt ? 'Palier corrompu.' : 'Corruption purgée.', 'ok');
                    renderAll();
                });
            });
    }

    function tierForm(tier) {
        var tiers = R.tiers();
        tier = tier || { name: '', description: '', order: tiers.length ? tiers[tiers.length - 1].order + 1 : 0, span: 1, corrupted: false };
        var body =
            '<div class="field"><label>Nom du palier</label>' +
            '<input type="text" data-name value="' + esc(tier.name) + '" placeholder="Palier IV — Opérations spéciales"></div>' +
            '<div class="field"><label>Description</label><textarea data-desc>' + esc(tier.description) + '</textarea></div>' +
            '<div class="form-row">' +
                '<div class="field"><label>Ordre (position)</label>' +
                    '<input type="number" data-order value="' + Number(tier.order) + '"></div>' +
                '<div class="field"><label>Largeur (px)</label>' +
                    '<input type="number" min="' + R.MIN_TIER_W + '" max="6000" step="10" data-width value="' +
                    R.tierWidth(tier) + '"></div>' +
            '</div>' +
            '<p class="hint" style="margin:-.4rem 0 1rem">Astuce : dans l\'éditeur d\'arbre, tirez directement les bords ' +
                'd\'une zone de palier pour l\'agrandir ou la rétrécir.</p>' +
            (tier.top != null || tier.bottom != null
                ? '<label class="check"><input type="checkbox" data-autoh><span>Rétablir la hauteur automatique</span></label>' : '') +
            '<label class="check"><input type="checkbox" data-corrupt' + (tier.corrupted ? ' checked' : '') +
            '><span>Palier corrompu — invisible des invités et des chercheurs</span></label>' +
            '<button class="btn btn-block" type="button" data-save>Enregistrer</button>';

        UI.modal(tier.id ? 'Modifier le palier' : 'Nouveau palier', body, function (root, close) {
            root.querySelector('[data-save]').addEventListener('click', function () {
                var name = root.querySelector('[data-name]').value.trim();
                if (!name) return UI.toast('Le nom est obligatoire.', 'error');
                R.upsertTier({
                    id: tier.id,
                    name: name,
                    description: root.querySelector('[data-desc]').value.trim(),
                    order: root.querySelector('[data-order]').value,
                    width: root.querySelector('[data-width]').value,
                    autoHeight: !!(root.querySelector('[data-autoh]') && root.querySelector('[data-autoh]').checked),
                    corrupted: root.querySelector('[data-corrupt]').checked
                });
                close();
                UI.toast('Palier enregistré.', 'ok');
                renderAll();
            });
        });
    }

    bind('new-tier', function () { tierForm(null); });

    /* ------------------------------------------------------------------
       Événements (directives) et annonces
       ------------------------------------------------------------------ */

    function polarityBadge(e) {
        var pol = R.polarity(e);
        if (pol === 'positif') return '<span class="badge badge-pos">Positif</span>';
        if (pol === 'negatif') return '<span class="badge badge-neg">Négatif</span>';
        return '<span class="badge">Neutre</span>';
    }

    function renderEvenements() {
        var host = document.getElementById('pane-evenements');
        if (!host) return;
        var events = Store.load().events;

        host.innerHTML = events.length ? events.map(function (e) {
            var active = R.eventActive(e);
            var pol = R.polarity(e);
            return '<article class="event-card' + (active ? '' : ' off') + (pol === 'positif' ? ' pos' : pol === 'negatif' ? ' neg' : '') +
                    '" data-e="' + e.id + '">' +
                '<span class="badge ' + (active ? 'badge-run' : 'badge-lock') + '">' +
                    (active ? 'Active' : e.enabled ? 'Programmée / expirée' : 'Désactivée') + '</span> ' + polarityBadge(e) +
                '<h4 style="margin-top:.7rem">' + esc(e.name) + '</h4>' +
                '<p class="muted" style="font-size:.88rem">' + esc(e.description || '') + '</p>' +
                '<p class="mono" style="margin-top:.7rem; color:var(--frost)">' + esc(R.effectText(e)) + '</p>' +
                '<p class="dim" style="font-size:.78rem">Du ' + UI.date(e.startsAt) + ' au ' + (e.endsAt ? UI.date(e.endsAt) : 'sans terme') + '</p>' +
                '<div class="rcard-actions" style="margin-top:.9rem">' +
                    '<button class="btn btn-ghost btn-sm" type="button" data-edit>Modifier</button>' +
                    '<button class="btn btn-ghost btn-sm" type="button" data-toggle>' + (e.enabled ? 'Désactiver' : 'Activer') + '</button>' +
                    '<button class="btn btn-danger btn-sm" type="button" data-del>Supprimer</button>' +
                '</div></article>';
        }).join('') : '<div class="panel"><h3>Aucune directive</h3><p>Accélérez, ralentissez ou renchérissez temporairement les travaux.</p></div>';

        host.querySelectorAll('[data-e]').forEach(function (card) {
            var id = card.getAttribute('data-e');
            var e = Store.load().events.filter(function (x) { return x.id === id; })[0];
            card.querySelector('[data-edit]').addEventListener('click', function () { eventForm(e); });
            card.querySelector('[data-toggle]').addEventListener('click', function () {
                R.toggleEvent(id);
                renderAll();
            });
            card.querySelector('[data-del]').addEventListener('click', function () {
                R.deleteEvent(id); UI.toast('Directive supprimée.'); renderAll();
            });
        });
    }

    function eventForm(e, preset) {
        var isNew = !e;
        e = e || {
            name: '', description: '', type: 'temps', value: preset === 'negatif' ? 25 : -15,
            startsAt: Date.now(), endsAt: Date.now() + 3 * 864e5, enabled: true
        };
        var body =
            '<div class="field"><label>Nom</label>' +
                '<input type="text" data-name value="' + esc(e.name) + '" placeholder="Coupes budgétaires du Conseil"></div>' +
            '<div class="field"><label>Message affiché aux chercheurs</label>' +
                '<textarea data-desc>' + esc(e.description) + '</textarea></div>' +
            '<div class="form-row">' +
                '<div class="field"><label>Effet sur</label><select data-type>' +
                    Object.keys(R.EFFECTS).map(function (k) {
                        return '<option value="' + k + '"' + (e.type === k ? ' selected' : '') + '>' + R.EFFECTS[k] + '</option>';
                    }).join('') + '</select></div>' +
                '<div class="field"><label>Variation (%)</label>' +
                    '<input type="number" data-value value="' + Number(e.value) + '" step="5"></div>' +
            '</div>' +
            '<p data-preview style="margin:-.3rem 0 1rem"></p>' +
            '<div class="form-row">' +
                '<div class="field"><label>Début</label><input type="datetime-local" data-start value="' + toLocalInput(e.startsAt) + '"></div>' +
                '<div class="field"><label>Fin</label><input type="datetime-local" data-end value="' + toLocalInput(e.endsAt) + '">' +
                    '<span class="hint">Vide = sans terme.</span></div>' +
            '</div>' +
            '<label class="check"><input type="checkbox" data-enabled' + (e.enabled !== false ? ' checked' : '') + '><span>Active</span></label>' +
            '<button class="btn btn-block" type="button" data-save>Enregistrer</button>';

        UI.modal(isNew ? 'Nouvel événement' : 'Modifier l\'événement', body, function (root, close) {
            var type = root.querySelector('[data-type]');
            var value = root.querySelector('[data-value]');
            function preview() {
                var probe = { type: type.value, value: value.value };
                root.querySelector('[data-preview]').innerHTML = polarityBadge(probe) + ' <span class="muted">' + esc(R.effectText(probe)) + '</span>';
            }
            type.addEventListener('change', preview);
            value.addEventListener('input', preview);
            preview();

            root.querySelector('[data-save]').addEventListener('click', function () {
                var name = root.querySelector('[data-name]').value.trim();
                if (!name) return UI.toast('Le nom est obligatoire.', 'error');
                R.upsertEvent({
                    id: e.id,
                    name: name,
                    description: root.querySelector('[data-desc]').value.trim(),
                    type: type.value,
                    value: value.value,
                    startsAt: root.querySelector('[data-start]').value || null,
                    endsAt: root.querySelector('[data-end]').value || null,
                    enabled: root.querySelector('[data-enabled]').checked
                });
                close();
                UI.toast('Événement enregistré.', 'ok');
                renderAll();
            });
        });
    }

    bind('new-event-pos', function () { eventForm(null, 'positif'); });
    bind('new-event-neg', function () { eventForm(null, 'negatif'); });

    function renderAnnonces() {
        var host = document.getElementById('pane-annonces');
        if (!host) return;
        var list = Store.load().announcements || [];
        var now = Date.now();

        host.innerHTML = list.length ? list.slice().sort(function (a, b) { return b.createdAt - a.createdAt; }).map(function (a) {
            var live = a.enabled && (!a.startsAt || now >= a.startsAt) && (!a.endsAt || now <= a.endsAt);
            return '<article class="announce announce-' + a.kind + (live ? '' : ' off') + '" data-a="' + a.id + '">' +
                '<span class="badge ' + (live ? 'badge-run' : 'badge-lock') + '">' + (live ? 'En ligne' : 'Hors ligne') + '</span> ' +
                '<span class="badge">' + News.KINDS[a.kind] + '</span>' +
                '<h3>' + esc(a.title) + '</h3>' +
                (a.body ? '<p>' + esc(a.body) + '</p>' : '') +
                '<p class="dim" style="font-size:.78rem">Du ' + UI.date(a.startsAt) + ' au ' + (a.endsAt ? UI.date(a.endsAt) : 'sans terme') + '</p>' +
                '<div class="rcard-actions" style="margin-top:.7rem">' +
                    '<button class="btn btn-ghost btn-sm" type="button" data-edit>Modifier</button>' +
                    '<button class="btn btn-ghost btn-sm" type="button" data-toggle>' + (a.enabled ? 'Retirer' : 'Publier') + '</button>' +
                    '<button class="btn btn-danger btn-sm" type="button" data-del>Supprimer</button>' +
                '</div></article>';
        }).join('') : '<div class="panel"><h3>Aucune annonce</h3><p>Les annonces apparaissent en tête de l\'accueil et des pages de recherche.</p></div>';

        host.querySelectorAll('[data-a]').forEach(function (card) {
            var id = card.getAttribute('data-a');
            var a = Store.load().announcements.filter(function (x) { return x.id === id; })[0];
            card.querySelector('[data-edit]').addEventListener('click', function () { announceForm(a); });
            card.querySelector('[data-toggle]').addEventListener('click', function () {
                News.toggle(id);
                renderAll();
            });
            card.querySelector('[data-del]').addEventListener('click', function () {
                News.remove(id); UI.toast('Annonce supprimée.'); renderAll();
            });
        });
    }

    function announceForm(a) {
        var isNew = !a;
        a = a || { title: '', body: '', kind: 'info', startsAt: Date.now(), endsAt: null, enabled: true };
        var body =
            '<div class="field"><label>Titre</label><input type="text" data-title value="' + esc(a.title) + '"></div>' +
            '<div class="field"><label>Message</label><textarea data-body>' + esc(a.body) + '</textarea></div>' +
            '<div class="field"><label>Ton</label><select data-kind>' +
                Object.keys(News.KINDS).map(function (k) {
                    return '<option value="' + k + '"' + (a.kind === k ? ' selected' : '') + '>' + News.KINDS[k] + '</option>';
                }).join('') + '</select></div>' +
            '<div class="form-row">' +
                '<div class="field"><label>Début</label><input type="datetime-local" data-start value="' + toLocalInput(a.startsAt) + '"></div>' +
                '<div class="field"><label>Fin</label><input type="datetime-local" data-end value="' + toLocalInput(a.endsAt) + '">' +
                    '<span class="hint">Vide = sans terme.</span></div>' +
            '</div>' +
            '<label class="check"><input type="checkbox" data-enabled' + (a.enabled !== false ? ' checked' : '') + '><span>Publiée</span></label>' +
            '<button class="btn btn-block" type="button" data-save>Enregistrer</button>';

        UI.modal(isNew ? 'Nouvelle annonce' : 'Modifier l\'annonce', body, function (root, close) {
            root.querySelector('[data-save]').addEventListener('click', function () {
                var title = root.querySelector('[data-title]').value.trim();
                if (!title) return UI.toast('Le titre est obligatoire.', 'error');
                News.upsert({
                    id: a.id,
                    title: title,
                    body: root.querySelector('[data-body]').value.trim(),
                    kind: root.querySelector('[data-kind]').value,
                    startsAt: root.querySelector('[data-start]').value || null,
                    endsAt: root.querySelector('[data-end]').value || null,
                    enabled: root.querySelector('[data-enabled]').checked
                });
                close();
                UI.toast('Annonce enregistrée.', 'ok');
                renderAll();
            });
        });
    }

    bind('new-announce', function () { announceForm(null); });

    function toLocalInput(ts) {
        if (!ts) return '';
        var d = new Date(ts);
        var pad = function (n) { return String(n).padStart(2, '0'); };
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
            'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    /* ------------------------------------------------------------------
       Journal
       ------------------------------------------------------------------ */

    function renderJournal() {
        var host = document.getElementById('pane-journal');
        if (!host) return;
        var dev = Auth.can('admin');
        var logs = Store.load().logs.filter(function (l) { return dev || !l.hidden; });
        host.innerHTML = '<table><thead><tr><th>Horodatage</th><th>Acteur</th><th>Action</th><th>Détail</th></tr></thead><tbody>' +
            logs.map(function (l) {
                return '<tr><td class="mono dim" style="white-space:nowrap">' + UI.date(l.at) + '</td>' +
                    '<td>' + esc(l.actor) + (l.hidden ? ' <span class="badge badge-corrupt">dev</span>' : '') + '</td>' +
                    '<td><b>' + esc(l.action) + '</b></td>' +
                    '<td class="muted">' + esc(l.detail) + '</td></tr>';
            }).join('') + '</tbody></table>';
    }

    /* ------------------------------------------------------------------
       Maintenance
       ------------------------------------------------------------------ */

    bind('mt-export', function () {
        var json = JSON.stringify(Store.load(), null, 2);
        UI.modal('Export de la base', '<textarea style="min-height:340px" readonly>' + esc(json) + '</textarea>' +
            '<button class="btn btn-block" type="button" data-copy style="margin-top:.8rem">Copier</button>',
            function (root) {
                root.querySelector('[data-copy]').addEventListener('click', function () {
                    var ta = root.querySelector('textarea');
                    ta.select();
                    if (!navigator.clipboard) {
                        return UI.toast('Copie automatique indisponible : le texte est sélectionné, faites Ctrl+C.');
                    }
                    navigator.clipboard.writeText(ta.value).then(function () {
                        UI.toast('Copié dans le presse-papiers.', 'ok');
                    }, function () {
                        UI.toast('Copie refusée : le texte est sélectionné, faites Ctrl+C.', 'error');
                    });
                });
            });
    });

    bind('mt-import-go', function () {
        var raw = document.getElementById('mt-import').value.trim();
        if (!raw) return UI.toast('Collez d\'abord un export JSON.', 'error');
        var parsed;
        try { parsed = JSON.parse(raw); } catch (err) { return UI.toast('JSON invalide.', 'error'); }
        if (!parsed || !parsed.researches || !parsed.tiers || (!GOC.remote && !parsed.users)) {
            return UI.toast('Structure inattendue.', 'error');
        }

        confirmBox('Restaurer cette sauvegarde ?',
            GOC.remote
                ? 'Paliers, recherches, directives et annonces seront remplacés. Les comptes ne sont pas touchés.'
                : 'La base actuelle sera intégralement remplacée, votre session comprise.',
            function () {
                var res = Maintenance.restore(parsed);
                if (!res.ok) return UI.toast(res.error, 'error');
                if (!res.full) {
                    UI.toast('Sauvegarde restaurée.', 'ok');
                    return renderAll();
                }
                Auth.logout();
                UI.toast('Base restaurée. Reconnexion nécessaire.', 'ok');
                setTimeout(function () { location.href = 'connexion.html'; }, 900);
            });
    });

    bind('mt-reset', function () {
        confirmBox('Réinitialiser toute la base ?',
            GOC.remote
                ? 'Paliers, recherches, directives et annonces seront régénérés. Les comptes et le journal sont conservés.'
                : 'Comptes, recherches, événements, annonces et journaux seront effacés et régénérés.',
            function () {
                var res = Maintenance.reset();
                if (!res.ok) return UI.toast(res.error, 'error');
                UI.toast('Base réinitialisée.', 'ok');
                if (!res.full) return renderAll();
                setTimeout(function () { location.href = 'connexion.html'; }, 900);
            });
    });

    function renderMaintenance() {
        var el = document.getElementById('mt-state');
        if (!el) return;
        var db = Store.load();
        if (GOC.remote) {
            el.innerHTML =
                'Mode : <b>Firebase</b> (état officiel en base Firestore, actions rejouées par les Cloud Functions)<br>' +
                'Version de base : ' + db.version + '<br>' +
                'Comptes visibles : ' + db.users.length + ' · Recherches : ' + db.researches.length + ' · Paliers : ' + db.tiers.length + '<br>' +
                'Événements : ' + db.events.length + ' · Annonces : ' + (db.announcements || []).length + '<br>' +
                'Actions en attente de confirmation : ' + GOC.Remote.pending();
            return;
        }
        var size = 0;
        try { size = (localStorage.getItem('goc_ptolemee_db') || '').length; } catch (err) { /* noop */ }
        el.innerHTML =
            'Mode : <b>local</b> (prototype, données dans ce navigateur)<br>' +
            'Version de base : ' + db.version + '<br>' +
            'Taille : ' + (size / 1024).toFixed(1) + ' Ko<br>' +
            'Comptes : ' + db.users.length + ' · Recherches : ' + db.researches.length + ' · Paliers : ' + db.tiers.length + '<br>' +
            'Événements : ' + db.events.length + ' · Annonces : ' + (db.announcements || []).length + '<br>' +
            'Sessions ouvertes : ' + db.sessions.length + '<br>' +
            'Cookies natifs : ' + (GOC.Cookies.available ? 'disponibles' : 'indisponibles (mode fichier local)');
    }

    /* ------------------------------------------------------------------
       Utilitaires
       ------------------------------------------------------------------ */

    function confirmBox(title, text, onYes) {
        UI.modal(title,
            '<p class="muted">' + esc(text) + '</p>' +
            '<div class="rcard-actions" style="margin-top:1.4rem">' +
                '<button class="btn btn-danger" type="button" data-yes>Confirmer</button>' +
                '<button class="btn btn-ghost" type="button" data-no>Annuler</button></div>',
            function (root, close) {
                root.querySelector('[data-yes]').addEventListener('click', function () { close(); onYes(); });
                root.querySelector('[data-no]').addEventListener('click', close);
            });
    }

    function bind(id, fn) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('click', fn);
    }

    function renderAll() {
        Auth.refresh();
        R.tick();
        renderBar();
        renderDemandes();
        renderMembres();
        renderPoints();
        renderArbre();
        renderRecherches();
        renderPaliers();
        renderEvenements();
        renderAnnonces();
        renderJournal();
        renderMaintenance();
    }

    var saved = UI.pref('admin-tab');
    var fallback = Auth.can('admin') ? 'arbre' : 'demandes';
    show(saved && document.querySelector('[data-panel="' + saved + '"]') ? saved : fallback);

    setInterval(function () {
        if (R.tick().length) {
            if (GOC.Remote) GOC.Remote.requestSync();
            renderAll();
        } else if (editorGraph) editorGraph.tick();
    }, 5000);

    // Mode Firebase : état officiel reçu (nouvelles demandes, versements…). Pas de redessin
    // pendant une saisie dans la console.
    if (GOC.Remote) {
        GOC.Remote.onSync(function () {
            var active = document.activeElement;
            if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
            renderAll();
        });
    }
});

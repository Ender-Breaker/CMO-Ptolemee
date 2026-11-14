/* ==========================================================================
   GOC — Division PTOLÉMÉE · Pages de consultation de l'arbre
   Utilisé par decouvertes.html (public), laboratoire.html (chercheurs)
   et recherches.html (membres, vue complète).

   Le mode est lu sur l'élément [data-tree] : public | chercheur | complet
   ========================================================================== */

GOC.ready(function () {
    'use strict';

    var Auth = GOC.Auth, UI = GOC.UI, R = GOC.Research, TEAMS = GOC.TEAMS;
    var esc = UI.escape;

    var root = document.querySelector('[data-tree]');
    if (!root) return;

    var MODE = root.getAttribute('data-tree');
    var canAct = MODE !== 'public' && Auth.can('chercheur');
    var filters = {
        query: '',
        type: UI.pref('tree-type') || 'tous',
        state: MODE === 'public' ? 'tous' : (UI.pref('tree-state') || 'tous'),
        branch: UI.pref('tree-branch') || 'tous'
    };
    var view = UI.pref('tree-view') === 'list' ? 'list' : 'graph';
    var selectedId = null;
    var graph = null;

    build();
    R.tick();
    bindToolbar();
    setView(view);
    setInterval(loop, 1000);

    // Mode Firebase : l'état officiel (versements des autres agents, fins de travaux) arrive du serveur.
    if (GOC.Remote) {
        GOC.Remote.onSync(function () {
            refreshHeaderPoints();
            // Pas de redessin pendant une saisie (montant en cours de frappe) : la prochaine synchro s'en charge.
            var active = document.activeElement;
            if (active && root.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
            redraw();
        });
    }

    /* ------------------------------------------------------------------
       Structure
       ------------------------------------------------------------------ */

    function build() {
        root.innerHTML =
            '<div class="tree-toolbar">' +
                field('f-query', 'Rechercher', '<input type="text" id="f-query" placeholder="Nom, code ou mot-clé…">', 'grow') +
                field('f-branch', 'Équipe', select('f-branch', [
                    ['tous', 'Toutes'], ['rd', 'Recherche & Développement'], ['qm', 'Quartier-maître']])) +
                field('f-type', 'Type', select('f-type', [
                    ['tous', 'Toutes'], ['principale', 'Principales'], ['secondaire', 'Secondaires']])) +
                (MODE === 'public' ? '' : field('f-state', 'État', select('f-state', [
                    ['tous', 'Tous'], ['funding', 'En financement'], ['ready', 'Prêtes à lancer'],
                    ['running', 'En cours'], ['done', 'Terminées'], ['locked', 'Verrouillées']]))) +
                '<div class="view-switch">' +
                    '<button type="button" data-view="graph">◈ Arbre</button>' +
                    '<button type="button" data-view="list">☰ Liste</button>' +
                '</div>' +
            '</div>' +
            '<div data-pane="graph">' +
                '<div class="tree-layout">' +
                    '<div class="graph-host"></div>' +
                    '<aside class="detail" data-detail aria-live="polite"></aside>' +
                '</div>' +
                '<div class="legend">' +
                    '<span><i class="hex"></i>Principale</span>' +
                    '<span><i></i>Secondaire</span>' +
                    (MODE === 'public' ? '' :
                        '<span><i class="lg-locked"></i>Verrouillée</span>' +
                        '<span><i class="lg-funding"></i>Financement</span>' +
                        '<span><i class="lg-ready"></i>Prête / en cours</span>') +
                    '<span><i class="lg-done"></i>Terminée</span>' +
                    '<span class="dim">Bouton ? : commandes souris, pavé tactile, tactile, clavier et manette</span>' +
                '</div>' +
            '</div>' +
            '<div data-pane="list" data-list></div>';
    }

    function field(id, label, control, cls) {
        return '<div class="field' + (cls ? ' ' + cls : '') + '"><label for="' + id + '">' + label + '</label>' +
            control + '</div>';
    }

    function select(id, options) {
        return '<select id="' + id + '">' + options.map(function (o) {
            return '<option value="' + o[0] + '">' + esc(o[1]) + '</option>';
        }).join('') + '</select>';
    }

    function bindToolbar() {
        var q = document.getElementById('f-query');
        q.addEventListener('input', function () {
            filters.query = q.value.trim().toLowerCase();
            applyFilters();
        });
        // Entrée : aller directement à la première recherche correspondante.
        q.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            var match = R.all().filter(function (r) { return R.researchVisible(r, MODE) && keep(r); })[0];
            if (match) locate(match.id);
            else UI.toast('Aucune recherche ne correspond.', 'error');
        });
        ['type', 'state', 'branch'].forEach(function (key) {
            var el = document.getElementById('f-' + key);
            if (!el) return;
            el.value = filters[key];
            el.addEventListener('change', function () {
                filters[key] = el.value;
                UI.pref('tree-' + key, el.value);
                applyFilters();
            });
        });
        root.querySelectorAll('[data-view]').forEach(function (b) {
            b.addEventListener('click', function () { setView(b.getAttribute('data-view')); });
        });
    }

    function setView(next) {
        view = next;
        UI.pref('tree-view', next);
        root.querySelectorAll('[data-view]').forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-view') === next);
        });
        root.querySelectorAll('[data-pane]').forEach(function (p) {
            p.hidden = p.getAttribute('data-pane') !== next;
        });
        if (next === 'graph' && !graph) {
            graph = GOC.Graph.create(root.querySelector('.graph-host'), {
                mode: MODE,
                emptyText: MODE === 'public'
                    ? 'Aucune recherche n\'a encore été publiée.'
                    : 'Aucune recherche à afficher.',
                onSelect: function (sel) {
                    selectedId = sel && sel.type === 'node' ? sel.id : null;
                    renderDetail();
                },
                // Entrée, bouton A de la manette, ou « Fiche » dans l'aperçu : amène la fiche à l'écran.
                onActivate: function (id) {
                    selectedId = id;
                    renderDetail();
                    var detail = root.querySelector('[data-detail]');
                    if (!detail) return;
                    detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    var first = detail.querySelector('input, button');
                    if (first) {
                        try { first.focus({ preventScroll: true }); } catch (err) { /* noop */ }
                    }
                }
            });
        }
        redraw();
    }

    /* ------------------------------------------------------------------
       Filtres
       ------------------------------------------------------------------ */

    function filtersActive() {
        return !!filters.query || filters.type !== 'tous' || filters.state !== 'tous' || filters.branch !== 'tous';
    }

    function keep(r) {
        if (filters.type !== 'tous' && r.type !== filters.type) return false;
        if (filters.branch !== 'tous' && (r.branch || 'rd') !== filters.branch) return false;
        if (filters.state !== 'tous' && R.state(r) !== filters.state) return false;
        if (filters.query) {
            // Au laboratoire, une entrée corrompue ne se trouve pas par son vrai nom.
            if (MODE === 'chercheur' && R.isCorrupted(r)) return false;
            var hay = (r.name + ' ' + r.code + ' ' + r.description).toLowerCase();
            if (hay.indexOf(filters.query) === -1) return false;
        }
        return true;
    }

    function applyFilters() {
        if (graph) graph.setFilter(filtersActive() ? keep : null);
        if (view === 'list') renderList();
    }

    /* ------------------------------------------------------------------
       Bandeaux
       ------------------------------------------------------------------ */

    function renderEvents() {
        var host = document.querySelector('[data-events]');
        if (!host) return;
        // Les malus d'abandon s'affichent comme des événements négatifs.
        var debuffs = R.activeDebuffs().map(function (d) {
            return {
                name: d.name, type: d.type, value: d.value, endsAt: null,
                description: 'Aucun achèvement depuis le ' + UI.date(d.last) + ' : le malus grandit chaque jour.'
            };
        });
        host.innerHTML = R.activeEvents().concat(debuffs).map(function (e) {
            var pol = R.polarity(e);
            var cls = pol === 'positif' ? ' pos' : pol === 'negatif' ? ' neg' : '';
            var ends = e.endsAt ? ' · jusqu\'au ' + UI.date(e.endsAt) : '';
            return '<div class="event-ticker' + cls + '"><b>' + (pol === 'negatif' ? '▼ ' : '▲ ') + esc(e.name) + '</b>' +
                '<span>' + esc(R.effectText(e)) + '</span>' +
                '<span class="dim">' + esc(e.description || '') + ends + '</span></div>';
        }).join('');
    }

    function renderBar() {
        var host = document.querySelector('[data-bar]');
        if (!host) return;
        var s = R.stats();
        var user = Auth.current();
        var mods = R.modifiers();

        var cells = [
            stat(s.done + ' / ' + s.total, 'Recherches achevées'),
            stat(s.running, 'Travaux en cours'),
            stat(UI.number(s.pool) + ' PR', 'Investis par la division')
        ];
        if (user && !user.hidden) cells.unshift(stat(UI.number(user.points) + ' PR', 'Votre réserve'));
        if (mods.temps !== 1) cells.push(stat(Math.round(mods.temps * 100) + ' %', 'Durées (directives)'));
        if (mods.cout !== 1) cells.push(stat(Math.round(mods.cout * 100) + ' %', 'Coûts (directives)'));
        if (mods.rendement !== 1) cells.push(stat(Math.round(mods.rendement * 100) + ' %', 'Rendement (directives)'));
        host.innerHTML = cells.join('');

        function stat(val, lbl) {
            return '<div class="stat"><span class="val">' + val + '</span><span class="lbl">' + lbl + '</span></div>';
        }
    }

    function refreshHeaderPoints() {
        var el = document.getElementById('hdr-points');
        var user = Auth.refresh();
        if (el && user) el.textContent = UI.number(user.points) + ' PR';
    }

    /* ------------------------------------------------------------------
       Fiche de recherche (vue arbre)
       ------------------------------------------------------------------ */

    function displayName(r) {
        return R.isCorrupted(r) ? UI.glitch(r.name, R.veilRatio(MODE)) : r.name;
    }

    /** Texte d'une entrée : brouillé si elle est corrompue (bien plus fort au laboratoire). */
    function veil(r, text) {
        return R.isCorrupted(r) ? UI.glitch(String(text), R.veilRatio(MODE)) : String(text);
    }

    /** Au laboratoire, une entrée corrompue ne montre ni icône, ni équipe, ni action. */
    function unreadable(r) {
        return MODE === 'chercheur' && R.isCorrupted(r);
    }

    function iconFor(r) {
        if (!unreadable(r)) return UI.iconHTML(r);
        return window.GOC.Icons ? window.GOC.Icons.html('▓') : '▓';
    }

    function factText(r, main, note) {
        return esc(veil(r, main)) + (note ? ' <span class="dim">(' + esc(veil(r, note)) + ')</span>' : '');
    }

    function badges(r, state) {
        return '<span class="badge ' + R.STATES[state].badge + '">' + R.STATES[state].label + '</span>' +
            (r.type === 'principale' ? '<span class="badge badge-main">Principale</span>' : '<span class="badge">Secondaire</span>') +
            '<span class="badge">' + (unreadable(r) ? '▒▒' : (TEAMS[r.branch] ? TEAMS[r.branch].short : 'R&D')) + '</span>' +
            (r.repeatable ? '<span class="badge badge-repeat" title="Recherche répétable">↻ ' + R.times(r) +
                (r.maxRepeats ? ' / ' + r.maxRepeats : '') + '</span>' : '') +
            (R.isCorrupted(r) ? '<span class="badge badge-corrupt">████</span>' : '');
    }

    function renderDetail() {
        var host = root.querySelector('[data-detail]');
        if (!host) return;
        var r = selectedId ? R.byId(selectedId) : null;
        var user = Auth.current();

        if (!r || !R.researchVisible(r, MODE)) {
            host.innerHTML =
                '<span class="eyebrow">Fiche de recherche</span>' +
                '<h3 style="margin:.4rem 0 .6rem">Aucune sélection</h3>' +
                '<p class="muted" style="font-size:.9rem">Cliquez sur un point de l\'arbre pour afficher sa fiche.' +
                (canAct ? ' Vous pourrez y verser vos PR et lancer les travaux.' : '') + '</p>' +
                (canAct && user && !user.hidden
                    ? '<p class="dim" style="margin-top:1rem">Votre réserve : <b>' + UI.number(user.points) + ' PR</b></p>'
                    : '');
            return;
        }

        var state = R.state(r);
        var cost = R.effectiveCost(r);
        var duration = R.effectiveDuration(r);
        var pct = cost ? Math.min(100, Math.round((r.invested / cost) * 100)) : 100;
        var tier = R.tierById(r.tierId);

        var html =
            '<div class="detail-head">' +
                '<div class="rcard-icon detail-icon">' + iconFor(r) + '</div>' +
                '<div><span class="mono dim" style="font-size:.72rem">' + esc(veil(r, r.code)) + '</span>' +
                '<h3' + (unreadable(r) ? ' class="is-veiled"' : '') + '>' + esc(displayName(r)) + '</h3></div>' +
            '</div>' +
            '<div class="tags">' + badges(r, state) + '</div>' +
            '<p class="desc' + (unreadable(r) ? ' is-veiled' : '') + '">' + esc(veil(r, r.description)) + '</p>' +
            '<dl class="facts">' +
                '<dt>Palier</dt><dd>' + esc(tier ? (tier.corrupted ? UI.glitch(tier.name, R.veilRatio(MODE)) : tier.name) : '—') + '</dd>' +
                '<dt>Équipe</dt><dd>' + esc(unreadable(r) ? '▒▒▒▒▒▒' : UI.teamLabel(r.branch || 'rd')) + '</dd>' +
                '<dt>Durée</dt><dd>' + factText(r, UI.duration(duration),
                    duration !== r.durationMinutes ? 'base ' + UI.duration(r.durationMinutes) : '') + '</dd>' +
                '<dt>Coût</dt><dd>' + factText(r, UI.number(cost) + ' PR',
                    cost !== r.costPoints ? 'base ' + UI.number(r.costPoints) : '') + '</dd>' +
                repeatFacts(r) +
            '</dl>';

        if (state === 'funding' || state === 'ready' || state === 'locked') {
            html += '<div class="progress"><i style="width:' + pct + '%"></i></div>' +
                '<div class="progress-line"><span>' + esc(veil(r, UI.number(r.invested) + ' / ' + UI.number(cost) + ' PR')) +
                '</span><span>' + esc(veil(r, pct + ' %')) + '</span></div>';
        }
        if (state === 'running') {
            html += '<div class="progress time"><i data-bar-time="' + r.id + '" style="width:' +
                Math.round(R.timeProgress(r) * 100) + '%"></i></div>' +
                '<div class="progress-line"><span>Fin des travaux</span><span data-countdown="' + r.id + '">' +
                UI.countdown(R.remainingMs(r)) + '</span></div>';
        }
        if (state !== 'done' && r.repeatable && R.times(r) > 0) {
            html += '<p class="dim" style="font-size:.82rem">Dernière répétition achevée le <b>' + UI.date(r.completedAt) + '</b></p>';
        }
        if (state === 'done') {
            html += '<p class="dim" style="font-size:.82rem">Achevée le <b>' + UI.date(r.completedAt) + '</b>' +
                (r.startedBy ? ' · pilotée par <b>' + esc(veil(r, r.startedBy)) + '</b>' : '') + '</p>';
        }

        var reqs = (r.requires || []).map(R.byId).filter(function (d) { return d && R.researchVisible(d, MODE); });
        if (reqs.length) {
            html += '<div class="detail-section"><h4>Prérequis</h4><div class="chip-list">' +
                reqs.map(function (d) {
                    var need = R.requiredCount(r, d.id), got = R.times(d), met = got >= need;
                    return '<button type="button" class="chip ' + (met ? 'ok' : 'warn') +
                        '" data-goto="' + d.id + '">' + (met ? '✓ ' : '✗ ') + esc(veil(d, d.code)) +
                        (need > 1 ? ' · ' + Math.min(got, need) + '/' + need : '') + '</button>';
                }).join('') + '</div></div>';
        }

        var unlocks = R.dependents(r.id).filter(function (d) { return R.researchVisible(d, MODE); });
        if (unlocks.length) {
            html += '<div class="detail-section"><h4>Débloque</h4><div class="chip-list">' +
                unlocks.map(function (d) {
                    return '<button type="button" class="chip" data-goto="' + d.id + '">' + esc(veil(d, d.code)) + '</button>';
                }).join('') + '</div></div>';
        }

        html += '<div class="detail-section rcard-actions">' + actions(r, state) + '</div>';
        host.innerHTML = html;
        bindActions(host, r.id);
    }

    /** Lignes « Répétitions », « Progression » et « Boost » de la fiche. */
    function repeatFacts(r) {
        if (unreadable(r)) return '';
        var html = '';
        if (r.repeatable) {
            html += '<dt>Répétitions</dt><dd>↻ ' + R.times(r) + (r.maxRepeats ? ' / ' + r.maxRepeats : ' <span class="dim">(illimitées)</span>') + '</dd>';
            var s = r.scaling || {};
            var parts = [];
            if (s.enabled && R.scalingEnabled()) {
                [['temps', 'durée'], ['cout', 'coût'], ['vitesse', 'vitesse de financement']].forEach(function (p) {
                    var v = Number(s[p[0]]) || 0;
                    if (v) parts.push((v > 0 ? '+' : '') + v + ' % ' + p[1]);
                });
            }
            if (parts.length) {
                html += '<dt>Progression</dt><dd>' + esc(parts.join(' · ')) + ' <span class="dim">par répétition</span></dd>';
            }
        }
        var b = r.boost;
        if (b && b.enabled && Number(b.value)) {
            html += '<dt>Boost</dt><dd>' + esc(R.effectText({ type: b.type, value: b.value })) + ' pendant ' +
                UI.duration(Number(b.hours) * 60) + (b.stack ? ' <span class="dim">(cumulable)</span>' : '') + '</dd>';
        }
        var ds = R.debuffState(r);
        if (ds) {
            var effect = esc(R.effectText({ type: ds.type, value: ds.type === 'rendement' ? -ds.value : ds.value }));
            html += '<dt>Malus</dt><dd>' + (ds.active
                ? '<span class="warn-text">Actif : ' + effect + '</span> <span class="dim">(max ' + r.debuff.max + ' %)</span>'
                : '<span class="dim">Se déclenche le ' + UI.date(ds.startsAt) + ' sans nouvel achèvement</span>') + '</dd>';
        }
        return html;
    }

    function actions(r, state) {
        if (unreadable(r)) {
            return '<span class="dim mono">' + esc(UI.glitch('Accès refusé : données instables', 0.3)) + '</span>';
        }
        var html = '';
        if ((state === 'done' || (r.repeatable && R.times(r) > 0)) && (r.report || r.corrupted)) {
            html += '<button class="btn btn-ghost btn-sm" type="button" data-report>Consulter le rapport</button>';
        }
        if (canAct && state === 'funding') {
            var missing = Math.max(0, R.effectiveCost(r) - r.invested);
            html += '<input type="number" min="1" max="' + missing + '" step="100" placeholder="PR" data-amount>' +
                '<button class="btn btn-sm" type="button" data-give>Verser</button>' +
                '<button class="btn btn-ghost btn-sm" type="button" data-give-max>Tout ce que je peux</button>';
        }
        if (canAct && state === 'ready') {
            html += '<button class="btn btn-sm" type="button" data-start>Lancer la recherche</button>';
        }
        if (state === 'locked') {
            html += '<span class="dim">Achevez d\'abord les prérequis.</span>';
        }
        return html;
    }

    function bindActions(scope, id) {
        var report = scope.querySelector('[data-report]');
        if (report) report.addEventListener('click', function () { openReport(id); });

        var give = scope.querySelector('[data-give]');
        if (give) give.addEventListener('click', function () {
            contribute(id, scope.querySelector('[data-amount]').value);
        });

        var giveMax = scope.querySelector('[data-give-max]');
        if (giveMax) giveMax.addEventListener('click', function () {
            var r = R.byId(id);
            var user = Auth.current();
            contribute(id, Math.min(R.effectiveCost(r) - r.invested, user ? user.points : 0));
        });

        var start = scope.querySelector('[data-start]');
        if (start) start.addEventListener('click', function () {
            var res = R.start(id);
            if (!res.ok) return UI.toast(res.error, 'error');
            UI.toast('Recherche lancée.', 'ok');
            redraw();
        });

        scope.querySelectorAll('[data-goto]').forEach(function (b) {
            b.addEventListener('click', function () { locate(b.getAttribute('data-goto')); });
        });
    }

    function locate(id) {
        if (view !== 'graph') setView('graph');
        graph.select(id);
        graph.focusOn(id);
    }

    function contribute(id, amount) {
        var res = R.contribute(id, amount);
        if (!res.ok) return UI.toast(res.error, 'error');
        UI.toast(res.funded
            ? 'Financement complet — la recherche peut être lancée.'
            : UI.number(res.spent) + ' PR versés.', 'ok');
        refreshHeaderPoints();
        redraw();
    }

    function openReport(id) {
        var r = R.byId(id);
        if (!r) return;
        var tier = R.tierById(r.tierId);
        var body =
            '<div class="file-note">' +
                'RÉFÉRENCE : ' + esc(veil(r, r.code)) + '<br>' +
                'PALIER : ' + esc(tier ? veil(r, tier.name) : '—') + '<br>' +
                'ÉQUIPE : ' + esc(UI.teamLabel(r.branch || 'rd')) + '<br>' +
                'CLÔTURE : ' + UI.date(r.completedAt) +
            '</div>' +
            '<p class="muted">' + esc(veil(r, r.description)) + '</p>' +
            '<h3 style="margin-top:1.4rem">Conclusions</h3>' +
            '<p style="margin-top:.6rem">' + esc(R.isCorrupted(r)
                ? UI.glitch(r.report || '…', Math.min(0.9, R.veilRatio(MODE) + 0.1))
                : (r.report || 'Aucun rapport rédigé.')) + '</p>';
        UI.modal(displayName(r), body);
    }

    /* ------------------------------------------------------------------
       Vue liste
       ------------------------------------------------------------------ */

    function renderList() {
        var host = root.querySelector('[data-list]');
        var html = '';

        R.tree(MODE).forEach(function (group) {
            var list = group.researches.filter(keep);
            if (!list.length && filtersActive()) return;
            var tierName = group.tier.corrupted ? UI.glitch(group.tier.name, R.veilRatio(MODE)) : group.tier.name;

            html += '<section class="tier' + (group.tier.corrupted ? ' is-corrupt' : '') + '">' +
                '<div class="tier-head"><h2>' + esc(tierName) + '</h2>' +
                    '<span class="badge">' + group.researches.filter(function (r) { return r.status === 'done'; }).length +
                    ' / ' + group.researches.length + ' achevées</span></div>' +
                (group.tier.description ? '<p class="tier-desc">' + esc(group.tier.corrupted
                    ? UI.glitch(group.tier.description, R.veilRatio(MODE)) : group.tier.description) + '</p>' : '') +
                '<div class="tier-body">' +
                (list.length ? list.map(card).join('') : '<p class="dim">Aucune entrée pour ce palier.</p>') +
                '</div></section>';
        });

        if (!html) {
            html = '<div class="panel"><h3>Aucun résultat</h3><p>' +
                (MODE === 'public'
                    ? 'Aucune recherche n\'a encore été publiée. Revenez après les prochains travaux.'
                    : 'Aucune recherche ne correspond aux filtres actifs.') + '</p></div>';
        }
        host.innerHTML = html;

        host.querySelectorAll('[data-r]').forEach(function (el) {
            var id = el.getAttribute('data-r');
            bindActions(el, id);
            var loc = el.querySelector('[data-locate]');
            if (loc) loc.addEventListener('click', function () { locate(id); });
        });
    }

    function card(r) {
        var state = R.state(r);
        var cost = R.effectiveCost(r);
        var pct = cost ? Math.min(100, Math.round((r.invested / cost) * 100)) : 100;
        var classes = ['rcard'];
        if (r.type === 'principale') classes.push('is-main');
        if (state === 'done') classes.push('is-done');
        if (state === 'running') classes.push('is-running');
        if (state === 'locked') classes.push('is-locked');
        if (R.isCorrupted(r)) classes.push('is-corrupt');
        var veiled = unreadable(r) ? ' is-veiled' : '';

        var html = '<article class="' + classes.join(' ') + '" data-r="' + r.id + '">' +
            '<div class="rcard-top">' +
                '<div class="rcard-icon">' + iconFor(r) + '</div>' +
                '<div class="rcard-title"><h3 class="' + veiled + '">' + esc(displayName(r)) + '</h3>' +
                '<span class="code">' + esc(veil(r, r.code)) + ' · ' +
                    esc(unreadable(r) ? '▒▒▒▒▒▒' : UI.teamLabel(r.branch || 'rd')) + '</span></div>' +
            '</div>' +
            '<div class="tags">' + badges(r, state) +
                '<span class="badge">⏱ ' + esc(veil(r, UI.duration(R.effectiveDuration(r)))) + '</span>' +
                '<span class="badge">◈ ' + esc(veil(r, UI.number(cost) + ' PR')) + '</span>' +
            '</div>' +
            '<p class="desc' + veiled + '">' + esc(veil(r, r.description)) + '</p>';

        if (state === 'funding' || state === 'ready' || state === 'locked') {
            html += '<div class="progress"><i style="width:' + pct + '%"></i></div>' +
                '<div class="progress-line"><span>' + esc(veil(r, UI.number(r.invested) + ' / ' + UI.number(cost) + ' PR')) +
                '</span><span>' + esc(veil(r, pct + ' %')) + '</span></div>';
        }
        if (state === 'running') {
            html += '<div class="progress time"><i data-bar-time="' + r.id + '" style="width:' +
                Math.round(R.timeProgress(r) * 100) + '%"></i></div>' +
                '<div class="progress-line"><span>Fin des travaux</span><span data-countdown="' + r.id + '">' +
                UI.countdown(R.remainingMs(r)) + '</span></div>';
        }

        html += '<div class="rcard-actions">' + actions(r, state) +
            '<button class="btn btn-ghost btn-sm" type="button" data-locate>Voir dans l\'arbre</button></div></article>';
        return html;
    }

    /* ------------------------------------------------------------------
       Boucle temps réel
       ------------------------------------------------------------------ */

    function redraw() {
        renderBar();
        renderEvents();
        if (view === 'graph' && graph) {
            graph.render();
            graph.setFilter(filtersActive() ? keep : null);
            renderDetail();
        } else {
            renderList();
        }
    }

    function loop() {
        var finished = R.tick();
        if (finished.length) {
            if (GOC.Remote) GOC.Remote.requestSync(); // le serveur clôture officiellement les travaux
            finished.filter(function (r) { return R.researchVisible(r, MODE); }).forEach(function (r) {
                UI.toast((r.repeatable ? 'Répétition n° ' + R.times(r) + ' achevée : ' : 'Recherche achevée : ') +
                    veil(r, r.code) + ' — ' + displayName(r), 'ok');
            });
            redraw();
            return;
        }
        if (graph && view === 'graph') graph.tick();
        root.querySelectorAll('[data-countdown]').forEach(function (el) {
            var r = R.byId(el.getAttribute('data-countdown'));
            if (r) el.textContent = UI.countdown(R.remainingMs(r));
        });
        root.querySelectorAll('[data-bar-time]').forEach(function (el) {
            var r = R.byId(el.getAttribute('data-bar-time'));
            if (r) el.style.width = Math.round(R.timeProgress(r) * 100) + '%';
        });
    }
});

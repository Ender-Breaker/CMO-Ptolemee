/* ==========================================================================
   GOC — Division PTOLÉMÉE · Arbre de recherche graphique (SVG)

   Chaque palier est une colonne. Chaque recherche est un point placé dans sa
   colonne (hexagone = principale, cercle = secondaire), relié à ses prérequis.

   GOC.Graph.create(host, {
       mode:      'public' | 'chercheur' | 'complet' | 'edit',
       onSelect:  function (sel)  // null | {type:'node', id} | {type:'edge', key, from, to}
       onChange:  function ()     // après une modification (mode edit)
       onCreateAt:function ({tierId, dx, y})  // double-clic dans le vide (mode edit)
       onOpen:    function (id)   // double-clic sur un point (mode edit)
       onOpenTier:function (tierId) // double-clic sur le titre d'un palier (mode edit)
       emptyText: string
   })

   En mode edit :
     - glisser un point      → le déplacer (changer de colonne = changer de palier)
     - tirer depuis le port ● → créer un prérequis vers le point relâché
     - cliquer un lien + Suppr → supprimer le lien
     - tirer un bord de zone   → redimensionner le palier (double-clic sur le bord : ajuster)
   ========================================================================== */

(function () {
    'use strict';

    var R = GOC.Research, UI = GOC.UI;
    var esc = UI.escape;
    var R_MAIN = 30, R_SEC = 21;
    var GRID = 10;
    var K_MIN = 0.06, K_MAX = 2.2;
    var LABEL_MAX = 32, LINE_H = 14;
    var HANDLE = 12;
    var instances = 0;

    function hexPoints(rad) {
        var pts = [];
        for (var i = 0; i < 6; i++) {
            var a = Math.PI / 180 * (60 * i - 90);
            pts.push((rad * Math.cos(a)).toFixed(1) + ',' + (rad * Math.sin(a)).toFixed(1));
        }
        return pts.join(' ');
    }

    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    function dist(a, b) { return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2)); }
    function snap(v) { return Math.round(v / GRID) * GRID; }

    /** Découpe un nom sur deux lignes : désignation puis « surnom », sinon au mot. */
    function labelLines(name) {
        var text = String(name || '');
        var nick = /^(.*\S)\s*(«.*»)\s*$/.exec(text);
        var lines;
        if (nick) {
            lines = [nick[1], nick[2]];
        } else if (text.length <= LABEL_MAX) {
            lines = [text];
        } else {
            var words = text.split(' ');
            var first = words.shift();
            while (words.length && (first + ' ' + words[0]).length <= LABEL_MAX) first += ' ' + words.shift();
            lines = words.length ? [first, words.join(' ')] : [first];
        }
        return lines.map(function (l) {
            return l.length > LABEL_MAX ? l.slice(0, LABEL_MAX - 1) + '…' : l;
        });
    }

    function create(host, opts) {
        opts = opts || {};
        var mode = opts.mode || 'chercheur';
        var editable = mode === 'edit';
        var uid = 'g' + (++instances);
        var view = { x: 0, y: 0, k: 1 };
        var selection = { node: null, edge: null };
        var filter = null;
        var dragPos = {};
        var gesture = null;
        var pointers = {};
        var fitted = false;
        var lastBoxes = {};

        host.classList.add('graph');
        if (editable) host.classList.add('graph-edit');
        host.classList.add('graph-mode-' + mode);
        host.innerHTML =
            '<svg class="graph-svg" tabindex="0" aria-label="Arbre de recherche">' +
                '<defs>' +
                    marker(uid + '-arrow', 'g-arrow') +
                    marker(uid + '-arrow-done', 'g-arrow is-done') +
                    '<clipPath id="' + uid + '-clip" clipPathUnits="objectBoundingBox">' +
                        '<circle cx=".5" cy=".5" r=".5"/></clipPath>' +
                '</defs>' +
                '<g class="g-view">' +
                    '<g class="g-bands"></g><g class="g-edges"></g><g class="g-nodes"></g>' +
                    '<path class="g-preview" d=""/>' +
                '</g>' +
            '</svg>' +
            '<nav class="graph-tiers" aria-label="Aller au palier" hidden></nav>' +
            '<div class="graph-tools">' +
                '<button type="button" data-z="in" aria-label="Zoomer" title="Zoomer (+)">+</button>' +
                '<button type="button" data-z="out" aria-label="Dézoomer" title="Dézoomer (−)">−</button>' +
                '<button type="button" data-z="fit" aria-label="Tout voir" title="Tout voir (0)">⤢</button>' +
                '<button type="button" data-z="map" aria-label="Mini-carte" title="Mini-carte" aria-pressed="false">▦</button>' +
                '<button type="button" data-z="full" aria-label="Plein écran" title="Plein écran">⛶</button>' +
                '<button type="button" data-z="help" aria-label="Commandes" title="Commandes">?</button>' +
            '</div>' +
            '<svg class="graph-minimap" aria-hidden="true" hidden><g class="mm-content"></g><rect class="mm-view"/></svg>' +
            '<div class="graph-peek" aria-live="polite" hidden></div>' +
            '<div class="graph-help" role="dialog" aria-label="Commandes de l\'arbre" hidden></div>' +
            '<div class="graph-pad" hidden>🎮 Manette détectée</div>' +
            '<div class="graph-empty" hidden></div>';

        var svg = host.querySelector('svg');
        var gView = host.querySelector('.g-view');
        var gBands = host.querySelector('.g-bands');
        var gEdges = host.querySelector('.g-edges');
        var gNodes = host.querySelector('.g-nodes');
        var preview = host.querySelector('.g-preview');
        var empty = host.querySelector('.graph-empty');

        function marker(id, cls) {
            return '<marker id="' + id + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" ' +
                'markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="' + cls + '"/></marker>';
        }

        /* ------------------------------------------------------------------
           Géométrie
           ------------------------------------------------------------------ */

        function column(tierId) {
            var cols = R.layout();
            for (var i = 0; i < cols.length; i++) if (cols[i].tier.id === tierId) return cols[i];
            return cols[0] || { x: 0, width: R.LANE_W };
        }

        function pos(r) {
            if (dragPos[r.id]) return dragPos[r.id];
            var col = column(r.tierId);
            return { x: col.x + (r.dx == null ? col.width / 2 : r.dx), y: r.y || 0 };
        }

        function radius(r) { return r.type === 'principale' ? R_MAIN : R_SEC; }

        function visible() {
            return R.all().filter(function (r) { return R.researchVisible(r, mode); });
        }

        /** Emprise verticale des points, ou null. */
        function nodeExtent(list) {
            if (!list.length) return null;
            var minY = Infinity, maxY = -Infinity;
            list.forEach(function (r) {
                var p = pos(r);
                minY = Math.min(minY, p.y);
                maxY = Math.max(maxY, p.y);
            });
            return { minY: minY, maxY: maxY };
        }

        /** Zones de palier affichées : [{col, index, top, bottom}].
         *  Une zone suit sa taille enregistrée, mais s'agrandit toujours pour contenir ses points. */
        function bandBoxes(list) {
            var ext = nodeExtent(list);
            var gTop = Math.min(ext ? ext.minY - 110 : -220, -220);
            var gBottom = Math.max(ext ? ext.maxY + 90 : 220, 220);
            var boxes = [];
            R.layout().forEach(function (col, i) {
                var t = col.tier;
                if (!R.tierVisible(t, mode)) return;
                var own = list.filter(function (r) { return r.tierId === t.id; });
                if (mode === 'public' && !own.length) return;
                var top = t.top != null ? t.top : gTop;
                var bottom = t.bottom != null ? t.bottom : gBottom;
                var e = nodeExtent(own);
                if (e) {
                    top = Math.min(top, e.minY - 110);
                    bottom = Math.max(bottom, e.maxY + 90);
                }
                boxes.push({ col: col, index: i, top: top, bottom: bottom });
            });
            return boxes;
        }

        function bounds(list) {
            var boxes = bandBoxes(list);
            if (!boxes.length) return { minX: 0, maxX: R.LANE_W, minY: -220, maxY: 220 };
            var b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
            boxes.forEach(function (box) {
                b.minX = Math.min(b.minX, box.col.x);
                b.maxX = Math.max(b.maxX, box.col.x + box.col.width);
                b.minY = Math.min(b.minY, box.top);
                b.maxY = Math.max(b.maxY, box.bottom);
            });
            return b;
        }

        function edgePath(a, b) {
            var p = pos(a), q = pos(b);
            var ra = radius(a) + 9, rb = radius(b) + 12;
            var dx = q.x - p.x, dy = q.y - p.y;
            if (dx > ra + rb + 20) {
                var sx = p.x + ra, ex = q.x - rb;
                var c = (ex - sx) * 0.45;
                return 'M' + sx + ' ' + p.y + ' C' + (sx + c) + ' ' + p.y + ' ' + (ex - c) + ' ' + q.y + ' ' + ex + ' ' + q.y;
            }
            var len = Math.sqrt(dx * dx + dy * dy) || 1;
            return 'M' + (p.x + dx / len * ra).toFixed(1) + ' ' + (p.y + dy / len * ra).toFixed(1) +
                ' L' + (q.x - dx / len * rb).toFixed(1) + ' ' + (q.y - dy / len * rb).toFixed(1);
        }

        /* ------------------------------------------------------------------
           Rendu
           ------------------------------------------------------------------ */

        function render() {
            var list = visible();
            renderBands(list);
            renderEdges(list);
            gNodes.innerHTML = list.map(nodeMarkup).join('');
            applyFilter();
            syncSelection();

            empty.hidden = list.length > 0;
            empty.textContent = opts.emptyText || 'Aucune recherche à afficher.';
            if (!fitted) initialView();
            scaleTitles();
            renderTierBar(list);
            renderMinimap(list);
        }

        function renderBands(list) {
            lastBoxes = {};
            gBands.innerHTML = bandBoxes(list).map(function (box) {
                var col = box.col, t = col.tier, top = box.top, bottom = box.bottom;
                var x0 = col.x + 8, x1 = col.x + col.width - 8;
                var title = t.corrupted && !editable ? veil(t.name, R.veilRatio(mode) * 0.8) : t.name;
                var tid = ' data-tier="' + t.id + '"';
                lastBoxes[t.id] = { width: col.width, top: top, bottom: bottom };

                var extra = '';
                if (editable) {
                    // Repères des colonnes internes, pour placer proprement.
                    for (var lx = col.x + R.LANE_W; lx < col.x + col.width - 40; lx += R.LANE_W) {
                        extra += '<line class="lane-sep" x1="' + lx + '" y1="' + (top + 48) + '" x2="' + lx +
                            '" y2="' + (bottom - 12) + '"/>';
                    }
                    extra +=
                        '<rect class="band-head"' + tid + ' x="' + x0 + '" y="' + top + '" width="' + (x1 - x0) + '" height="46"/>' +
                        '<rect class="band-grip" x="' + (x1 - 3) + '" y="' + ((top + bottom) / 2 - 22) + '" width="6" height="44" rx="3"/>' +
                        handle('n', x0, top - HANDLE / 2, x1 - x0, HANDLE) +
                        handle('s', x0, bottom - HANDLE / 2, x1 - x0, HANDLE) +
                        handle('e', x1 - HANDLE / 2, top, HANDLE, bottom - top) +
                        handle('se', x1 - HANDLE, bottom - HANDLE, HANDLE * 2, HANDLE * 2);
                }

                return '<g class="band' + (t.corrupted ? ' is-corrupt' : '') + '" data-col="' + box.index + '">' +
                    '<rect class="band-zone" x="' + x0 + '" y="' + top + '" width="' + (x1 - x0) + '" height="' +
                        (bottom - top) + '" rx="14"/>' + extra +
                    '<text class="band-title" data-top="' + top + '" x="' + (col.x + col.width / 2) + '" y="' + (top + 30) + '">' + esc(title) + '</text>' +
                    '</g>';

                function handle(dir, x, y, w, h) {
                    return '<rect class="band-handle h-' + dir + '" data-handle="' + dir + '"' + tid +
                        ' x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '"/>';
                }
            }).join('');
        }

        function renderEdges(list) {
            var shown = {};
            list.forEach(function (r) { shown[r.id] = true; });
            var html = '';
            list.forEach(function (r) {
                (r.requires || []).forEach(function (depId) {
                    if (!shown[depId]) return;
                    var dep = R.byId(depId);
                    var key = depId + '>' + r.id;
                    var need = R.requiredCount(r, depId);
                    var got = R.times(dep);
                    var done = got >= need;
                    var d = edgePath(dep, r);

                    // Exigence de plusieurs achèvements : compteur au milieu du lien.
                    var counter = '';
                    if (need > 1) {
                        var a = pos(dep), b = pos(r);
                        var label = Math.min(got, need) + '/' + need;
                        var w = 16 + label.length * 6.5;
                        counter = '<g class="g-edge-count' + (done ? ' is-met' : '') + '" transform="translate(' +
                                ((a.x + b.x) / 2).toFixed(1) + ' ' + ((a.y + b.y) / 2).toFixed(1) + ')">' +
                            '<rect x="' + (-w / 2).toFixed(1) + '" y="-10" width="' + w.toFixed(1) + '" height="20" rx="10"/>' +
                            '<text dy="0.35em">' + label + '</text></g>';
                    }

                    html += '<g class="g-edge' + (done ? ' is-done' : '') + '" data-edge="' + key + '">' +
                        (editable ? '<path class="g-edge-hit" d="' + d + '"/>' : '') +
                        '<path class="g-edge-line" d="' + d + '" marker-end="url(#' + uid +
                            (done ? '-arrow-done' : '-arrow') + ')"/>' + counter + '</g>';
                });
            });
            gEdges.innerHTML = html;
        }

        function nodeMarkup(r) {
            var p = pos(r);
            var rad = radius(r);
            var main = r.type === 'principale';
            var state = R.state(r);
            var ring = rad + 7;
            var circ = 2 * Math.PI * ring;
            var prog = R.ringProgress(r);
            var cls = ['gnode', 'st-' + state];
            if (main) cls.push('is-main');
            var hidden = R.isCorrupted(r) && !editable;
            var unreadable = hidden && mode === 'chercheur'; // au laboratoire : ni icône ni équipe
            if (R.isCorrupted(r)) cls.push('is-corrupt');
            var neglect = R.debuffState(r);
            if (neglect && neglect.active) cls.push('is-neglected');

            var body = main
                ? '<polygon class="g-body" points="' + hexPoints(rad + 3) + '"/>'
                : '<circle class="g-body" r="' + rad + '"/>';

            var inner = rad * 0.62;
            var icon = r.iconType === 'image' && r.icon && !unreadable
                ? '<image href="' + esc(r.icon) + '" x="' + (-inner) + '" y="' + (-inner) + '" width="' +
                    (inner * 2) + '" height="' + (inner * 2) + '" preserveAspectRatio="xMidYMid slice" ' +
                    'clip-path="url(#' + uid + '-clip)"/>'
                : (window.GOC && window.GOC.Icons
                    ? window.GOC.Icons.svg(unreadable ? '▓' : r.icon, main ? 26 : 19)
                    : '<text class="g-icon" font-size="' + (main ? 22 : 16) + '">' +
                        esc(unreadable ? '▓' : (r.icon || '?')) + '</text>');

            var lines = labelLines(hidden ? veil(r.name) : r.name);
            var team = unreadable ? '▒▒' : (r.branch === 'qm' ? 'QM' : 'R&D');

            return '<g class="' + cls.join(' ') + '" data-id="' + r.id + '" transform="translate(' + p.x + ' ' + p.y + ')">' +
                '<circle class="g-halo" r="' + (ring + 7) + '"/>' +
                '<circle class="g-track" r="' + ring + '"/>' +
                '<circle class="g-prog" r="' + ring + '" transform="rotate(-90)" stroke-dasharray="' +
                    (circ * prog).toFixed(1) + ' ' + circ.toFixed(1) + '" visibility="' + (prog > 0 ? 'visible' : 'hidden') + '"/>' +
                body + icon +
                lines.map(function (line, i) {
                    return '<text class="g-label" y="' + (ring + 18 + i * LINE_H) + '">' + esc(line) + '</text>';
                }).join('') +
                '<text class="g-code" y="' + (ring + 17 + lines.length * LINE_H) + '">' + esc(hidden ? veil(r.code) : r.code) + ' · ' + team + '</text>' +
                (r.repeatable ? repeatBadge(r, ring) : '') +
                (editable ? '<circle class="g-port" cx="' + ring + '" cy="0" r="7"/>' : '') +
                '</g>';
        }

        /** Pastille « ↻ n » en haut à gauche d'une recherche répétable. */
        function repeatBadge(r, ring) {
            var times = R.times(r);
            var label = '↻' + (times > 999 ? '999+' : times) + (r.maxRepeats ? '/' + r.maxRepeats : '');
            var w = 12 + label.length * 6.5;
            return '<g class="g-repeat" transform="translate(' + (-ring + 2) + ' ' + (-ring + 2) + ')">' +
                '<rect x="' + (-w / 2).toFixed(1) + '" y="-9" width="' + w.toFixed(1) + '" height="18" rx="9"/>' +
                '<text dy="0.35em">' + label + '</text></g>';
        }

        function applyFilter() {
            gNodes.querySelectorAll('.gnode').forEach(function (el) {
                var r = R.byId(el.getAttribute('data-id'));
                el.classList.toggle('is-dim', !!(filter && r && !filter(r)));
            });
        }

        function syncSelection() {
            // Chemin d'accès : tous les prérequis, directs et indirects, du point sélectionné.
            var sel = selection.node;
            var path = {}, next = {};
            if (sel) {
                (function up(id) {
                    if (path[id]) return;
                    path[id] = true;
                    var r = R.byId(id);
                    if (r) (r.requires || []).forEach(up);
                })(sel);
                R.dependents(sel).forEach(function (d) { next[d.id] = true; });
            }
            host.classList.toggle('has-focus', !!sel && !editable);
            gNodes.querySelectorAll('.gnode').forEach(function (el) {
                var id = el.getAttribute('data-id');
                el.classList.toggle('is-selected', id === sel);
                el.classList.toggle('is-path', !!path[id] && id !== sel);
                el.classList.toggle('is-next', !!next[id]);
            });
            gEdges.querySelectorAll('.g-edge').forEach(function (el) {
                var key = el.getAttribute('data-edge');
                var parts = key.split('>');
                el.classList.toggle('is-selected', key === selection.edge);
                el.classList.toggle('is-path', !!sel && !!path[parts[0]] && !!path[parts[1]]);
                el.classList.toggle('is-related', !!sel && parts[0] === sel);
            });
            updatePeek();
        }

        /** Mise à jour légère, appelée chaque seconde : anneaux et libellés altérés. */
        function tick() {
            gNodes.querySelectorAll('.gnode.st-running').forEach(function (el) {
                var r = R.byId(el.getAttribute('data-id'));
                if (!r) return;
                var circ = 2 * Math.PI * (radius(r) + 7);
                var c = el.querySelector('.g-prog');
                c.setAttribute('stroke-dasharray', (circ * R.ringProgress(r)).toFixed(1) + ' ' + circ.toFixed(1));
                c.setAttribute('visibility', 'visible');
            });
            if (!editable) scrambleCorrupt();
        }

        /* ------------------------------------------------------------------
           Vue : déplacement et zoom
           ------------------------------------------------------------------ */

        var anim = null;
        var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

        function viewport() {
            var rect = svg.getBoundingClientRect();
            return { w: rect.width, h: rect.height };
        }

        function applyView() {
            gView.setAttribute('transform', 'translate(' + view.x.toFixed(1) + ' ' + view.y.toFixed(1) +
                ') scale(' + view.k.toFixed(3) + ')');
            var s = 40 * view.k;
            host.style.backgroundSize = s + 'px ' + s + 'px';
            host.style.backgroundPosition = view.x.toFixed(1) + 'px ' + view.y.toFixed(1) + 'px';
            // Niveau de détail : on allège l'affichage quand on s'éloigne.
            host.classList.toggle('zoom-mid', view.k < 0.55);
            host.classList.toggle('zoom-far', view.k < 0.3);
            scaleTitles();
            if (onViewChange) onViewChange();
        }
        var onViewChange = null;

        /** Titres de palier lisibles à toute distance : leur taille compense le zoom. */
        function scaleTitles() {
            var size = Math.min(64, Math.max(11, 13 / view.k));
            gBands.querySelectorAll('.band-title').forEach(function (t) {
                t.style.fontSize = size.toFixed(1) + 'px';
                t.setAttribute('y', (Number(t.getAttribute('data-top')) + 14 + size * 0.8).toFixed(1));
            });
        }

        function stopAnim() {
            if (anim) cancelAnimationFrame(anim.raf);
            anim = null;
        }

        /** Place la vue sur une cible, avec une transition douce si demandé. */
        function moveTo(target, smooth) {
            stopAnim();
            if (!smooth || reduceMotion) {
                view.x = target.x;
                view.y = target.y;
                view.k = target.k;
                applyView();
                return;
            }
            var from = { x: view.x, y: view.y, k: view.k };
            var t0 = Date.now(), duration = 320;
            anim = {};
            (function step() {
                var t = Math.min(1, (Date.now() - t0) / duration);
                var e = 1 - Math.pow(1 - t, 3);
                view.x = from.x + (target.x - from.x) * e;
                view.y = from.y + (target.y - from.y) * e;
                view.k = from.k + (target.k - from.k) * e;
                applyView();
                if (t < 1 && anim) anim.raf = requestAnimationFrame(step);
                else anim = null;
            })();
        }

        function zoomAt(factor, sx, sy, smooth) {
            var k2 = clamp(view.k * factor, K_MIN, K_MAX);
            moveTo({ x: sx - (sx - view.x) * (k2 / view.k), y: sy - (sy - view.y) * (k2 / view.k), k: k2 }, smooth);
        }

        /** Cadre une zone du monde {minX, maxX, minY, maxY}. Renvoie le zoom obtenu. */
        function frame(b, smooth, maxK) {
            var vp = viewport();
            if (!vp.w || !vp.h) return 0;
            var pad = vp.w < 600 ? 20 : 48;
            var k = clamp(Math.min((vp.w - pad * 2) / (b.maxX - b.minX), (vp.h - pad * 2) / (b.maxY - b.minY),
                maxK || 1.1), K_MIN, K_MAX);
            moveTo({ k: k, x: vp.w / 2 - (b.minX + b.maxX) / 2 * k, y: vp.h / 2 - (b.minY + b.maxY) / 2 * k }, smooth);
            return k;
        }

        function fit(smooth) {
            if (frame(bounds(visible()), smooth)) fitted = true;
        }

        /** Cadre un palier. S'il est trop grand pour rester lisible, on montre son coin supérieur gauche. */
        function focusTier(tierId, smooth) {
            var box = bandBoxes(visible()).filter(function (b) { return b.col.tier.id === tierId; })[0];
            var vp = viewport();
            if (!box || !vp.w) return;
            var b = { minX: box.col.x, maxX: box.col.x + box.col.width, minY: box.top, maxY: box.bottom };
            if (Math.min(vp.w / (b.maxX - b.minX), vp.h / (b.maxY - b.minY)) >= 0.5) {
                frame(b, smooth, 1);
                return;
            }
            var k = 0.65;
            moveTo({ k: k, x: 16 - b.minX * k, y: 16 - b.minY * k }, smooth);
        }

        /** Première vue : l'arbre entier s'il reste lisible, sinon le palier en cours. */
        function initialView() {
            var list = visible();
            var vp = viewport();
            if (!vp.w || !vp.h) return;
            fitted = true;
            var all = bounds(list);
            if (Math.min(vp.w / (all.maxX - all.minX), vp.h / (all.maxY - all.minY)) >= 0.3 || !list.length) {
                frame(all);
                return;
            }
            var frontier = list.filter(function (r) {
                var s = R.state(r);
                return s === 'funding' || s === 'ready' || s === 'running';
            })[0] || list[list.length - 1];
            focusTier(frontier.tierId, false);
        }

        function focusOn(id, smooth) {
            var r = R.byId(id);
            var vp = viewport();
            if (!r || !vp.w) return;
            var p = pos(r);
            var k = Math.max(view.k, 0.75);
            moveTo({ k: k, x: vp.w / 2 - p.x * k, y: vp.h / 2 - p.y * k }, smooth !== false);
        }

        function toWorld(clientX, clientY) {
            var rect = svg.getBoundingClientRect();
            return { x: (clientX - rect.left - view.x) / view.k, y: (clientY - rect.top - view.y) / view.k };
        }

        function nodeAt(clientX, clientY) {
            var el = document.elementFromPoint(clientX, clientY);
            var node = el && el.closest ? el.closest('.gnode') : null;
            return node && host.contains(node) ? node.getAttribute('data-id') : null;
        }

        /** Palier situé sous une abscisse monde (bornée au premier / dernier palier). */
        function columnAt(worldX) {
            var cols = R.layout();
            if (!cols.length) return { index: 0, tier: null, x: 0, width: R.LANE_W, dx: R.LANE_W / 2 };
            var idx = cols.length - 1;
            for (var i = 0; i < cols.length; i++) {
                if (worldX < cols[i].x + cols[i].width) { idx = i; break; }
            }
            var c = cols[idx];
            return { index: idx, tier: c.tier, x: c.x, width: c.width, dx: clamp(worldX - c.x, 40, c.width - 40) };
        }

        /* ------------------------------------------------------------------
           Sélection
           ------------------------------------------------------------------ */

        function select(id) {
            selection.node = id || null;
            selection.edge = null;
            syncSelection();
            if (opts.onSelect) opts.onSelect(id ? { type: 'node', id: id } : null);
        }

        function selectEdge(key) {
            var parts = key.split('>');
            selection.node = null;
            selection.edge = key;
            syncSelection();
            if (opts.onSelect) opts.onSelect({ type: 'edge', key: key, from: parts[0], to: parts[1] });
        }

        function changed() {
            render();
            if (opts.onChange) opts.onChange();
        }

        /* ------------------------------------------------------------------
           Gestes
           ------------------------------------------------------------------ */

        svg.addEventListener('pointerdown', function (e) {
            if (e.button > 0) return;
            stopAnim();
            lastPointerType = e.pointerType || 'mouse';
            pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
            try { svg.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
            try { svg.focus({ preventScroll: true }); } catch (err) { /* noop */ }

            var ids = Object.keys(pointers);
            if (ids.length === 2) {
                var a = pointers[ids[0]], b = pointers[ids[1]];
                var rect = svg.getBoundingClientRect();
                gesture = {
                    type: 'pinch', d0: dist(a, b) || 1, k0: view.k, x0: view.x, y0: view.y,
                    cx: (a.x + b.x) / 2 - rect.left, cy: (a.y + b.y) / 2 - rect.top
                };
                return;
            }

            var target = e.target;
            if (editable && target.classList && target.classList.contains('band-handle')) {
                var tid = target.getAttribute('data-tier');
                var tier = R.tierById(tid);
                var box = lastBoxes[tid];
                if (tier && box) {
                    gesture = {
                        type: 'resize', tierId: tid, handle: target.getAttribute('data-handle'),
                        sx: e.clientX, sy: e.clientY, moved: false,
                        saved: { width: tier.width, span: tier.span, top: tier.top, bottom: tier.bottom },
                        w0: box.width, top0: box.top, bottom0: box.bottom, lim: R.tierLimits(tid)
                    };
                    svg.classList.add('is-resizing');
                    e.preventDefault();
                    return;
                }
            }
            var nodeEl = target.closest ? target.closest('.gnode') : null;

            if (editable && nodeEl && target.classList.contains('g-port')) {
                gesture = { type: 'link', from: nodeEl.getAttribute('data-id') };
                e.preventDefault();
                return;
            }
            if (nodeEl) {
                var r = R.byId(nodeEl.getAttribute('data-id'));
                gesture = { type: 'node', id: r.id, sx: e.clientX, sy: e.clientY, moved: false, origin: pos(r), el: nodeEl };
                return;
            }
            var edgeEl = target.closest ? target.closest('.g-edge') : null;
            if (editable && edgeEl) {
                gesture = { type: 'edge', key: edgeEl.getAttribute('data-edge') };
                return;
            }
            gesture = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
            svg.classList.add('is-panning');
        });

        svg.addEventListener('pointermove', function (e) {
            if (pointers[e.pointerId]) pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
            if (!gesture) return;
            var g = gesture;

            if (g.type === 'pinch') {
                var ids = Object.keys(pointers);
                if (ids.length < 2) return;
                var k2 = clamp(g.k0 * dist(pointers[ids[0]], pointers[ids[1]]) / g.d0, K_MIN, K_MAX);
                view.x = g.cx - (g.cx - g.x0) * (k2 / g.k0);
                view.y = g.cy - (g.cy - g.y0) * (k2 / g.k0);
                view.k = k2;
                applyView();
                return;
            }

            if (g.type === 'resize') {
                // Aperçu en direct : la taille n'est enregistrée qu'au relâchement.
                var t = R.tierById(g.tierId);
                if (!t) return;
                var ddx = (e.clientX - g.sx) / view.k, ddy = (e.clientY - g.sy) / view.k;
                if (Math.abs(ddx) + Math.abs(ddy) > 2) g.moved = true;
                if (g.handle === 'e' || g.handle === 'se') {
                    t.width = Math.max(g.lim.minWidth, snap(g.w0 + ddx));
                }
                if (g.handle === 'n') {
                    var top = Math.min(snap(g.top0 + ddy), g.bottom0 - R.MIN_TIER_H);
                    t.top = g.lim.maxTop == null ? top : Math.min(top, g.lim.maxTop);
                }
                if (g.handle === 's' || g.handle === 'se') {
                    var bottom = Math.max(snap(g.bottom0 + ddy), g.top0 + R.MIN_TIER_H);
                    t.bottom = g.lim.minBottom == null ? bottom : Math.max(bottom, g.lim.minBottom);
                }
                render();
                return;
            }

            if (g.type === 'pan') {
                var dx = e.clientX - g.sx, dy = e.clientY - g.sy;
                if (Math.abs(dx) + Math.abs(dy) > 3) g.moved = true;
                view.x = g.vx + dx;
                view.y = g.vy + dy;
                applyView();
                return;
            }

            if (g.type === 'node') {
                var mx = e.clientX - g.sx, my = e.clientY - g.sy;
                if (!g.moved && Math.abs(mx) + Math.abs(my) > 4) g.moved = true;
                if (!g.moved) return;
                if (!editable) {
                    // Hors édition, glisser depuis un point déplace simplement la vue.
                    gesture = { type: 'pan', sx: g.sx, sy: g.sy, vx: view.x, vy: view.y, moved: true };
                    svg.classList.add('is-panning');
                    return;
                }
                var np = {
                    x: Math.round((g.origin.x + mx / view.k) / GRID) * GRID,
                    y: Math.round((g.origin.y + my / view.k) / GRID) * GRID
                };
                dragPos[g.id] = np;
                g.el.setAttribute('transform', 'translate(' + np.x + ' ' + np.y + ')');
                renderEdges(visible());
                syncSelection();
                var col = columnAt(np.x).index;
                gBands.querySelectorAll('.band').forEach(function (band) {
                    band.classList.toggle('is-target', Number(band.getAttribute('data-col')) === col);
                });
                return;
            }

            if (g.type === 'link') {
                var from = R.byId(g.from);
                var p = pos(from);
                var w = toWorld(e.clientX, e.clientY);
                preview.setAttribute('d', 'M' + (p.x + radius(from) + 7) + ' ' + p.y + ' L' + w.x.toFixed(1) + ' ' + w.y.toFixed(1));
                var over = nodeAt(e.clientX, e.clientY);
                gNodes.querySelectorAll('.gnode').forEach(function (el) {
                    el.classList.toggle('is-link-target', !!over && over !== g.from && el.getAttribute('data-id') === over);
                });
            }
        });

        function endGesture(e) {
            delete pointers[e.pointerId];
            svg.classList.remove('is-panning');
            if (!gesture) return;
            var g = gesture;
            gesture = null;

            if (g.type === 'pinch') return;
            if (g.type === 'resize') {
                svg.classList.remove('is-resizing');
                commitResize(g, e.type === 'pointerup');
                return;
            }
            if (g.type === 'pan') {
                if (!g.moved && e.type === 'pointerup') handleTap(e);
                return;
            }
            if (g.type === 'edge') {
                selectEdge(g.key);
                return;
            }
            if (g.type === 'node') {
                if (!g.moved) { select(g.id); return; }
                if (editable) commitMove(g.id);
                return;
            }
            if (g.type === 'link') {
                preview.setAttribute('d', '');
                gNodes.querySelectorAll('.is-link-target').forEach(function (el) { el.classList.remove('is-link-target'); });
                var target = e.type === 'pointerup' ? nodeAt(e.clientX, e.clientY) : null;
                if (target && target !== g.from) {
                    var res = R.link(g.from, target);
                    if (!res.ok) UI.toast(res.error, 'error');
                    else { UI.toast('Prérequis ajouté.', 'ok'); changed(); }
                }
            }
        }

        svg.addEventListener('pointerup', endGesture);
        svg.addEventListener('pointercancel', endGesture);

        function commitMove(id) {
            var p = dragPos[id];
            delete dragPos[id];
            gBands.querySelectorAll('.is-target').forEach(function (b) { b.classList.remove('is-target'); });
            var col = p ? columnAt(p.x) : null;
            if (!col || !col.tier) { render(); return; }
            var res = R.setPosition(id, col.tier.id, col.dx, p.y);
            if (res.tierChanged) UI.toast('Déplacée vers « ' + col.tier.name + ' ».', 'ok');
            changed();
        }

        /** Le glisser n'a modifié le palier qu'en aperçu : on restaure, puis on
         *  enregistre par le moteur pour appliquer les bornes et journaliser. */
        function commitResize(g, keep) {
            var t = R.tierById(g.tierId);
            if (!t) return;
            var next = { width: t.width, top: t.top, bottom: t.bottom };
            ['width', 'span', 'top', 'bottom'].forEach(function (k) {
                if (g.saved[k] === undefined) delete t[k];
                else t[k] = g.saved[k];
            });
            if (!keep || !g.moved) {
                render();
                return;
            }
            var box = {};
            if (g.handle === 'e' || g.handle === 'se') box.width = next.width;
            if (g.handle === 'n') box.top = next.top;
            if (g.handle === 's' || g.handle === 'se') box.bottom = next.bottom;
            R.setTierBox(g.tierId, box);
            changed();
        }

        /** Double-clic sur un bord : largeur ajustée au contenu, ou hauteur automatique. */
        function fitTier(tierId, handle) {
            if (!R.tierById(tierId)) return;
            if (handle === 'e') {
                R.setTierBox(tierId, { width: R.tierLimits(tierId).minWidth });
                UI.toast('Largeur ajustée au contenu.', 'ok');
            } else {
                R.setTierBox(tierId, { top: null, bottom: null });
                UI.toast('Hauteur automatique rétablie.', 'ok');
            }
            changed();
        }

        /* Molette et pavé tactile.
           - Ctrl + molette, ou pincement sur pavé tactile (émis avec ctrlKey) : zoom progressif ;
           - défilement à deux doigts sur pavé tactile (petits pas, souvent horizontaux) : déplacement ;
           - molette de souris (grands pas verticaux) : zoom par crans. Maj + molette : déplacement horizontal. */
        var lastTouchpad = 0;
        svg.addEventListener('wheel', function (e) {
            e.preventDefault();
            stopAnim();
            var rect = svg.getBoundingClientRect();
            var sx = e.clientX - rect.left, sy = e.clientY - rect.top;
            var unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
            var dx = e.deltaX * unit, dy = e.deltaY * unit;

            if (e.ctrlKey || e.metaKey) {
                zoomAt(Math.exp(-clamp(dy, -60, 60) * 0.01), sx, sy);
                return;
            }
            var now = Date.now();
            var touchpadLike = e.deltaMode === 0 && (dx !== 0 || Math.abs(dy) < 40 || dy % 1 !== 0);
            if (touchpadLike) lastTouchpad = now;
            if (touchpadLike || now - lastTouchpad < 250) {
                view.x -= dx;
                view.y -= dy;
                applyView();
                return;
            }
            if (e.shiftKey) {
                view.x -= dy;
                applyView();
                return;
            }
            zoomAt(dy < 0 ? 1.15 : 1 / 1.15, sx, sy);
        }, { passive: false });

        svg.addEventListener('dblclick', function (e) {
            if (!editable) {
                // Double-clic dans le vide : zoom sur ce point (le double-toucher est géré à part).
                if (lastPointerType !== 'touch' && !nodeAt(e.clientX, e.clientY)) {
                    var rect = svg.getBoundingClientRect();
                    zoomAt(1.8, e.clientX - rect.left, e.clientY - rect.top, true);
                }
                return;
            }
            var el = document.elementFromPoint(e.clientX, e.clientY);
            var edge = el && el.closest ? el.closest('.band-handle') : null;
            if (edge) {
                fitTier(edge.getAttribute('data-tier'), edge.getAttribute('data-handle'));
                return;
            }
            var head = el && el.closest ? el.closest('.band-head') : null;
            if (head) {
                if (opts.onOpenTier) opts.onOpenTier(head.getAttribute('data-tier'));
                return;
            }
            var hit = nodeAt(e.clientX, e.clientY);
            if (hit) {
                if (opts.onOpen) opts.onOpen(hit);
                return;
            }
            if (!opts.onCreateAt) return;
            var w = toWorld(e.clientX, e.clientY);
            var col = columnAt(w.x);
            if (!col.tier) return UI.toast('Créez d\'abord un palier.', 'error');
            opts.onCreateAt({ tierId: col.tier.id, dx: col.dx, y: Math.round(w.y / GRID) * GRID });
        });

        /* Clavier (et manettes de console, qui envoient souvent des flèches et Entrée) :
           flèches = point voisin · Maj + flèches = déplacer la vue · + / − = zoom ·
           0 ou Début = tout voir · Entrée / Espace = ouvrir · Échap = désélectionner. */
        svg.addEventListener('keydown', function (e) {
            if (editable && selection.edge && (e.key === 'Delete' || e.key === 'Backspace')) {
                e.preventDefault();
                unlinkSelected();
                return;
            }
            var vp = viewport();
            var arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
            if (arrows[e.key]) {
                e.preventDefault();
                if (e.shiftKey || e.altKey) panBy(-arrows[e.key][0] * vp.w * 0.25, -arrows[e.key][1] * vp.h * 0.25);
                else navigate(arrows[e.key]);
                return;
            }
            switch (e.key) {
                case '+': case '=': case 'PageUp':
                    zoomAt(1.3, vp.w / 2, vp.h / 2, true); break;
                case '-': case '_': case 'PageDown':
                    zoomAt(1 / 1.3, vp.w / 2, vp.h / 2, true); break;
                case '0': case 'Home':
                    fit(true); break;
                case 'Escape':
                    select(null); break;
                case 'Enter': case ' ':
                    activate(); break;
                default:
                    return;
            }
            e.preventDefault();
        });

        function panBy(dx, dy) {
            var from = { x: view.x, y: view.y, k: view.k };
            moveTo({ x: from.x + dx, y: from.y + dy, k: from.k }, true);
        }

        /** Navigation spatiale : sélectionne le point le plus proche dans la direction [dx, dy].
         *  Sans sélection (ou sans direction), part du point le plus proche du centre de la vue. */
        function navigate(dir) {
            var list = visible().filter(function (r) { return !filter || filter(r); });
            if (!list.length) return;
            var cur = selection.node ? R.byId(selection.node) : null;
            if (cur && !R.researchVisible(cur, mode)) cur = null;

            var best = null, bestScore = Infinity;
            if (!cur || !dir) {
                var vp = viewport();
                var c = { x: (vp.w / 2 - view.x) / view.k, y: (vp.h / 2 - view.y) / view.k };
                list.forEach(function (r) {
                    var d = dist(pos(r), c);
                    if (d < bestScore) { bestScore = d; best = r; }
                });
            } else {
                var p = pos(cur);
                list.forEach(function (r) {
                    if (r.id === cur.id) return;
                    var q = pos(r);
                    var along = (q.x - p.x) * dir[0] + (q.y - p.y) * dir[1];
                    if (along <= 10) return;
                    var across = Math.abs((q.x - p.x) * dir[1] - (q.y - p.y) * dir[0]);
                    var score = along + across * 2.5;
                    if (score < bestScore) { bestScore = score; best = r; }
                });
            }
            if (best) {
                select(best.id);
                focusOn(best.id);
            }
        }

        function unlinkSelected() {
            if (!selection.edge) return;
            var parts = selection.edge.split('>');
            R.unlink(parts[0], parts[1]);
            selection.edge = null;
            UI.toast('Lien supprimé.');
            changed();
            if (opts.onSelect) opts.onSelect(null);
        }

        host.querySelector('.graph-tools').addEventListener('click', function (e) {
            var b = e.target.closest('[data-z]');
            if (!b) return;
            var vp = viewport();
            var z = b.getAttribute('data-z');
            if (z === 'fit') fit(true);
            else if (z === 'map') setMinimap(minimap.hidden);
            else if (z === 'full') toggleFullscreen();
            else if (z === 'help') toggleHelp();
            else zoomAt(z === 'in' ? 1.3 : 1 / 1.3, vp.w / 2, vp.h / 2, true);
        });

        if (window.ResizeObserver) {
            new ResizeObserver(function () { if (!fitted) initialView(); }).observe(host);
        }

        /* ------------------------------------------------------------------
           Paliers corrompus : brouillés aux archives, presque illisibles au
           laboratoire, et secoués par intermittence d'une poussée d'instabilité.
           ------------------------------------------------------------------ */

        var surgeTimer = null;

        /** Texte brouillé selon la page ; `ratio` force une intensité ponctuelle. */
        function veil(text, ratio) {
            return UI.glitch(text, ratio || R.veilRatio(mode));
        }

        /** Brouille à nouveau les libellés corrompus : une partie à chaque seconde, tous lors d'une poussée. */
        function scrambleCorrupt(ratio) {
            gNodes.querySelectorAll('.gnode.is-corrupt').forEach(function (el) {
                if (!ratio && Math.random() < 0.6) return;
                var r = R.byId(el.getAttribute('data-id'));
                if (!r) return;
                var lines = labelLines(veil(r.name, ratio));
                el.querySelectorAll('.g-label').forEach(function (label, i) {
                    label.textContent = lines[i] || '';
                });
            });
        }

        /** Programme la prochaine poussée, entre 9 et 30 secondes. */
        function scheduleSurge() {
            clearTimeout(surgeTimer);
            if (mode !== 'chercheur' && mode !== 'complet') return;
            surgeTimer = setTimeout(function () {
                if (host.getClientRects().length && !document.hidden && gNodes.querySelector('.is-corrupt')) {
                    var cls = reduceMotion ? 'is-surge-soft' : 'is-surge';
                    host.classList.remove('is-surge', 'is-surge-soft');
                    void host.getBoundingClientRect(); // relance l'animation CSS
                    host.classList.add(cls);
                    scrambleCorrupt(0.95);
                    setTimeout(function () { host.classList.remove(cls); }, 1900);
                }
                scheduleSurge();
            }, 9000 + Math.random() * 21000);
        }

        scheduleSurge();

        /* ------------------------------------------------------------------
           Aides à la navigation : paliers, mini-carte, aperçu, aide,
           plein écran, double-toucher et manette
           ------------------------------------------------------------------ */

        var tierBar = host.querySelector('.graph-tiers');
        var minimap = host.querySelector('.graph-minimap');
        var mmContent = minimap.querySelector('.mm-content');
        var mmView = minimap.querySelector('.mm-view');
        var mapButton = host.querySelector('[data-z="map"]');
        var peek = host.querySelector('.graph-peek');
        var helpBox = host.querySelector('.graph-help');
        var padBadge = host.querySelector('.graph-pad');
        var lastPointerType = 'mouse';
        var lastTap = { t: 0, x: 0, y: 0 };

        onViewChange = function () {
            updateMinimap();
            updateTierBar();
        };

        /** Toucher dans le vide : désélectionne. Double-toucher : zoom sur ce point. */
        function handleTap(e) {
            var now = Date.now();
            var isDouble = e.pointerType === 'touch' && now - lastTap.t < 320 &&
                Math.abs(e.clientX - lastTap.x) + Math.abs(e.clientY - lastTap.y) < 40;
            lastTap = { t: isDouble ? 0 : now, x: e.clientX, y: e.clientY };
            if (isDouble && !editable) {
                var rect = svg.getBoundingClientRect();
                zoomAt(2, e.clientX - rect.left, e.clientY - rect.top, true);
                return;
            }
            select(null);
        }

        /** Entrée, bouton A : ouvre la fiche du point sélectionné, ou sélectionne le plus proche. */
        function activate() {
            if (!selection.node) return navigate(null);
            if (editable && opts.onOpen) opts.onOpen(selection.node);
            else if (opts.onActivate) opts.onActivate(selection.node);
        }

        /* Boutons de palier */

        function renderTierBar(list) {
            var boxes = bandBoxes(list);
            tierBar.hidden = boxes.length < 2;
            tierBar.innerHTML = boxes.map(function (box) {
                var t = box.col.tier;
                var name = t.corrupted && !editable ? veil(t.name, R.veilRatio(mode) * 0.8) : t.name;
                return '<button type="button" data-tier="' + t.id + '" title="' + esc(name) + '">' +
                    esc(name.split(' — ')[0]) + '</button>';
            }).join('');
            updateTierBar();
        }

        /** Indice du palier situé au centre de la vue. */
        function currentTierIndex(boxes) {
            var vp = viewport();
            var cx = (vp.w / 2 - view.x) / view.k;
            var idx = 0;
            boxes.forEach(function (b, i) { if (cx >= b.col.x) idx = i; });
            return idx;
        }

        function updateTierBar() {
            var buttons = tierBar.querySelectorAll('[data-tier]');
            if (!buttons.length) return;
            var idx = currentTierIndex(bandBoxes(visible()));
            buttons.forEach(function (b, i) { b.classList.toggle('active', i === idx); });
        }

        function tierStep(delta) {
            var boxes = bandBoxes(visible());
            if (!boxes.length) return;
            focusTier(boxes[clamp(currentTierIndex(boxes) + delta, 0, boxes.length - 1)].col.tier.id, true);
        }

        tierBar.addEventListener('click', function (e) {
            var b = e.target.closest('[data-tier]');
            if (b) focusTier(b.getAttribute('data-tier'), true);
        });

        /* Mini-carte */

        function renderMinimap(list) {
            var b = bounds(list);
            var pad = 80;
            minimap.setAttribute('viewBox', (b.minX - pad) + ' ' + (b.minY - pad) + ' ' +
                (b.maxX - b.minX + pad * 2) + ' ' + (b.maxY - b.minY + pad * 2));
            mmContent.innerHTML = bandBoxes(list).map(function (box) {
                return '<rect class="mm-band' + (box.col.tier.corrupted ? ' is-corrupt' : '') + '" x="' + (box.col.x + 8) +
                    '" y="' + box.top + '" width="' + (box.col.width - 16) + '" height="' + (box.bottom - box.top) + '" rx="30"/>';
            }).join('') + list.map(function (r) {
                var p = pos(r);
                return '<circle class="mm-node st-' + R.state(r) + '" cx="' + p.x + '" cy="' + p.y +
                    '" r="' + (r.type === 'principale' ? 44 : 32) + '"/>';
            }).join('');
            updateMinimap();
        }

        function updateMinimap() {
            if (minimap.hidden) return;
            var vp = viewport();
            mmView.setAttribute('x', (-view.x / view.k).toFixed(0));
            mmView.setAttribute('y', (-view.y / view.k).toFixed(0));
            mmView.setAttribute('width', Math.max(1, vp.w / view.k).toFixed(0));
            mmView.setAttribute('height', Math.max(1, vp.h / view.k).toFixed(0));
        }

        function setMinimap(open, remember) {
            minimap.hidden = !open;
            mapButton.setAttribute('aria-pressed', String(open));
            mapButton.classList.toggle('active', open);
            if (remember !== false) UI.pref('graph-minimap', open ? '1' : '0');
            if (open) updateMinimap();
        }

        /** Cliquer ou glisser sur la mini-carte centre la vue sur ce point. */
        var mmDragging = false;
        function minimapJump(e) {
            var ctm = minimap.getScreenCTM();
            if (!ctm) return;
            var pt = minimap.createSVGPoint();
            pt.x = e.clientX;
            pt.y = e.clientY;
            var w = pt.matrixTransform(ctm.inverse());
            var vp = viewport();
            stopAnim();
            view.x = vp.w / 2 - w.x * view.k;
            view.y = vp.h / 2 - w.y * view.k;
            applyView();
        }
        minimap.addEventListener('pointerdown', function (e) {
            mmDragging = true;
            try { minimap.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
            minimapJump(e);
            e.preventDefault();
        });
        minimap.addEventListener('pointermove', function (e) { if (mmDragging) minimapJump(e); });
        minimap.addEventListener('pointerup', function () { mmDragging = false; });
        minimap.addEventListener('pointercancel', function () { mmDragging = false; });

        var mmPref = UI.pref('graph-minimap');
        setMinimap(mmPref === '1' || (mmPref === null && window.innerWidth >= 900), false);

        /* Aperçu du point sélectionné (petits écrans et plein écran) */

        function updatePeek() {
            var r = selection.node && !editable ? R.byId(selection.node) : null;
            peek.hidden = !r;
            if (!r) return;
            var state = R.state(r);
            peek.innerHTML =
                '<span class="peek-icon">' + UI.iconHTML(r) + '</span>' +
                '<span class="peek-text"><b>' + esc(R.isCorrupted(r) ? veil(r.name) : r.name) + '</b>' +
                    '<span><span class="badge ' + R.STATES[state].badge + '">' + R.STATES[state].label + '</span></span></span>' +
                (opts.onActivate ? '<button type="button" class="btn btn-sm" data-peek-open>Fiche</button>' : '');
            var open = peek.querySelector('[data-peek-open]');
            if (open) open.addEventListener('click', function () {
                if (isFullscreen()) toggleFullscreen();
                opts.onActivate(r.id);
            });
        }

        /* Aide */

        helpBox.innerHTML =
            '<div class="graph-help-head"><b>Se déplacer dans l\'arbre</b>' +
                '<button type="button" data-help-close aria-label="Fermer">✕</button></div>' +
            '<dl>' +
                '<dt>🖱️ Souris</dt><dd>Glisser : se déplacer · Molette : zoomer · Clic : ouvrir une fiche · Double-clic : zoomer ici</dd>' +
                '<dt>💻 Pavé tactile</dt><dd>Deux doigts : se déplacer · Pincer : zoomer · Toucher : ouvrir une fiche</dd>' +
                '<dt>📱 Tactile</dt><dd>Glisser : se déplacer · Pincer : zoomer · Double-toucher : zoomer ici · « Fiche » : détails</dd>' +
                '<dt>⌨️ Clavier</dt><dd>Flèches : recherche voisine · Maj + flèches : se déplacer · + / − : zoom · 0 : tout voir · Entrée : ouvrir · Échap : fermer</dd>' +
                '<dt>🎮 Manette</dt><dd>Stick gauche : se déplacer · Stick droit ou gâchettes : zoom · Croix : recherche voisine · A : ouvrir · B : fermer · LB / RB : palier précédent / suivant · Y : tout voir</dd>' +
                (editable ? '<dt>✏️ Édition</dt><dd>Glisser un point : le déplacer · Tirer depuis ● : lier · Bords d\'une zone : redimensionner</dd>' : '') +
            '</dl>' +
            '<p>Les boutons « Palier » en haut à gauche emmènent directement à chaque palier. ' +
                'Sélectionner une recherche éclaire tout le chemin qui y mène.</p>';

        function toggleHelp(open) {
            helpBox.hidden = open === undefined ? !helpBox.hidden : !open;
            if (!helpBox.hidden) helpBox.querySelector('[data-help-close]').focus();
        }
        helpBox.querySelector('[data-help-close]').addEventListener('click', function () {
            toggleHelp(false);
            try { svg.focus({ preventScroll: true }); } catch (err) { /* noop */ }
        });

        /* Plein écran */

        function isFullscreen() {
            return (document.fullscreenElement || document.webkitFullscreenElement) === host ||
                host.classList.contains('is-expanded');
        }

        function toggleFullscreen() {
            if ((document.fullscreenElement || document.webkitFullscreenElement) === host) {
                (document.exitFullscreen || document.webkitExitFullscreen).call(document);
                return;
            }
            var request = host.requestFullscreen || host.webkitRequestFullscreen;
            if (request && !host.classList.contains('is-expanded')) {
                var pending = request.call(host);
                if (pending && pending['catch']) pending['catch'](expand);
                return;
            }
            expand();

            // Repli (iPhone notamment) : la zone occupe tout l'écran sans l'API plein écran.
            function expand() {
                host.classList.toggle('is-expanded');
                document.body.classList.toggle('graph-expanded', host.classList.contains('is-expanded'));
            }
        }

        host.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            if (!helpBox.hidden) toggleHelp(false);
            else if (host.classList.contains('is-expanded')) toggleFullscreen();
        });

        /* Manette (Gamepad API) */

        var pad = { raf: 0, prev: {} };

        function padValue(gp, n) {
            var b = gp.buttons[n];
            if (!b) return 0;
            return typeof b === 'object' ? (b.value || (b.pressed ? 1 : 0)) : b;
        }

        /** Vrai uniquement à l'instant où le bouton est enfoncé. */
        function padPressed(gp, n) {
            var down = padValue(gp, n) > 0.5;
            var was = pad.prev[n];
            pad.prev[n] = down;
            return down && !was;
        }

        function padLoop() {
            pad.raf = 0;
            var pads = [];
            try { pads = navigator.getGamepads ? navigator.getGamepads() : []; } catch (err) { return; }
            var gp = null;
            for (var i = 0; i < pads.length; i++) {
                if (pads[i] && pads[i].connected !== false) { gp = pads[i]; break; }
            }
            if (!gp) return;

            if (host.getClientRects().length && document.hasFocus()) {
                var dead = function (v) { v = v || 0; return Math.abs(v) < 0.2 ? 0 : v; };
                var lx = dead(gp.axes[0]), ly = dead(gp.axes[1]), ry = dead(gp.axes[3]);
                if (lx || ly) {
                    stopAnim();
                    view.x -= lx * 16;
                    view.y -= ly * 16;
                    applyView();
                }
                var zoom = -ry * 0.035 + (padValue(gp, 7) - padValue(gp, 6)) * 0.035;
                if (Math.abs(zoom) > 0.003) {
                    var vp = viewport();
                    zoomAt(1 + zoom, vp.w / 2, vp.h / 2);
                }
                if (padPressed(gp, 12)) navigate([0, -1]);
                if (padPressed(gp, 13)) navigate([0, 1]);
                if (padPressed(gp, 14)) navigate([-1, 0]);
                if (padPressed(gp, 15)) navigate([1, 0]);
                if (padPressed(gp, 0)) activate();
                if (padPressed(gp, 1)) {
                    if (!helpBox.hidden) toggleHelp(false);
                    else select(null);
                }
                if (padPressed(gp, 3)) fit(true);
                if (padPressed(gp, 4)) tierStep(-1);
                if (padPressed(gp, 5)) tierStep(1);
            }
            pad.raf = requestAnimationFrame(padLoop);
        }

        function startPad() {
            if (!pad.raf) pad.raf = requestAnimationFrame(padLoop);
        }

        window.addEventListener('gamepadconnected', function () {
            padBadge.hidden = false;
            setTimeout(function () { padBadge.hidden = true; }, 3500);
            startPad();
        });
        try {
            var known = navigator.getGamepads ? navigator.getGamepads() : [];
            for (var gi = 0; gi < known.length; gi++) {
                if (known[gi]) { startPad(); break; }
            }
        } catch (err) { /* API bloquée par le navigateur */ }

        applyView();

        return {
            render: render,
            fit: fit,
            focusTier: focusTier,
            navigate: navigate,
            tierStep: tierStep,
            tick: tick,
            focusOn: focusOn,
            select: select,
            selectEdge: selectEdge,
            unlinkSelected: unlinkSelected,
            selection: function () { return { node: selection.node, edge: selection.edge }; },
            setFilter: function (fn) { filter = fn || null; applyFilter(); },
            /** Point monde au centre de la vue, pour créer « ici ». */
            center: function () {
                var rect = svg.getBoundingClientRect();
                var w = toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
                var col = columnAt(w.x);
                return { tierId: col.tier ? col.tier.id : null, dx: col.dx, y: Math.round(w.y / GRID) * GRID };
            }
        };
    }

    GOC.Graph = { create: create };
})();

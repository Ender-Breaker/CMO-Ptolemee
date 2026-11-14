/* ==========================================================================
   GOC — Division PTOLÉMÉE · Noyau applicatif
   Base de données locale, cookies, sessions, rôles, annonces, composants UI.

   NOTE D'ARCHITECTURE
   Deux modes de fonctionnement :
    - local (js/firebase-config.js vide) : prototype 100 % navigateur, données
      en localStorage, comptes à mot de passe. Pratique hors ligne et en file://.
    - Firebase (js/firebase-config.js renseigné) : connexion Google, état officiel
      en base Firestore, toutes les actions rejouées par les Cloud Functions (js/remote.js).
      Le navigateur ne garde qu'une copie d'affichage, jamais enregistrée.
   ========================================================================== */

(function (global) {
    'use strict';

    /** Mode Firebase : décidé une fois pour toutes au chargement. */
    var REMOTE = !!(global.GOC_FIREBASE && global.GOC_FIREBASE.apiKey);

    /* ----------------------------------------------------------------------
       Démarrage différé : en mode Firebase, les pages attendent la session
       Google et le premier état envoyé par le serveur.
       ---------------------------------------------------------------------- */

    var readyQueue = [];
    var isReady = !REMOTE;

    function ready(fn) {
        if (isReady) return fn();
        readyQueue.push(fn);
    }

    function markReady() {
        if (isReady) return;
        isReady = true;
        try { document.documentElement.classList.remove('is-syncing'); } catch (e) { /* noop */ }
        var queue = readyQueue;
        readyQueue = [];
        queue.forEach(function (fn) {
            try { fn(); } catch (e) { console.error(e); }
        });
    }

    if (REMOTE) {
        try { document.documentElement.classList.add('mode-remote', 'is-syncing'); } catch (e) { /* noop */ }
    }

    /* ----------------------------------------------------------------------
       Cookies
       ---------------------------------------------------------------------- */

    var COOKIE_TEST = (function () {
        try {
            document.cookie = 'goc_test=1;path=/;SameSite=Lax';
            var ok = document.cookie.indexOf('goc_test=') !== -1;
            document.cookie = 'goc_test=;path=/;Max-Age=0;SameSite=Lax';
            return ok;
        } catch (e) {
            return false;
        }
    })();

    var Cookies = {
        /** Les cookies réels ne fonctionnent pas en file:// ; on retombe alors
         *  sur un miroir localStorage avec la même sémantique d'expiration. */
        available: COOKIE_TEST,

        set: function (name, value, days) {
            var payload = encodeURIComponent(value);
            if (COOKIE_TEST) {
                var expires = '';
                if (days) {
                    var d = new Date();
                    d.setTime(d.getTime() + days * 864e5);
                    expires = ';expires=' + d.toUTCString();
                }
                document.cookie = name + '=' + payload + expires + ';path=/;SameSite=Lax';
            } else {
                var until = days ? Date.now() + days * 864e5 : 0;
                try {
                    localStorage.setItem('cookie::' + name, JSON.stringify({ v: value, e: until }));
                } catch (e) { /* stockage indisponible */ }
            }
        },

        get: function (name) {
            if (COOKIE_TEST) {
                var parts = document.cookie.split(';');
                for (var i = 0; i < parts.length; i++) {
                    var p = parts[i].trim();
                    if (p.indexOf(name + '=') === 0) {
                        return decodeURIComponent(p.substring(name.length + 1));
                    }
                }
                return null;
            }
            try {
                var raw = localStorage.getItem('cookie::' + name);
                if (!raw) return null;
                var obj = JSON.parse(raw);
                if (obj.e && Date.now() > obj.e) {
                    localStorage.removeItem('cookie::' + name);
                    return null;
                }
                return obj.v;
            } catch (e) {
                return null;
            }
        },

        remove: function (name) {
            if (COOKIE_TEST) {
                document.cookie = name + '=;path=/;Max-Age=0;SameSite=Lax';
            } else {
                try { localStorage.removeItem('cookie::' + name); } catch (e) { /* noop */ }
            }
        }
    };

    var CONSENT_COOKIE = 'goc_consent';
    var SESSION_COOKIE = 'goc_session';

    var Consent = {
        read: function () {
            var raw = Cookies.get(CONSENT_COOKIE);
            if (!raw) return null;
            try { return JSON.parse(raw); } catch (e) { return null; }
        },
        save: function (choice) {
            var value = {
                essentiels: true,
                persistance: !!choice.persistance,
                preferences: !!choice.preferences,
                date: new Date().toISOString(),
                version: 1
            };
            Cookies.set(CONSENT_COOKIE, JSON.stringify(value), 180);
            return value;
        },
        allows: function (category) {
            if (category === 'essentiels') return true;
            var c = Consent.read();
            return !!(c && c[category]);
        },
        reset: function () {
            Cookies.remove(CONSENT_COOKIE);
            Cookies.remove(SESSION_COOKIE);
        }
    };

    /* ----------------------------------------------------------------------
       Base de données locale
       ---------------------------------------------------------------------- */

    var DB_KEY = 'goc_ptolemee_db';
    var LEGACY_KEYS = ['goc_ptomele_db'];
    var DB_VERSION = 10;

    /** Largeur d'une colonne interne de palier dans l'arbre (unités monde).
     *  Un palier s'étend sur `span` colonnes internes. */
    var LANE_W = 230;

    /** Hachage volontairement simple (FNV-1a salé). Suffisant pour empêcher la
     *  lecture en clair d'un mot de passe dans localStorage ; ce n'est PAS de
     *  la cryptographie. Un vrai backend devra utiliser bcrypt/argon2. */
    function hash(text) {
        var str = 'ptolemee::' + String(text);
        var h = 0x811c9dc5;
        for (var i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
        }
        var h2 = 0x01000193;
        for (var j = str.length - 1; j >= 0; j--) {
            h2 = ((h2 ^ str.charCodeAt(j)) * 16777619) >>> 0;
        }
        return h.toString(16) + '-' + h2.toString(16);
    }

    function freshUid(prefix) {
        return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    /** Bande d'identifiants : le navigateur enregistre ceux qu'il crée pendant une
     *  action, le serveur les rejoue à l'identique. Sans cela, une recherche créée
     *  hors ligne n'aurait pas le même identifiant des deux côtés. */
    var uidTape = null;

    function uid(prefix) {
        prefix = prefix || 'id';
        if (uidTape && uidTape.mode === 'replay') {
            while (uidTape.list.length) {
                var v = uidTape.list.shift();
                if (typeof v === 'string' && v.indexOf(prefix + '_') === 0 && /^[a-z]+_[a-z0-9]{4,24}$/.test(v)) return v;
            }
        }
        var id = freshUid(prefix);
        if (uidTape && uidTape.mode === 'record') uidTape.list.push(id);
        return id;
    }

    var ROLES = {
        guest: { level: 0, label: 'Invité' },
        chercheur: { level: 1, label: 'Chercheur' },
        membre: { level: 2, label: 'Membre GOC' },
        gradé: { level: 3, label: 'Haut gradé' },
        admin: { level: 4, label: 'Développeur' }
    };

    var TEAMS = {
        qm: { label: 'Quartier-maître', short: 'QM', icon: '📦' },
        rd: { label: 'Recherche & Développement', short: 'R&D', icon: '⚙️' }
    };

    /** Arbre de recherche officiel.
     *  Fiche : [code, nom, équipe, icône, coût en PR, durée en minutes, description, rapport?]
     *
     *  Chaque palier a une racine, posée sur la « colonne vertébrale » en haut de l'arbre,
     *  puis des groupes empilés. Un groupe est une suite d'étapes ; une étape contient des
     *  branches parallèles (une branche = une ou plusieurs recherches qui se suivent) qui
     *  convergent vers une sortie (une principale, ou un éventail de principales).
     *   - la tête de chaque branche exige les sorties de l'étape précédente (ou la racine, + `after`) ;
     *   - une sortie exige la fin de toutes les branches de son étape ;
     *   - la racine suivante exige les fins des groupes sans sortie, sinon la racine précédente.
     *  Plancher d'équilibrage : 500 PR / 4 h. Plafond du palier 2 : 40 000 PR / 3 j. */
    var H = 60, J = 1440;   // minutes par heure, par jour
    var ROW_H = 140;        // écart vertical entre deux lignes
    var GROUP_GAP = 50;     // écart supplémentaire entre deux groupes
    var STEP = 250;         // écart horizontal entre deux colonnes
    var ROOT_DX = 120;      // position de la racine dans son palier
    var FIRST_DX = 460;     // première colonne (palier avec racine)
    var FREE_DX = 140;      // première colonne (palier sans racine)
    var TAIL = 140;         // marge après la dernière colonne
    var SPINE_Y = -160;     // hauteur des racines

    /* Options d'une fiche : { repeatable, maxRepeats, scaling, boost, needs, group, debuff }
       `needs` : nombre d'achèvements exigés de l'étape précédente (recherche répétable). */
    function S(item, opts) { return { type: 'secondaire', item: item, opts: opts || {} }; }
    function P(item, opts) { return { type: 'principale', item: item, opts: opts || {} }; }

    var TREE = [
        {
            name: 'Palier 0 — Redécouverte',
            root: ['PTL-001', 'Protocole PHÉNIX « Coup de Balai »', 'qm', '🧹', 1200, 6 * H,
                'Réorganisation générale de la Division Physique post-incident. Réactive les accès aux bases de données, débloque les budgets R&D et centralise les ressources.'],
            groups: [
                { stages: [{ branches: [
                    [
                        S(['PTL-002', 'Procédure Administrative 108-B « Paperasse Allégée »', 'qm', '📝', 500, 4 * H,
                            'Paperasse simplifiée pour réclamer du matériel détruit par une altération de réalité.']),
                        S(['PTL-005', 'Audit d\'Armurerie « Sous la Bâche »', 'qm', '🔍', 700, 5 * H,
                            'Retrouve trois caisses de grenades et un fusil oublié sous une bâche.'])
                    ],
                    [
                        S(['PTL-006', 'Accréditation Biométrique N1 « Sésame »', 'rd', '🔐', 900, 6 * H,
                            'Permet enfin d\'ouvrir les portes du secteur R&D sans appeler la sécurité.']),
                        S(['PTL-004', 'Archivage Numérique SGO « Opération Plumeau »', 'rd', '🗄️', 800, 6 * H,
                            'Numérisation des vieux dossiers de la Seconde Guerre Occulte.'])
                    ],
                    [
                        S(['PTL-003', 'Réservoir Caféinique Individuel RCI-108', 'qm', '☕', 600, 5 * H,
                            'Indispensable pour survivre aux débriefings de 6 heures du Conseil des 108.'], {
                            group: 'café',
                            repeatable: true,
                            scaling: { enabled: true, temps: 0, cout: 10, vitesse: 0 },
                            boost: { enabled: true, type: 'cout', value: -5, hours: 12, stack: false },
                            // Sans café pendant 14 jours : +1 % de coût, puis +1 % par jour, jusqu'à 25 %.
                            debuff: { enabled: true, type: 'cout', graceDays: 14, start: 1, perDay: 1, max: 25 }
                        })
                    ]
                ] }] },
                // Ligne du café : hors progression principale. Chaque niveau exige plusieurs
                // répétitions du précédent et accorde un boost temporaire à toute la division.
                { detached: true, col: 2, after: [{ code: 'PTL-003', count: 10 }], stages: [{ branches: [[
                    S(['PTL-007', 'Percolateur de Campagne PC-2 « Cafetière Niv. 2 »', 'qm', '🫖', 2500, 10 * H,
                        'Machine à café de terrain homologuée par le Conseil. Tient en zone de dégradation de réalité, pas sans filtre.'], {
                        group: 'café',
                        repeatable: true,
                        scaling: { enabled: true, temps: 10, cout: 15, vitesse: 0 },
                        boost: { enabled: true, type: 'temps', value: -5, hours: 12, stack: false }
                    }),
                    S(['PTL-008', 'Infuseur Thaumique IT-3 « Cafetière Niv. 3 »', 'rd', '⚗️', 6000, 18 * H,
                        'Extraction assistée par résonance d\'EVE : un espresso en quatre secondes, avec un léger arrière-goût de soufre.'], {
                        needs: 5,
                        group: 'café',
                        repeatable: true,
                        scaling: { enabled: true, temps: 10, cout: 20, vitesse: 5 },
                        boost: { enabled: true, type: 'rendement', value: 5, hours: 12, stack: false }
                    })
                ]] }] }
            ]
        },
        {
            name: 'Palier 1 — Reconstitution Tactique',
            root: ['PTL-100', 'Doctrine d\'Intervention Rapide « Pied de Biche »', 'qm', '🛠️', 3000, 12 * H,
                'Établissement des normes d\'intervention rapide et de détection initiale sur le terrain.'],
            groups: [
                { stages: [{
                    branches: [
                        [
                            S(['PTL-111', 'Lubrifiant Haute Viscosité LHV-40', 'qm', '🛢️', 700, 4 * H,
                                'Empêche le sable, la boue et le sang d\'AET de bloquer la culasse.']),
                            S(['PTL-114', 'Écouvillon en Laiton Anti-Résidus EVE', 'qm', '🪥', 900, 6 * H,
                                'Enlève les dépôts de carbone et les résidus d\'EVE cristallisée.'])
                        ],
                        [S(['PTL-112', 'Sangle d\'Arrimage Tripode « Anti-Tournis »', 'qm', '🪢', 600, 4 * H,
                            'Évite de faire tomber son fusil quand une manifestation cognito-dangereuse donne le tournis.'])],
                        [S(['PTL-113', 'Traçantes Photoluminescentes « Rétro »', 'rd', '🎇', 1200, 8 * H,
                            'Utile pour voir où l\'on tire pendant les interventions nocturnes.'])]
                    ],
                    out: P(['PTL-110', 'Armement G0 « Le Vieux Clou »', 'qm', '🔩', 4500, 16 * H,
                        'Standardisation du matériel conventionnel, éprouvé mais sans fioritures.'])
                }] },
                { stages: [{
                    branches: [
                        [
                            S(['PTL-122', 'Textile Optique Anodisé « Pas avec la Manche »', 'qm', '🧽', 500, 4 * H,
                                'Nettoie les lentilles sans rayer les revêtements en béryllium-bronze.']),
                            S(['PTL-123', 'Filtre Rétinien Antiéblouissement Thaumique', 'rd', '🕶️', 1800, 8 * H,
                                'Protège les rétines des agents face aux flashs d\'EVE de haute intensité.'])
                        ],
                        [S(['PTL-121', 'Étalonnage EVE Automatisé « Anti-Micro-Ondes »', 'rd', '🎛️', 2000, 10 * H,
                            'Évite de confondre une entité thaumaturge avec un four à micro-ondes défectueux.'])]
                    ],
                    out: P(['PTL-120', 'Imageur à Résonance VERITAS v1 « Œil de Lynx »', 'rd', '👁️', 8000, 24 * H,
                        'Système d\'imagerie à résonance d\'EVE pour détecter les signatures paranormales.'])
                }] },
                { stages: [{
                    branches: [
                        [S(['PTL-131', 'Ration Canine Radioprotectrice « Croquettes Plombées »', 'qm', '🦴', 700, 5 * H,
                            'Protège le système digestif des canidés des retombées d\'EVE.'])],
                        [
                            S(['PTL-132', 'Dispositif de Contention Mandibulaire', 'qm', '🔒', 600, 4 * H,
                                'Évite que le chien ne croque un agent d\'évaluation en plein stress post-traumatique.']),
                            S(['PTL-133', 'Longe Aramide Anti-Télékinésie', 'qm', '🦮', 1000, 6 * H,
                                'Résiste aux morsures et aux poussées télékinésiques légères.'])
                        ]
                    ],
                    out: P(['PTL-130', 'Unité Cynophile CNO « Bons Toutous »', 'qm', '🐕', 6000, 20 * H,
                        'Unités cynophiles entraînées aux menaces mémétiques et au pistage d\'AET.'])
                }] },
                { stages: [{
                    branches: [
                        [S(['PTL-151', 'Hélices Sacrificielles de Rechange', 'qm', '🔧', 600, 4 * H,
                            'Parce qu\'un drone s\'écrase systématiquement sur le premier obstacle venu.'])],
                        [
                            S(['PTL-152', 'Cellule Lithium Étendue « +4 Minutes »', 'rd', '🔋', 1400, 8 * H,
                                'Accorde 4 minutes d\'autonomie supplémentaires si le chauffage interne est coupé.']),
                            S(['PTL-153', 'Capteur Thermographique de Base', 'rd', '🌡️', 2200, 10 * H,
                                'Repère les signatures de chaleur avant d\'entrer dans une pièce.'])
                        ]
                    ],
                    out: P(['PTL-150', 'Micro-Drone de Reconnaissance « Le Moustique »', 'rd', '🦟', 5000, 18 * H,
                        'Micro-drones de reconnaissance tactique pour cartographier les zones confinées.'])
                }] },
                { stages: [{
                    branches: [
                        [S(['PTL-141', 'Rotor à Signature Acoustique Réduite', 'rd', '🌀', 2500, 12 * H,
                            'Bruit réduit de 15 % pour arriver avant que l\'AET ne repère le vecteur.'])],
                        [S(['PTL-142', 'Neutraliseur Olfactif Conifère « Senteur Pin »', 'qm', '🌲', 500, 4 * H,
                            'Masque l\'odeur de soufre et de chair brûlée au retour de mission.'])],
                        [S(['PTL-143', 'Dissimulation Anti-Satellite « La Bâche »', 'qm', '⛺', 1500, 8 * H,
                            'Cache l\'appareil des satellites civils lors du stationnement au sol.'])]
                    ],
                    out: P(['PTL-140', 'Hélicoptère Léger MH-6 « Le Vol de Nuit »', 'qm', '🚁', 7000, 24 * H,
                        'Insertion rapide des Équipes d\'Évaluation en zone urbaine.'])
                }] }
            ]
        },
        {
            name: 'Palier 2 — Supériorité Tactique & Frappe Lourde',
            root: ['PTL-200', 'Programme SAR « Éradication »', 'rd', '🎯', 12000, 36 * H,
                'Suppression Avancée de Réalité : déploiement des technologies de suppression de réalité, des exosquelettes et de la supériorité des feux lourds.'],
            groups: [
                // Armement : même rang que G0 au palier 1.
                { after: ['PTL-110'], stages: [
                    {
                        branches: [
                            [S(['PTL-211', 'Chargeur Jumelé Adhésif « Gaffeur »', 'qm', '🩹', 2500, 12 * H,
                                'Deux bandes de gaffeur et un ressort plus dur pour gagner 5 cartouches sans coût R&D.'])],
                            [S(['PTL-212', 'Munitions à Pointe Argentée Anti-Régénération', 'rd', '🥈', 5000, 20 * H,
                                'Alliage métallique pour stopper les cibles à régénération biologique rapide.'])],
                            [S(['PTL-213', 'Visée Holographique « Tête Non Requise »', 'rd', '🔭', 4500, 18 * H,
                                'Aide à viser les entités n\'ayant pas de tête clairement définie.'])]
                        ],
                        out: P(['PTL-210', 'Fusil d\'Assaut KG-49 « VINDEX »', 'rd', '🔫', 15000, 40 * H,
                            'Fusil d\'assaut de génération G1 : plateforme conventionnelle modifiée pour tirer des munitions anti-occultes.'])
                    },
                    {
                        branches: [
                            [
                                S(['PTL-221', 'Refroidissement Liquide du Processeur SINKER', 'rd', '❄️', 7000, 24 * H,
                                    'Évite que le processeur d\'ancre de réalité ne fonde en plein tir de barrage.']),
                                S(['PTL-222', 'Verrou Biométrique Anti-Appropriation', 'rd', '🔐', 6000, 20 * H,
                                    'Empêche une entité de se servir de l\'arme contre l\'équipe de frappe.'])
                            ],
                            [S(['PTL-223', 'Poignée Hydrophobe « Mains Moites »', 'qm', '✋', 2500, 12 * H,
                                'Maintient une prise ferme durant les effondrements de réalité locale.'])]
                        ],
                        out: [
                            P(['PTL-220', 'Fusil à Pompe GK413 « SECURIS »', 'rd', '💥', 26000, 56 * H,
                                'Fusil à pompe de génération G2 à puce SINKER : annule la réalité locale à courte portée, taillé pour les couloirs de confinement.']),
                            P(['PTL-224', 'Fusil d\'Assaut LK-17G « LICTOR »', 'rd', '🎯', 30000, 60 * H,
                                'Fusil d\'assaut de génération G2 intégrant une puce SINKER pour annuler la réalité locale à moyenne distance.']),
                            P(['PTL-225', 'Pistolet Semi-Automatique M12D « PUGIO »', 'rd', '🗡️', 18000, 40 * H,
                                'Arme de poing de génération G2 à puce SINKER miniaturisée : le dernier recours quand tout le reste a fondu.'])
                        ]
                    }
                ] },
                { stages: [{
                    branches: [
                        [
                            S(['PTL-231', 'Régulation Thermique Intégrée « 21 °C Garantis »', 'rd', '🌬️', 6000, 20 * H,
                                'Maintient 21 °C dans la combinaison, même au milieu d\'un enfer pyrotechnique.']),
                            S(['PTL-233', 'Recyclage Hydrique Interne « Biberon »', 'rd', '🍼', 5000, 18 * H,
                                'Recyclage d\'eau interne pour éviter les pauses en plein confinement d\'AET.'])
                        ],
                        [S(['PTL-232', 'Interface Axillaire Anti-Friction', 'qm', '🧴', 2500, 12 * H,
                            'Limite les irritations aux aisselles après 12 heures de patrouille en exosquelette.'])],
                        [S(['PTL-234', 'Gel Viscoélastique d\'Absorption Cinétique', 'rd', '🧊', 7000, 24 * H,
                            'Atténue les impacts en cas de projection contre un mur par une onde télékinésique.'])]
                    ],
                    out: P(['PTL-230', 'Combinaison WhiteSuit « Le Pyjama Blanc »', 'rd', '🥼', 35000, 64 * H,
                        'Combinaison de combat avec camouflage optique et isolation thaumaturgique.'])
                }] },
                { stages: [{
                    branches: [
                        [
                            S(['PTL-242', 'Blindage Réactif Type-B', 'rd', '🧱', 8000, 28 * H,
                                'Plaques jetables absorbant les vagues de choc physiques ou thaumiques.']),
                            S(['PTL-243', 'Chenilles Autocicatrisantes', 'rd', '⛓️', 9000, 30 * H,
                                'Évite de rester immobilisé si la piste de roulement fond ou se liquéfie.'])
                        ],
                        [S(['PTL-241', 'Balayage Pare-Brise Anti-Ectoplasme', 'qm', '💧', 3000, 12 * H,
                            'Nettoie les fluides anomaux sur le pare-brise sans étaler la matière ectoplasmique.'])]
                    ],
                    out: P(['PTL-240', 'Char Lourd Type-Abrams « Le Marteau »', 'rd', '🛡️', 38000, 3 * J,
                        'Char blindé contre la dégradation de réalité pour détruire les AET imposantes.'])
                }] },
                { stages: [
                    {
                        branches: [
                            [S(['PTL-261', 'Cordes de Rappel en Graphène', 'rd', '🧵', 6000, 20 * H,
                                'Descente en rappel ultra-rapide sans risque de rupture sous contrainte d\'EVE.'])],
                            [
                                S(['PTL-262', 'Assises Ergonomiques Charge Lourde', 'qm', '💺', 2500, 12 * H,
                                    'Un minimum de confort pour les opérateurs portant une armure de 80 kg.']),
                                S(['PTL-263', 'Isolation Acoustique de Cabine « On s\'entend enfin »', 'qm', '🔇', 3000, 12 * H,
                                    'Permet de communiquer les ordres sans hurler par-dessus la turbine.'])
                            ]
                        ],
                        out: P(['PTL-260', 'Hélicoptère de Transport UH-60 « Taxi Gris »', 'qm', '🚁', 18000, 40 * H,
                            'Transport tactique pour le déploiement des Équipes de Frappe au complet.'])
                    },
                    {
                        branches: [
                            [S(['PTL-271', 'Récupérateurs de Douilles Grande Capacité', 'qm', '🗑️', 2500, 12 * H,
                                'Empêche la pluie de cuivre de brûler le personnel au sol.'])],
                            [S(['PTL-272', 'Munitions Perforantes Anti-Psychiques', 'rd', '💥', 8000, 26 * H,
                                'Traverse les structures en béton et les boucliers psychiques légers.'])]
                        ],
                        out: P(['PTL-270', 'Hélicoptère d\'Assaut MH-60 « L\'Exorciste »', 'rd', '🔥', 30000, 60 * H,
                            'Version blindée avec miniguns latéraux pour le nettoyage de surface.'])
                    }
                ] },
                // Même rang que le MH-6 au palier 1.
                { after: ['PTL-140'], stages: [{
                    branches: [
                        [S(['PTL-251', 'Nacelles de Roquettes « Sans Sommation »', 'rd', '🚀', 7000, 24 * H,
                            'Permet de saturer la zone quand la précision chirurgicale échoue.'])],
                        [S(['PTL-252', 'Affichage Tête Haute VERITAS', 'rd', '🪖', 5000, 20 * H,
                            'Projette les signatures VERITAS directement sur la visière du pilote.'])]
                    ],
                    out: P(['PTL-250', 'Hélicoptère d\'Appui AH-6 « La Guêpe »', 'rd', '🐝', 20000, 48 * H,
                        'Appui feu rapproché doté de pods de roquettes pour sécuriser la zone.'])
                }] },
                { stages: [{
                    branches: [
                        [
                            S(['PTL-281', 'Élingue de Charge Externe 12 t', 'qm', '🪝', 6000, 20 * H,
                                'Essentielle pour hélitreuiller un conteneur d\'isolation rempli d\'une entité agressive.']),
                            S(['PTL-282', 'Arrimage Électromagnétique de Fret', 'rd', '🧲', 7000, 24 * H,
                                'Sécurise l\'arrimage des conteneurs en cas de turbulences thaumiques.'])
                        ]
                    ],
                    out: P(['PTL-280', 'Hélicoptère Lourd CH-47 « Le Déménageur »', 'qm', '📦', 25000, 56 * H,
                        'Transport lourd pour déposer des cages de confinement directement sur le terrain.'])
                }] },
                { stages: [{
                    branches: [
                        [S(['PTL-292', 'Canon M230 de 30 mm « Le Hachoir »', 'rd', '⚙️', 8000, 28 * H,
                            'Nettoie rapidement les zones d\'apparition de menaces multiples.'])],
                        [
                            S(['PTL-293', 'Cockpit Étanche Anti-Infiltration', 'rd', '🧯', 7000, 24 * H,
                                'Empêche les entités gazeuses ou intangibles de s\'introduire dans le cockpit.']),
                            S(['PTL-291', 'Leurres Thermo-Thaumiques', 'rd', '🎆', 9000, 30 * H,
                                'Dévie aussi bien les missiles sol-air que les attaques pyrotechniques anomales.'])
                        ]
                    ],
                    out: P(['PTL-290', 'Hélicoptère d\'Attaque AH-64 « L\'Oiseau de Mauvais Augure »', 'rd', '🦅', 40000, 3 * J,
                        'Hélicoptère d\'attaque lourd pour les menaces d\'échelle régionale.'])
                }] }
            ]
        },
        {
            name: 'Palier ██',
            corrupted: true,
            groups: [
                { after: ['PTL-220'], stages: [{ branches: [[
                    P(['PTL-███', 'Protocole ████', 'rd', '◉', 60000, 5 * J, 'Aucune fiche de mission associée.',
                        'Ce document a été modifié depuis votre dernière lecture.']),
                    S(['PTL-▒▒▒', 'Signal', 'rd', '◌', 50000, 4 * J, 'Émetteur non localisé.'])
                ]] }] }
            ]
        }
    ];

    /** Construit paliers et recherches à partir de TREE, positions comprises. */
    function seedTree(now) {
        var tiers = [], researches = [], byCode = {}, pending = [];
        var prevRoot = null, prevEnds = [];

        TREE.forEach(function (spec, order) {
            var tierId = uid('tier');
            var firstDx = spec.root ? FIRST_DX : FREE_DX;
            var tier = {
                id: tierId, name: spec.name, order: order, width: 0, span: 1,
                corrupted: !!spec.corrupted, description: spec.description || '', seed: true
            };
            tiers.push(tier);

            var rootId = spec.root
                ? add(spec.root, 'principale', tierId, ROOT_DX, SPINE_Y,
                    prevEnds.length ? prevEnds : (prevRoot ? [prevRoot] : [])).id
                : null;

            var ends = [], maxCol = 0, nextRow = 0;

            (spec.groups || []).forEach(function (group, gi) {
                // `detached` : le groupe ne part pas de la racine et n'alimente pas la racine suivante.
                var top = group.row != null ? group.row : nextRow, height = 1, col = group.col || 0;
                var inputs = rootId && !group.detached ? [rootId] : [];
                var yOf = function (row) { return row * ROW_H + gi * GROUP_GAP; };

                group.stages.forEach(function (stage, si) {
                    var branches = stage.branches || [];
                    var outs = stage.out ? (stage.out instanceof Array ? stage.out : [stage.out]) : [];
                    var width = branches.reduce(function (m, b) { return Math.max(m, b.length); }, 0);
                    var branchEnds = [];
                    height = Math.max(height, branches.length, outs.length);

                    // Placement des branches, pour qu'aucun lien ne traverse un point :
                    //  - avec une sortie : alignées à gauche, les liens venant de la racine arrivent
                    //    tous sur la première colonne ;
                    //  - sans sortie (elles alimentent la racine suivante) : alignées à droite et
                    //    rangées de la plus courte à la plus longue, liens montants dégagés.
                    var alignRight = !outs.length;
                    if (alignRight) {
                        branches = branches.map(function (b, i) { return { b: b, i: i }; })
                            .sort(function (a, z) { return a.b.length - z.b.length || a.i - z.i; })
                            .map(function (x) { return x.b; });
                    }

                    branches.forEach(function (branch, bi) {
                        var prev = inputs;
                        branch.forEach(function (s, k) {
                            var c = col + (alignRight ? width - branch.length : 0) + k;
                            var r = add(s.item, s.type, tierId, firstDx + c * STEP, yOf(top + bi), prev, s.opts);
                            if (spec.corrupted) r.corrupted = true;
                            if (si === 0 && k === 0 && group.after) pending.push({ r: r, codes: group.after });
                            prev = [r.id];
                        });
                        branchEnds = branchEnds.concat(prev);
                    });

                    if (!outs.length) {
                        inputs = branchEnds;
                        maxCol = Math.max(maxCol, col + width - 1);
                        col += width;
                        return;
                    }

                    var outCol = col + width;
                    var firstRow = outs.length === 1 ? top + (Math.max(branches.length, 1) - 1) / 2 : top;
                    inputs = outs.map(function (s, j) {
                        var r = add(s.item, s.type, tierId, firstDx + outCol * STEP, yOf(firstRow + j),
                            branchEnds.length ? branchEnds : inputs, s.opts);
                        if (spec.corrupted) r.corrupted = true;
                        return r.id;
                    });
                    maxCol = Math.max(maxCol, outCol);
                    col = outCol + 1;
                });

                if (!group.detached && !group.stages[group.stages.length - 1].out) ends = ends.concat(inputs);
                nextRow = Math.max(nextRow, top + height);
            });

            tier.width = firstDx + maxCol * STEP + TAIL;
            tier.span = Math.max(1, Math.round(tier.width / LANE_W));

            if (rootId) {
                prevRoot = rootId;
                prevEnds = ends;
            }
        });

        // `after` : codes, ou { code, count } quand plusieurs achèvements sont exigés.
        pending.forEach(function (p) {
            p.codes.forEach(function (entry) {
                var dep = byCode[typeof entry === 'string' ? entry : entry.code];
                if (!dep) return;
                p.r.requires.push(dep.id);
                if (entry.count > 1) {
                    p.r.requireCounts = p.r.requireCounts || {};
                    p.r.requireCounts[dep.id] = entry.count;
                }
            });
        });

        return { tiers: tiers, researches: researches };

        function add(item, type, tierId, dx, y, requires, opts) {
            var r = {
                id: uid('rch'), code: item[0], tierId: tierId, type: type, branch: item[2],
                name: item[1], description: item[6], icon: item[3], iconType: 'emoji',
                costPoints: item[4], durationMinutes: item[5], invested: 0,
                requires: requires.slice(), status: 'idle', startedAt: null, completedAt: null, startedBy: null,
                report: item[7] || '', corrupted: false,
                dx: Math.round(dx), y: Math.round(y), seed: true, createdAt: now
            };
            opts = opts || {};
            if (opts.repeatable) {
                r.repeatable = true;
                r.maxRepeats = opts.maxRepeats || 0;
                r.completions = 0;
                r.scaling = opts.scaling || { enabled: false, temps: 0, cout: 0, vitesse: 0 };
            }
            if (opts.boost) r.boost = opts.boost;
            if (opts.group) r.group = opts.group;
            if (opts.debuff) r.debuff = opts.debuff;
            if (opts.needs > 1) {
                r.requireCounts = {};
                requires.forEach(function (id) { r.requireCounts[id] = opts.needs; });
            }
            researches.push(r);
            byCode[r.code] = r;
            return r;
        }
    }

    /* Arbres officiels des versions 2 à 5, antérieurs à l'indicateur `seed`. */
    var LEGACY_TIERS = { // nom → index du palier actuel
        'Palier 0 — Fondations': 0, 'Palier I — Équipement de terrain': 0,
        'Palier II — Détection & projection': 0, 'Palier III — Systèmes avancés': 0,
        'Palier 0 — Redécouverte': 0, 'Palier 1 — Déploiement & Reconnaissance': 1, 'Palier ██': 3
    };
    var LEGACY_RESEARCH = { // nom → code de la recherche actuelle (null : sans équivalent)
        'Atelier de prototypage': null, 'Rations longue conservation': null,
        'Inventaire centralisé des dépôts': null, 'Blindage composite Mk.I': null,
        'Munitions thaumiques calibrées': null, 'Convoi blindé de déploiement': null,
        'Compteur de Kant portable': null, 'Optique spectrale de visée': null, 'Pont aérien PHYSICS': null,
        'Exosquelette d\'intervention': null, 'Générateur de champ d\'annulation': null, 'Base avancée mobile': null,
        'Coup de Balai': 'PTL-001', 'Formulaire 108-B': 'PTL-002', 'Sac à Café Réutilisable': 'PTL-003',
        'Dépoussiérage des Archives': 'PTL-004', 'Directive « Pied de Biche »': 'PTL-100',
        'Le Vieux Clou': 'PTL-110', 'Huilage Haute Viscosité': 'PTL-111', 'Sangle à Trois Points': 'PTL-112',
        'Cartouches Traçantes Rétro': 'PTL-113', 'Brosse de Nettoyage en Laiton': 'PTL-114',
        'VERITAS v1 « Œil de Lynx »': 'PTL-120', 'Calibrage Automatique': 'PTL-121',
        'Chiffon Microfibre Anodisé': 'PTL-122', 'Filtre Antiéblouissement Thaumique': 'PTL-123',
        'K9 CNO « Bons Toutous »': 'PTL-130', 'Croquettes Anti-Radioniques': 'PTL-131',
        'Muselière Renforcée': 'PTL-132', 'Laisse en Kevlar': 'PTL-133',
        'Protocole ████': 'PTL-███', 'Signal': 'PTL-▒▒▒'
    };

    /** Met à niveau une base existante sans perdre comptes, événements ni annonces.
     *  L'arbre officiel est remplacé par sa version courante :
     *   - une recherche officielle retrouvée (même code, ou ancien nom connu) garde sa progression ;
     *   - les paliers et recherches créés à la main sont conservés, rattachés au palier
     *     équivalent, leurs prérequis réorientés et leur code renuméroté en cas de doublon. */
    function migrate(db) {
        if (!db || !(db.version >= 2 && db.version < DB_VERSION)) return false;
        var fresh = seedTree(Date.now());
        var freshByCode = {};
        fresh.researches.forEach(function (r) { freshByCode[r.code] = r; });

        var tierMap = {};     // palier officiel d'origine → palier actuel
        var researchMap = {}; // recherche officielle d'origine → recherche actuelle, ou null
        (db.tiers || []).forEach(function (t) {
            if (t.seed) {
                tierMap[t.id] = fresh.tiers.filter(function (f) { return f.name === t.name; })[0] || fresh.tiers[0];
            } else if (LEGACY_TIERS.hasOwnProperty(t.name)) {
                tierMap[t.id] = fresh.tiers[LEGACY_TIERS[t.name]] || fresh.tiers[0];
            }
        });

        var keptResearch = (db.researches || []).filter(function (r) {
            if (!r.seed && !LEGACY_RESEARCH.hasOwnProperty(r.name)) return true;
            var code = r.seed ? r.code : LEGACY_RESEARCH[r.name];
            var same = code ? freshByCode[code] || null : null;
            researchMap[r.id] = same;
            if (same) {
                same.invested = Math.min(r.invested || 0, same.costPoints);
                same.status = r.status || 'idle';
                same.startedAt = r.startedAt || null;
                same.completedAt = r.completedAt || null;
                same.startedBy = r.startedBy || null;
                same.completions = typeof r.completions === 'number' ? r.completions : (r.status === 'done' ? 1 : 0);
                if (same.repeatable && same.status === 'done') {
                    // Devenue répétable : l'achèvement acquis compte, et elle repart en financement.
                    same.status = 'idle';
                    same.invested = 0;
                }
            }
            return false;
        });

        var keptTiers = (db.tiers || []).filter(function (t) { return !tierMap[t.id]; })
            .sort(function (a, b) { return a.order - b.order; });
        keptTiers.forEach(function (t, i) {
            t.order = fresh.tiers.length + i;
            t.span = t.span || 1;
        });

        // Codes : le plus grand suffixe connu sert de point de départ aux renumérotations.
        var usedCodes = {};
        var lastNumber = 0;
        fresh.researches.concat(keptResearch).forEach(function (r) {
            var m = /(\d+)\s*$/.exec(r.code || '');
            if (m) lastNumber = Math.max(lastNumber, Number(m[1]));
        });
        fresh.researches.forEach(function (r) { usedCodes[r.code] = true; });

        var tiers = fresh.tiers.concat(keptTiers);
        keptResearch.forEach(function (r) {
            if (tierMap[r.tierId]) r.tierId = tierMap[r.tierId].id;
            var tier = tiers.filter(function (t) { return t.id === r.tierId; })[0];
            if (!tier) {
                tier = fresh.tiers[0];
                r.tierId = tier.id;
            }
            if (usedCodes[r.code]) r.code = 'PTL-' + String(++lastNumber).padStart(3, '0');
            usedCodes[r.code] = true;
            r.requires = (r.requires || []).map(function (id) {
                if (!researchMap.hasOwnProperty(id)) return id;
                return researchMap[id] ? researchMap[id].id : null;
            }).filter(function (id) { return !!id; });
            var width = tier.width || (tier.span || 1) * LANE_W;
            r.dx = Math.max(40, Math.min(width - 40, r.dx == null ? width / 2 : r.dx));
        });

        db.tiers = tiers;
        db.researches = fresh.researches.concat(keptResearch);

        // Recherches perso : nombres d'achèvements exigés, rattachés aux nouveaux identifiants.
        keptResearch.forEach(function (r) {
            if (!r.requireCounts) return;
            var counts = {};
            Object.keys(r.requireCounts).forEach(function (id) {
                var to = researchMap.hasOwnProperty(id) ? (researchMap[id] && researchMap[id].id) : id;
                if (to && r.requires.indexOf(to) >= 0) counts[to] = r.requireCounts[id];
            });
            r.requireCounts = counts;
        });
        // Boosts en cours accordés par une recherche officielle remplacée.
        (db.events || []).forEach(function (e) {
            if (e.sourceId && researchMap.hasOwnProperty(e.sourceId)) {
                e.sourceId = researchMap[e.sourceId] ? researchMap[e.sourceId].id : null;
            }
        });
        if (!db.announcements) db.announcements = [];
        db.version = DB_VERSION;
        return true;
    }

    function seed() {
        var now = Date.now();
        var tree = seedTree(now);

        return {
            version: DB_VERSION,
            createdAt: now,
            settings: {
                basePoints: 300 // PR offerts à la validation d'un compte
            },
            users: [
                {
                    id: uid('usr'),
                    username: 'Admin',
                    passwordHash: hash('GOConTOP'),
                    rpName: 'Console de développement',
                    discord: '—',
                    google: '—',
                    team: null,
                    role: 'admin',
                    hidden: true, // compte dev : invisible de tous les autres comptes
                    status: 'approved',
                    points: 999999,
                    createdAt: now,
                    approvedAt: now,
                    approvedBy: null,
                    note: ''
                }
            ],
            tiers: tree.tiers,
            researches: tree.researches,
            events: [
                {
                    id: uid('evt'),
                    name: 'Crédits d\'urgence du Conseil',
                    description: 'Le Conseil des 108 débloque une enveloppe exceptionnelle pour la division.',
                    type: 'cout',
                    value: -10,
                    startsAt: now,
                    endsAt: now + 3 * 864e5,
                    enabled: true,
                    createdAt: now
                }
            ],
            announcements: [
                {
                    id: uid('ann'),
                    title: 'Ouverture du portail PTOLÉMÉE',
                    body: 'Les demandes d\'affectation sont ouvertes. Précisez votre équipe : Quartier-maître ou Recherche & Développement.',
                    kind: 'info',
                    startsAt: now,
                    endsAt: null,
                    enabled: true,
                    createdAt: now
                }
            ],
            logs: [
                { id: uid('log'), at: now, actor: 'système', action: 'Initialisation', detail: 'Base de données PTOLÉMÉE générée.', hidden: false }
            ],
            sessions: []
        };
    }

    /** Base vide : affichée tant que le serveur n'a pas répondu. */
    function emptyDb() {
        return {
            version: DB_VERSION, createdAt: Date.now(), settings: {},
            users: [], tiers: [], researches: [], events: [], announcements: [], logs: [], sessions: []
        };
    }

    var Store = {
        _db: null,

        load: function () {
            if (Store._db) return Store._db;
            if (REMOTE) return (Store._db = emptyDb());
            var raw = null;
            try {
                raw = localStorage.getItem(DB_KEY);
                LEGACY_KEYS.forEach(function (k) { localStorage.removeItem(k); });
            } catch (e) { /* noop */ }
            if (raw) {
                try {
                    var parsed = JSON.parse(raw);
                    var migrated = migrate(parsed);
                    if (parsed && parsed.version === DB_VERSION) {
                        if (!parsed.announcements) parsed.announcements = [];
                        Store._db = parsed;
                        if (migrated) Store.save();
                        return Store._db;
                    }
                } catch (e) { /* base corrompue : on régénère */ }
            }
            Store._db = seed();
            Store.save();
            return Store._db;
        },

        save: function () {
            if (REMOTE) return; // l'état officiel vit sur le serveur
            try {
                localStorage.setItem(DB_KEY, JSON.stringify(Store._db));
            } catch (e) {
                console.warn('Sauvegarde impossible (stockage plein ou bloqué).', e);
            }
        },

        reset: function () {
            Store._db = seed();
            Store.save();
            Cookies.remove(SESSION_COOKIE);
            Auth._cache = undefined;
        },

        replace: function (obj) {
            Store._db = obj;
            if (!Store._db.announcements) Store._db.announcements = [];
            Store.save();
        },

        /** Base neuve (arbre officiel), sans l'enregistrer. */
        fresh: function () {
            return seed();
        },

        /** Met une base à la version courante (utilisé par le serveur). Vrai si elle a changé. */
        migrate: function (db) {
            return migrate(db);
        },

        /** Mode Firebase : remplace la copie d'affichage par l'état reçu du serveur. */
        hydrate: function (state, meId) {
            Store._db = state || emptyDb();
            ['users', 'tiers', 'researches', 'events', 'announcements', 'logs', 'sessions'].forEach(function (k) {
                if (!Store._db[k]) Store._db[k] = [];
            });
            if (!Store._db.settings) Store._db.settings = {};
            Auth._remoteId = meId || null;
            Auth._cache = undefined;
        },

        /** Les actions d'un compte masqué (dev) sont marquées `hidden` et
         *  n'apparaissent que dans le journal vu par ce même niveau. */
        log: function (action, detail, actor) {
            var db = Store.load();
            var current = Auth.current();
            var name = actor || (current ? current.username : 'anonyme');
            var who = db.users.filter(function (u) { return u.username === name; })[0];
            db.logs.unshift({
                id: freshUid('log'),
                at: Date.now(),
                actor: name,
                action: action,
                detail: detail || '',
                hidden: !!(who && who.hidden)
            });
            db.logs = db.logs.slice(0, 400);
            Store.save();
        }
    };

    /* ----------------------------------------------------------------------
       Authentification
       ---------------------------------------------------------------------- */

    var Auth = {
        _cache: undefined,

        /** Enregistre une demande d'accès. Le compte reste en attente tant
         *  qu'un haut gradé ne l'a pas validé. */
        register: function (data) {
            var db = Store.load();
            var username = (data.username || '').trim();

            if (username.length < 3) return err('L\'identifiant doit contenir au moins 3 caractères.');
            if (!/^[A-Za-z0-9_.-]+$/.test(username)) return err('Identifiant : lettres, chiffres, - _ . uniquement.');
            if (db.users.some(function (u) { return u.username.toLowerCase() === username.toLowerCase(); })) {
                return err('Cet identifiant est déjà pris.');
            }
            if ((data.password || '').length < 8) return err('Le mot de passe doit contenir au moins 8 caractères.');
            if (data.password !== data.password2) return err('Les deux mots de passe ne correspondent pas.');
            if (!(data.rpName || '').trim()) return err('Le nom RP est obligatoire.');
            if (!TEAMS[data.team]) return err('Choisissez votre équipe.');
            if ((data.discord || '').trim().length < 2) return err('Identifiant Discord invalide.');
            if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test((data.google || '').trim())) return err('Adresse Google invalide.');
            if (!data.terms) return err('Vous devez accepter les conditions d\'utilisation.');

            var user = {
                id: uid('usr'),
                username: username,
                passwordHash: hash(data.password),
                rpName: data.rpName.trim(),
                discord: data.discord.trim(),
                google: data.google.trim(),
                team: data.team,
                role: 'chercheur',
                hidden: false,
                status: 'pending',
                points: 0,
                createdAt: Date.now(),
                approvedAt: null,
                approvedBy: null,
                note: (data.motivation || '').trim()
            };
            db.users.push(user);
            Store.save();
            Store.log('Demande d\'accès', username + ' (« ' + user.rpName + ' », ' + TEAMS[user.team].label + ') a déposé une demande.', username);
            return { ok: true, user: user };
        },

        login: function (username, password, remember) {
            var db = Store.load();
            var user = db.users.filter(function (u) {
                return u.username.toLowerCase() === String(username || '').trim().toLowerCase();
            })[0];

            if (!user || user.passwordHash !== hash(password)) {
                return err('Identifiant ou mot de passe incorrect.');
            }
            if (user.status === 'pending') {
                return err('Votre demande est encore en attente de validation par un haut gradé.');
            }
            if (user.status === 'rejected') {
                return err('Votre demande d\'accès a été refusée. Contactez le commandement.');
            }
            if (user.status === 'suspended') {
                return err('Ce compte est suspendu.');
            }

            var token = uid('ses');
            var lifetimeDays = remember && Consent.allows('persistance') ? 30 : 0;
            db.sessions = db.sessions.filter(function (s) { return s.expiresAt > Date.now(); });
            db.sessions.push({
                token: token,
                userId: user.id,
                createdAt: Date.now(),
                expiresAt: Date.now() + (lifetimeDays || 1) * 864e5,
                persistent: !!lifetimeDays
            });
            Store.save();

            Cookies.set(SESSION_COOKIE, token, lifetimeDays || null);
            Auth._cache = undefined;
            Store.log('Connexion', user.username + ' s\'est connecté.', user.username);
            return { ok: true, user: user, remembered: !!lifetimeDays };
        },

        /** `done` est appelé une fois la session fermée (immédiatement en mode local). */
        logout: function (done) {
            if (REMOTE) {
                Auth._cache = null;
                var remote = global.GOC && global.GOC.Remote;
                var p = remote ? remote.signOut() : null;
                if (p && p.then) p.then(done || function () {}, done || function () {});
                else if (done) done();
                return;
            }
            var token = Cookies.get(SESSION_COOKIE);
            var db = Store.load();
            db.sessions = db.sessions.filter(function (s) { return s.token !== token; });
            Store.save();
            Cookies.remove(SESSION_COOKIE);
            Auth._cache = undefined;
            if (done) done();
        },

        current: function () {
            if (Auth._cache !== undefined) return Auth._cache;
            if (REMOTE) {
                var mine = Store.load().users.filter(function (u) { return u.id === Auth._remoteId; })[0] || null;
                Auth._cache = mine && mine.status === 'approved' ? mine : null;
                return Auth._cache;
            }
            var token = Cookies.get(SESSION_COOKIE);
            if (!token) { Auth._cache = null; return null; }
            var db = Store.load();
            var session = db.sessions.filter(function (s) { return s.token === token; })[0];
            if (!session || session.expiresAt < Date.now()) {
                Cookies.remove(SESSION_COOKIE);
                Auth._cache = null;
                return null;
            }
            var user = db.users.filter(function (u) { return u.id === session.userId; })[0] || null;
            if (user && user.status !== 'approved') user = null;
            Auth._cache = user;
            return user;
        },

        role: function () {
            var u = Auth.current();
            return u ? u.role : 'guest';
        },

        level: function () {
            return (ROLES[Auth.role()] || ROLES.guest).level;
        },

        can: function (minRole) {
            return Auth.level() >= (ROLES[minRole] || ROLES.admin).level;
        },

        /** Comptes que l'utilisateur courant a le droit de voir : le compte dev
         *  n'apparaît que pour lui-même. */
        visibleUsers: function () {
            var db = Store.load();
            if (Auth.can('admin')) return db.users.slice();
            return db.users.filter(function (u) { return !u.hidden; });
        },

        /** Protège une page : redirige vers la connexion si le niveau est insuffisant. */
        require: function (minRole, redirect) {
            if (!Auth.can(minRole)) {
                var target = redirect || 'connexion.html';
                location.replace(target + '?requis=' + encodeURIComponent(minRole) +
                    '&suite=' + encodeURIComponent(location.pathname.split('/').pop() || 'index.html'));
                return false;
            }
            return true;
        },

        refresh: function () {
            Auth._cache = undefined;
            return Auth.current();
        }
    };

    function err(message) {
        return { ok: false, error: message };
    }

    /* ----------------------------------------------------------------------
       Annonces
       ---------------------------------------------------------------------- */

    var News = {
        KINDS: {
            info: 'Information',
            positif: 'Bonne nouvelle',
            negatif: 'Mauvaise nouvelle',
            alerte: 'Alerte'
        },

        active: function () {
            var now = Date.now();
            return (Store.load().announcements || []).filter(function (a) {
                if (!a.enabled) return false;
                if (a.startsAt && now < a.startsAt) return false;
                if (a.endsAt && now > a.endsAt) return false;
                return true;
            }).sort(function (a, b) { return (b.startsAt || 0) - (a.startsAt || 0); });
        },

        upsert: function (data) {
            var db = Store.load();
            var a = data.id ? db.announcements.filter(function (x) { return x.id === data.id; })[0] : null;
            if (!a) {
                a = { id: uid('ann'), createdAt: Date.now() };
                db.announcements.push(a);
            }
            a.title = data.title;
            a.body = data.body || '';
            a.kind = News.KINDS[data.kind] ? data.kind : 'info';
            a.startsAt = data.startsAt ? new Date(data.startsAt).getTime() : Date.now();
            a.endsAt = data.endsAt ? new Date(data.endsAt).getTime() : null;
            a.enabled = data.enabled !== false;
            Store.save();
            Store.log('Annonce enregistrée', a.title);
            return a;
        },

        remove: function (id) {
            var db = Store.load();
            db.announcements = db.announcements.filter(function (a) { return a.id !== id; });
            Store.save();
            Store.log('Annonce supprimée', id);
        },

        toggle: function (id) {
            var a = (Store.load().announcements || []).filter(function (x) { return x.id === id; })[0];
            if (!a) return err('Annonce introuvable.');
            a.enabled = !a.enabled;
            Store.save();
            Store.log(a.enabled ? 'Annonce publiée' : 'Annonce retirée', a.title);
            return { ok: true, enabled: a.enabled };
        }
    };

    /* ----------------------------------------------------------------------
       Interface : navigation, toasts, modales, utilitaires
       ---------------------------------------------------------------------- */

    var NAV = [
        { href: 'index.html', label: 'Accueil', min: 'guest' },
        { href: 'ptolemee.html', label: 'La Division', min: 'guest' },
        { href: 'decouvertes.html', label: 'Découvertes', min: 'guest' },
        { href: 'laboratoire.html', label: 'Laboratoire', min: 'chercheur' },
        { href: 'recherches.html', label: 'Archives', min: 'membre' },
        { href: 'admin.html', label: 'Commandement', min: 'gradé' }
    ];

    var GLYPHS = '█▓▒░';

    var THEMES = { clair: 'Clair', sombre: 'Sombre' };

    /** Thème d'affichage. Sans choix explicite, le site suit la préférence
     *  système (media query côté CSS) ; un clic sur la bascule fixe le thème
     *  et le mémorise comme préférence d'affichage. */
    var Theme = {
        /** Thème forcé par l'utilisateur, ou null si l'on suit le système. */
        stored: function () {
            try {
                var v = localStorage.getItem('pref::theme');
                return THEMES[v] ? v : null;
            } catch (e) { return null; }
        },

        /** Thème réellement affiché. */
        current: function () {
            var forced = Theme.stored();
            if (forced) return forced;
            return global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches
                ? 'sombre' : 'clair';
        },

        apply: function (name) {
            var root = document.documentElement;
            if (THEMES[name]) root.setAttribute('data-theme', name);
            else root.removeAttribute('data-theme');
        },

        set: function (name) {
            Theme.apply(name);
            UI.pref('theme', name);
            try { localStorage.setItem('pref::theme', name); } catch (e) { /* noop */ }
        },

        toggle: function () {
            var next = Theme.current() === 'sombre' ? 'clair' : 'sombre';
            Theme.set(next);
            return next;
        },

        boot: function () {
            Theme.apply(Theme.stored());
        }
    };

    var UI = {
        escape: function (text) {
            return String(text == null ? '' : text)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        },

        /** Altère aléatoirement une partie des caractères d'un texte. */
        glitch: function (text, ratio) {
            var r = ratio == null ? 0.28 : ratio;
            return String(text || '').split('').map(function (ch) {
                if (ch === ' ' || Math.random() > r) return ch;
                return GLYPHS.charAt(Math.floor(Math.random() * GLYPHS.length));
            }).join('');
        },

        toast: function (message, kind) {
            var zone = document.getElementById('toast-zone');
            if (!zone) {
                zone = document.createElement('div');
                zone.id = 'toast-zone';
                document.body.appendChild(zone);
            }
            var el = document.createElement('div');
            el.className = 'toast ' + (kind || '');
            el.textContent = message;
            zone.appendChild(el);
            setTimeout(function () {
                el.style.transition = 'opacity .3s';
                el.style.opacity = '0';
                setTimeout(function () { el.remove(); }, 300);
            }, 3600);
        },

        modal: function (title, bodyHTML, onMount) {
            var back = document.createElement('div');
            back.className = 'modal-backdrop';
            back.innerHTML =
                '<div class="modal" role="dialog" aria-modal="true">' +
                '<div class="modal-head"><h2>' + UI.escape(title) + '</h2>' +
                '<button class="modal-close" type="button" aria-label="Fermer">&times;</button></div>' +
                '<div class="modal-body"></div></div>';
            back.querySelector('.modal-body').innerHTML = bodyHTML;
            document.body.appendChild(back);

            function close() { back.remove(); document.removeEventListener('keydown', onKey); }
            function onKey(e) { if (e.key === 'Escape') close(); }

            back.querySelector('.modal-close').addEventListener('click', close);
            back.addEventListener('click', function (e) { if (e.target === back) close(); });
            document.addEventListener('keydown', onKey);
            if (onMount) onMount(back.querySelector('.modal-body'), close);
            return close;
        },

        /** Formate une durée en minutes vers « 2 j 3 h 20 min ». */
        duration: function (minutes) {
            var m = Math.max(0, Math.round(minutes));
            var d = Math.floor(m / 1440);
            var h = Math.floor((m % 1440) / 60);
            var mi = m % 60;
            var out = [];
            if (d) out.push(d + ' j');
            if (h) out.push(h + ' h');
            if (mi || !out.length) out.push(mi + ' min');
            return out.join(' ');
        },

        countdown: function (ms) {
            if (ms <= 0) return '00:00:00';
            var s = Math.floor(ms / 1000);
            var d = Math.floor(s / 86400);
            var h = String(Math.floor((s % 86400) / 3600)).padStart(2, '0');
            var m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
            var sec = String(s % 60).padStart(2, '0');
            return (d ? d + ' j ' : '') + h + ':' + m + ':' + sec;
        },

        date: function (ts) {
            if (!ts) return '—';
            return new Date(ts).toLocaleString('fr-FR', {
                day: '2-digit', month: '2-digit', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
            });
        },

        number: function (n) {
            return Number(n || 0).toLocaleString('fr-FR');
        },

        iconHTML: function (item) {
            if (item.iconType === 'image' && item.icon) {
                return '<img src="' + UI.escape(item.icon) + '" alt="">';
            }
            if (global.GOC && global.GOC.Icons) return global.GOC.Icons.html(item.icon);
            return UI.escape(item.icon || '❔');
        },

        teamLabel: function (team) {
            return TEAMS[team] ? TEAMS[team].label : '—';
        },

        header: function () {
            var host = document.querySelector('[data-header]');
            if (!host) return;
            var user = Auth.current();
            var here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();

            var links = NAV.filter(function (item) { return Auth.can(item.min); })
                .map(function (item) {
                    var active = item.href.toLowerCase() === here ? ' class="active"' : '';
                    return '<li><a href="' + item.href + '"' + active + '>' + item.label + '</a></li>';
                }).join('');

            var side;
            if (user && user.hidden) {
                side = '<span class="badge badge-corrupt">DEV</span>' +
                    '<button class="btn btn-ghost btn-sm" type="button" data-logout>Déconnexion</button>';
            } else if (user) {
                side = '<span class="badge badge-main" title="' + UI.escape(user.rpName) + '">' +
                    UI.escape(user.username) + ' · ' + ROLES[user.role].label +
                    (TEAMS[user.team] ? ' · ' + TEAMS[user.team].short : '') + '</span>' +
                    '<span class="badge" id="hdr-points">' + UI.number(user.points) + ' PR</span>' +
                    '<button class="btn btn-ghost btn-sm" type="button" data-logout>Déconnexion</button>';
            } else {
                side = '<a class="btn btn-ghost btn-sm" href="connexion.html">Connexion</a>' +
                    '<a class="btn btn-sm" href="inscription.html">Demander un accès</a>';
            }

            host.innerHTML =
                '<div class="wrap navbar">' +
                    '<a class="brand" href="index.html">' +
                        '<span class="sigil">' +
                            '<img class="sigil-clair" src="assets/ptolemee-bleu.png" alt="Emblème de la Division PTOLÉMÉE">' +
                            '<img class="sigil-sombre" src="assets/ptolemee-blanc.png" alt="" aria-hidden="true">' +
                        '</span>' +
                        '<span><strong>PTOLÉMÉE</strong><span class="sub">Division de soutien</span></span>' +
                    '</a>' +
                    '<button class="menu-toggle" type="button" aria-label="Ouvrir le menu" aria-expanded="false">' +
                        '<span></span><span></span><span></span></button>' +
                    '<ul class="nav-links">' + links + '</ul>' +
                    '<div class="nav-side">' +
                        '<button class="btn btn-ghost btn-sm theme-toggle" type="button" data-theme-toggle ' +
                            'aria-label="Basculer entre le thème clair et le thème sombre" title="Thème clair / sombre">' +
                            '<svg class="ico ico-moon" viewBox="0 0 24 24" aria-hidden="true">' +
                                '<path d="M20.5 14.3A8.5 8.5 0 0 1 9.7 3.5a8.5 8.5 0 1 0 10.8 10.8Z"></path></svg>' +
                            '<svg class="ico ico-sun" viewBox="0 0 24 24" aria-hidden="true">' +
                                '<circle cx="12" cy="12" r="4"></circle>' +
                                '<path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2' +
                                'M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"></path></svg>' +
                        '</button>' + side + '</div>' +
                '</div>';

            var toggle = host.querySelector('.menu-toggle');
            var list = host.querySelector('.nav-links');
            toggle.addEventListener('click', function () {
                var open = list.classList.toggle('is-open');
                toggle.setAttribute('aria-expanded', String(open));
            });
            list.addEventListener('click', function () {
                list.classList.remove('is-open');
                toggle.setAttribute('aria-expanded', 'false');
            });
            var themeBtn = host.querySelector('[data-theme-toggle]');
            if (themeBtn) {
                themeBtn.addEventListener('click', function () { Theme.toggle(); });
            }
            var out = host.querySelector('[data-logout]');
            if (out) {
                out.addEventListener('click', function () {
                    out.disabled = true;
                    Auth.logout(function () { location.href = 'index.html'; });
                });
            }
        },

        footer: function () {
            var host = document.querySelector('[data-footer]');
            if (!host) return;
            host.innerHTML =
                '<div class="wrap footer-inner">' +
                    '<div><strong>Global Occult Coalition</strong> — Division PTOLÉMÉE<br>' +
                    '<span class="dim">Œuvre de fiction. Aucun lien avec une organisation réelle.</span></div>' +
                    '<div>' +
                        '<a href="conditions.html">Conditions d\'utilisation</a>' +
                        '<a href="conditions.html#cookies">Cookies</a>' +
                        '<a href="#" data-cookie-settings>Gérer mes cookies</a>' +
                    '</div>' +
                '</div>';
            host.querySelectorAll('[data-cookie-settings]').forEach(function (el) {
                el.addEventListener('click', function (e) {
                    e.preventDefault();
                    UI.cookieBanner(true);
                });
            });
        },

        /** Affiche les annonces actives dans chaque [data-announcements]. */
        announcements: function () {
            var hosts = document.querySelectorAll('[data-announcements]');
            if (!hosts.length) return;
            var list = News.active();
            var html = list.map(function (a) {
                return '<article class="announce announce-' + a.kind + '">' +
                    '<span class="eyebrow">' + News.KINDS[a.kind] + ' · ' + UI.date(a.startsAt) + '</span>' +
                    '<h3>' + UI.escape(a.title) + '</h3>' +
                    (a.body ? '<p>' + UI.escape(a.body) + '</p>' : '') +
                    '</article>';
            }).join('');
            hosts.forEach(function (h) { h.innerHTML = html; });
        },

        /** Bandeau de consentement. `force` le rouvre depuis le pied de page. */
        cookieBanner: function (force) {
            var existing = document.querySelector('.cookie-banner');
            if (existing) existing.remove();
            var saved = Consent.read();
            if (saved && !force) return;

            var el = document.createElement('section');
            el.className = 'cookie-banner';
            el.setAttribute('role', 'dialog');
            el.setAttribute('aria-label', 'Gestion des cookies');
            el.innerHTML =
                '<h3>🍪 Cookies</h3>' +
                '<p>Ce site utilise un nombre minimal de cookies. Aucun traceur publicitaire, ' +
                'aucun partage avec un tiers.</p>' +
                '<ul>' +
                    '<li><b>Essentiels</b> (toujours actifs) : conservent votre session le temps ' +
                    'de la visite et mémorisent ce choix de consentement.</li>' +
                    '<li><b>Connexion enregistrée</b> : garde votre session ouverte 30 jours pour ' +
                    'ne pas ressaisir vos identifiants (case « Rester connecté »).</li>' +
                    '<li><b>Préférences</b> : retient vos filtres, la vue choisie et vos onglets.</li>' +
                '</ul>' +
                '<label class="check"><input type="checkbox" id="ck-persist" ' +
                    (saved ? (saved.persistance ? 'checked' : '') : 'checked') +
                    '> Autoriser la connexion enregistrée (30 jours)</label>' +
                '<label class="check"><input type="checkbox" id="ck-pref" ' +
                    (saved ? (saved.preferences ? 'checked' : '') : 'checked') +
                    '> Autoriser la mémorisation des préférences d\'affichage</label>' +
                '<div class="cookie-actions">' +
                    '<button class="btn" type="button" data-ck="all">Tout accepter</button>' +
                    '<button class="btn btn-ghost" type="button" data-ck="choice">Enregistrer mes choix</button>' +
                    '<button class="btn btn-ghost" type="button" data-ck="none">Essentiels uniquement</button>' +
                '</div>' +
                '<p class="dim" style="margin-top:.8rem">Détail complet dans les ' +
                '<a href="conditions.html#cookies">conditions d\'utilisation</a>.</p>';

            document.body.appendChild(el);

            el.querySelectorAll('[data-ck]').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    var mode = btn.getAttribute('data-ck');
                    var choice = mode === 'all'
                        ? { persistance: true, preferences: true }
                        : mode === 'none'
                            ? { persistance: false, preferences: false }
                            : {
                                persistance: el.querySelector('#ck-persist').checked,
                                preferences: el.querySelector('#ck-pref').checked
                            };
                    Consent.save(choice);
                    if (!choice.persistance) {
                        // On repasse la session courante en durée de visite.
                        var token = Cookies.get(SESSION_COOKIE);
                        if (token) Cookies.set(SESSION_COOKIE, token, null);
                    }
                    el.remove();
                    UI.toast('Préférences cookies enregistrées.', 'ok');
                });
            });
        },

        /** Mémorise une préférence d'affichage si l'utilisateur l'a autorisé. */
        pref: function (key, value) {
            if (!Consent.allows('preferences')) return null;
            try {
                if (value === undefined) return localStorage.getItem('pref::' + key);
                localStorage.setItem('pref::' + key, value);
            } catch (e) { /* noop */ }
            return value;
        },

        boot: function () {
            Theme.boot();
            UI.header();
            UI.footer();
            UI.announcements();
            UI.cookieBanner(false);
        }
    };

    global.GOC = {
        Cookies: Cookies,
        Consent: Consent,
        Store: Store,
        Auth: Auth,
        News: News,
        Theme: Theme,
        UI: UI,
        ROLES: ROLES,
        TEAMS: TEAMS,
        LANE_W: LANE_W,
        uid: uid,
        hash: hash,
        SESSION_COOKIE: SESSION_COOKIE,
        remote: REMOTE,
        ready: ready,
        markReady: markReady,
        _tape: function (tape) { uidTape = tape; }
    };
})(window);

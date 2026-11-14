/* ==========================================================================
   GOC — Division PTOLÉMÉE · Jeu d'icônes
   Les recherches portent un identifiant d'icône (ou, pour les données
   historiques, un emoji) dans `icon`, avec `iconType: 'emoji'`. Tout est
   projeté sur une planche unique de symboles SVG en trait fin, monochromes,
   réutilisée par les cartes, la fiche, la console et l'arbre (via <use>).
   Un identifiant inconnu retombe sur l'hexagone générique.
   ========================================================================== */

(function (global) {
    'use strict';

    var SPRITE_ID = 'goc-icon-sprite';

    /* Grille 24×24, trait 1.6. Un tracé par icône. */
    var PATHS = {
        /* Armement */
        rifle: 'M3 11.5h13l4.5-2v3l-4.5 1H3z M6 13.5v3 M11 13.5v2.5 M16.5 9.5V7.5 M3 11.5V9.5',
        pistol: 'M3.5 7.5h12v4.5h-3.2l-1.8 3H8l-1-3H3.5z M6 15v4h3.5',
        shotgun: 'M3 10.5h17.5v2.5H3z M5.5 13v3.5 M12.5 13v2.5 M20.5 10.5V8',
        ammo: 'M7 4.5h4l1 3v8.5a3 3 0 0 1-6 0V7.5z M6.5 12h5.5 M15 8.5h3.5v8H15z',
        grenade: 'M12 20.5a6.2 6.2 0 1 0 0-12.4 6.2 6.2 0 0 0 0 12.4z M9.8 8.3V6h4.4v2.3 M14.2 6l3.3-2.2',
        knife: 'M3.5 20.5l7-7 M10.5 13.5l6.5-9.5 3.2 3.2-9.5 6.3z',
        rocket: 'M12 3c3 2.6 4.6 6.1 4.6 9.7L12 17.2l-4.6-4.5C7.4 9.1 9 5.6 12 3z M9 17.2l-2 4.3 5-2 5 2-2-4.3 M12 10.6a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8z',
        explosive: 'M12 20.5a6.2 6.2 0 1 0 0-12.4 6.2 6.2 0 0 0 0 12.4z M12 8.1V3.5 M6 14.3H2.5 M18 14.3h3.5 M7.2 9.5 4.8 7.1 M16.8 9.5l2.4-2.4',
        turret: 'M3.5 18.5h17 M7 18.5v-4.5h10v4.5 M12 14V9 M9 9h6 M12 9V5',
        target: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M12 12.8a.8.8 0 1 0 0-1.6.8.8 0 0 0 0 1.6z',

        /* Optique et détection */
        eye: 'M2.5 12s3.7-5.8 9.5-5.8S21.5 12 21.5 12 17.8 17.8 12 17.8 2.5 12 2.5 12z M12 14.4a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8z',
        search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z M15.2 15.2 20 20',
        scope: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M12 3.5v4.5 M12 16v4.5 M3.5 12H8 M16 12h4.5 M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
        radar: 'M12 20a8 8 0 1 0-8-8 M12 12l5.5-5.5 M12 13.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4z M12 20a8 8 0 0 0 8-8',
        antenna: 'M12 20.5v-6.5 M8.6 10.6a4.8 4.8 0 0 1 6.8 0 M6.2 8.2a8.2 8.2 0 0 1 11.6 0 M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
        goggles: 'M3 9.5h18v5.5a2 2 0 0 1-2 2h-4l-3-2.8-3 2.8H5a2 2 0 0 1-2-2z M7 6.5 9 9.5 M17 6.5 15 9.5',
        camera: 'M3.5 8h4.2l1.6-2.2h5.4L16.3 8h4.2v11.5H3.5z M12 17.2a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2z',
        thermo: 'M14 14.6V5.2a2 2 0 1 0-4 0v9.4a4 4 0 1 0 4 0z M12 12.4v4.4',
        microscope: 'M9.5 3.5h4.2v7H9.5z M11.6 10.5v5.2 M5.5 20.5h13 M8 16.2h7.5 M15.5 6h2.2v4.5',
        wave: 'M3.2 9.2c2 0 2.5-1.6 4.4-1.6s2.5 1.6 4.4 1.6 2.5-1.6 4.4-1.6 2.5 1.6 4.4 1.6 M3.2 14.6c2 0 2.5-1.6 4.4-1.6s2.5 1.6 4.4 1.6 2.5-1.6 4.4-1.6 2.5 1.6 4.4 1.6',

        /* Aéronefs et drones */
        drone: 'M12 14.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2z M6.4 4.4a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z M17.6 4.4a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z M8.1 8.1l2 2 M15.9 8.1l-2 2 M10 13.9 7.4 16.5 M14 13.9l2.6 2.6 M5.6 19.4h5 M13.4 19.4h5',
        helicopter: 'M3.5 5.5h17 M12 5.5v3.2 M6.5 8.7h10.5v4.6H6.5z M17 10.5h4 M8.5 17.5h8 M12 13.3v4.2',
        plane: 'M11 3.2h2l1 8.2 6.5 3v2.2l-6.5-1.6-.6 4.4 2.1 2v1l-3.5-1-3.5 1v-1l2.1-2-.6-4.4L3.5 18.6v-2.2l6.5-3z',
        parachute: 'M3 12a9 9 0 0 1 18 0z M8.5 12 12 20.5 15.5 12 M12 3.2V12',
        satellite: 'M6.2 10.2 10 6.4l3.4 3.4-3.8 3.8z M14.2 14.2 18 10.4l3.4 3.4-3.8 3.8z M9.6 13.6 6.4 16.8 M14.4 9.8 17.6 6.6 M4.5 17.5l2.2 2.2',

        /* Véhicules terrestres */
        tank: 'M3 14.5h17.5v4.2H3z M6.5 14.5v-3.2h9v3.2 M15.5 12.5h5.5 M6.8 18.7h11',
        truck: 'M3 16h10.5V7H3z M13.5 10.8h4.2l3 3V16h-7.2 M7 19a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z M17.5 19a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z',
        wheel: 'M12 19.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15z M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z M12 4.5v4.3 M12 15.2v4.3 M4.5 12h4.3 M15.2 12h4.3',
        fuel: 'M6 20.5V6a2 2 0 0 1 2-2h5v16.5z M13 9h3l2 2.2v6.8a2 2 0 0 1-4 0v-4.8 M9 8h3',

        /* Protection */
        shield: 'M12 3l8 3v6c0 5-3.6 8.2-8 9.2-4.4-1-8-4.2-8-9.2V6z',
        helmet: 'M4 15.5a8 8 0 0 1 16 0v1.8H4z M3.5 17.3h17 M12 7.5v-2',
        vest: 'M8.2 4 5 6.2v14.3h14V6.2L15.8 4l-3.8 3z M12 7v13.5 M5 11h3 M16 11h3',
        suit: 'M7 4h10v16.5H7z M12 4v6 M9.5 20.5v-4 M14.5 20.5v-4 M9.5 7h5',
        mask: 'M4 7h16v5a6 6 0 0 1-6 6h-4a6 6 0 0 1-6-6z M8.5 11.2h.01 M15.5 11.2h.01 M9 15h6',
        extinguisher: 'M9 8h6v12.5H9z M11 8V5h2v3 M15 10.2h3.2 M9 12.2h6',
        wall: 'M3 7.5h18v9H3z M3 12h18 M9 7.5v4.5 M15 12v4.5',

        /* Laboratoire */
        flask: 'M9 3h6 M10 3v6.2L5.6 17a2 2 0 0 0 1.7 3h9.4a2 2 0 0 0 1.7-3L14 9.2V3 M7.6 14h8.8',
        vial: 'M9 3.5h6 M10 3.5v12.8a2 2 0 0 0 4 0V3.5 M10 11h4',
        atom: 'M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M4.5 8.6c4-2.6 11-2.6 15 0 M4.5 15.4c4 2.6 11 2.6 15 0 M12 3.5c-3 4-3 13 0 17 M12 3.5c3 4 3 13 0 17',
        dna: 'M8 3.2c0 6 8 6 8 12 M16 3.2c0 6-8 6-8 12 M8 7h8 M8.5 16h7 M9 20.8h6',
        syringe: 'M3.2 20.8l4-4 M6 14l4 4 8.2-8.2-4-4z M14 4l3.2 3.2 M16.2 10.2l-2.4-2.4 M11 13.4l-2-2',
        medic: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M12 8.5v7 M8.5 12h7',
        cup: 'M4 7.5h12v5.5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z M16 9h2.2a2.5 2.5 0 0 1 0 5H16 M3 21h14',

        /* Énergie et électronique */
        battery: 'M3.2 8.4h14.4v7.2H3.2z M19.6 11v2 M6.6 11v2 M10 11v2 M13.4 11v2',
        bolt: 'M13.2 3 6 13h5l-1 8 7.2-10.2h-5z',
        chip: 'M7 7h10v10H7z M3.8 10h3.2 M3.8 14h3.2 M17 10h3.2 M17 14h3.2 M10 3.8V7 M14 3.8V7 M10 17v3.2 M14 17v3.2',
        magnet: 'M6 4h4v8a2 2 0 0 0 4 0V4h4v8a6 6 0 0 1-12 0z M6 8.5h4 M14 8.5h4',
        solar: 'M4 6.5h16l-2.2 8.5H6.2z M12 15v4.5 M8.5 19.5h7 M9 6.5l-1 8.5 M15 6.5l1 8.5',
        tool: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z M12 2.8v2.6M12 18.6v2.6M4.5 12H7m10 0h2.5M6.7 6.7l1.8 1.8m7 7 1.8 1.8m0-10.6-1.8 1.8m-7 7-1.8 1.8',

        /* Logistique */
        box: 'M3.6 7.6 12 3.4l8.4 4.2v8.8L12 20.6l-8.4-4.2z M3.6 7.6 12 11.8l8.4-4.2 M12 11.8v8.8',
        crate: 'M4 7h16v13.5H4z M4 11.2h16 M9 7v13.5 M15 7v13.5',
        warehouse: 'M3 20.5V9.8L12 4.5l9 5.3v10.7z M9 20.5v-6.2h6v6.2',
        clipboard: 'M9 3.5h6v3H9z M6.5 5.5h11v15h-11z M9.5 11h5 M9.5 15h3.5',
        scale: 'M12 4v16.5 M6 20.5h12 M4 8h16 M4 8l-2 5h4z M20 8l-2 5h4z M12 4a1.2 1.2 0 1 0 0 2.4',
        link: 'M9.4 14.6l5.2-5.2 M8 12.2 6.3 13.9a3.6 3.6 0 0 0 5.1 5.1l1.7-1.7 M16 11.8l1.7-1.7a3.6 3.6 0 0 0-5.1-5.1L10.9 6.7',
        brush: 'M4 20.2l4.2-1 9-9-3.2-3.2-9 9z M13.6 4.6l3.2 3.2 3-3-3.2-3.2z M4 20.2 8.2 19',
        drop: 'M12 3.2s6 6.4 6 10.3a6 6 0 0 1-12 0c0-3.9 6-10.3 6-10.3z',
        spray: 'M9.5 3.5h4v3.5h-4z M8 7h7l2 3.2v10.3H6V10.2z M9.5 12.5h4 M19 6h2 M19 9.5h2',

        /* Terrain */
        leaf: 'M5 19.4c8.4 1 14.4-5 14.4-14.4-9.4 0-15.4 6-14.4 14.4z M5 19.4l8.4-8.4',
        tent: 'M12 4.4 20.4 19.6H3.6z M12 4.4v15.2 M8.4 19.6 12 13l3.6 6.6',
        map: 'M9 4 3.5 6v14.5L9 18.5l6 2 5.5-2V4l-5.5 2z M9 4v14.5 M15 6v14.5',
        compass: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M14.8 9.2 10.2 10.8 8.6 15.4l4.6-1.6z',
        mountain: 'M3 18.5l6-9.5 4 5.2 2-2.8 6 7.1z M9 9l1.8 2.8',
        moon: 'M20.5 14.3A8.5 8.5 0 0 1 9.7 3.5a8.5 8.5 0 1 0 10.8 10.8z',
        spark: 'M12 2.6l2.2 6.4 6.4 2.2-6.4 2.2-2.2 6.4-2.2-6.4L3.4 11.2l6.4-2.2z',

        /* Personnel et canin */
        paw: 'M7.6 9.4a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8z M12 7.8a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8z M16.4 9.4a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8z M12 20.4c-3 0-5.4-1.9-5.4-4.3S9 11.4 12 11.4s5.4 2.3 5.4 4.7-2.4 4.3-5.4 4.3z',
        bone: 'M7.5 16.5 16.5 7.5 M6.2 13.4a2.4 2.4 0 1 1 1.8-4 2.4 2.4 0 1 1 4-1.8 M17.8 10.6a2.4 2.4 0 1 1-1.8 4 2.4 2.4 0 1 1-4 1.8',
        person: 'M12 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M5 20.5c0-4 3.2-6.6 7-6.6s7 2.6 7 6.6',
        team: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M3 19.5c0-3.3 2.7-5.6 6-5.6s6 2.3 6 5.6 M16 6.6a3 3 0 0 1 0 5.8 M17.2 13.9c2.3.7 3.8 2.7 3.8 5.3',
        badge: 'M8 3.5h8v5l-4 2-4-2z M6 10.5h12v10H6z M9.5 14.5h5 M9.5 17.5h3',

        /* Administration et données */
        doc: 'M7 3h7l4 4v14H7z M14 3v4h4 M9.5 12.5h7 M9.5 16h5',
        archive: 'M3 5h18v4H3z M5 9h14v11.5H5z M9.5 13h5',
        folder: 'M3 6h6l2 2.2h10v12.3H3z M3 10.2h18',
        stamp: 'M8 3.5h8v5.2l2.2 3.3v2.5H5.8v-2.5L8 8.7z M5 18h14v2.5H5z',
        key: 'M9.5 16a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4z M13.4 11.8h7.6 M18.5 11.8v3 M15.8 11.8v2.4',
        lock: 'M5.5 11h13v9.5h-13z M8.5 11V8a3.5 3.5 0 0 1 7 0v3 M12 14.5v2.5',
        database: 'M12 8c4.4 0 8-1.1 8-2.5S16.4 3 12 3 4 4.1 4 5.5 7.6 8 12 8z M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13 M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5',
        terminal: 'M3 5h18v11.5H3z M8 20.5h8 M12 16.5v4 M6.5 9l2 2.2-2 2.2 M11.5 13.4h4',

        /* Anomalie */
        glitch: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M8 12h8 M12 8v8',
        rift: 'M12 3c-2 4 2 6 0 9s2 5 0 9 M8 6c-1 3 1.5 4 0 6.6 M16 6c1 3-1.5 4 0 6.6',
        portal: 'M12 21c3.9 0 7-4 7-9s-3.1-9-7-9-7 4-7 9 3.1 9 7 9z M12 16.2c1.7 0 3-1.9 3-4.2s-1.3-4.2-3-4.2-3 1.9-3 4.2 1.3 4.2 3 4.2z',
        skull: 'M12 3a7 7 0 0 1 7 7v3l-2 2v2.5H7V15l-2-2v-3a7 7 0 0 1 7-7z M9.6 11.2a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6z M14.4 11.2a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6z M10.5 20.5v-3 M13.5 20.5v-3',
        hex: 'M12 3.2l7.6 4.4v8.8L12 20.8 4.4 16.4V7.6z M12 13.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4z'
    };

    /* Presets proposés dans la console, rangés par type. */
    var CATEGORIES = [
        { label: 'Armement', keys: ['rifle', 'pistol', 'shotgun', 'ammo', 'grenade', 'knife', 'rocket', 'explosive', 'turret', 'target'] },
        { label: 'Optique & détection', keys: ['eye', 'search', 'scope', 'radar', 'antenna', 'goggles', 'camera', 'thermo', 'microscope', 'wave'] },
        { label: 'Aéronefs & drones', keys: ['drone', 'helicopter', 'plane', 'parachute', 'satellite'] },
        { label: 'Véhicules terrestres', keys: ['tank', 'truck', 'wheel', 'fuel'] },
        { label: 'Protection', keys: ['shield', 'helmet', 'vest', 'suit', 'mask', 'extinguisher', 'wall'] },
        { label: 'Laboratoire', keys: ['flask', 'vial', 'atom', 'dna', 'syringe', 'medic', 'cup'] },
        { label: 'Énergie & électronique', keys: ['battery', 'bolt', 'chip', 'magnet', 'solar', 'tool'] },
        { label: 'Logistique', keys: ['box', 'crate', 'warehouse', 'clipboard', 'scale', 'link', 'brush', 'drop', 'spray'] },
        { label: 'Terrain', keys: ['leaf', 'tent', 'map', 'compass', 'mountain', 'moon', 'spark'] },
        { label: 'Personnel & canin', keys: ['person', 'team', 'badge', 'paw', 'bone'] },
        { label: 'Administration & données', keys: ['doc', 'archive', 'folder', 'stamp', 'key', 'lock', 'database', 'terminal'] },
        { label: 'Anomalie', keys: ['glitch', 'rift', 'portal', 'skull', 'hex'] }
    ];

    /* Libellés lisibles, pour les infobulles du sélecteur. */
    var LABELS = {
        rifle: 'Fusil', pistol: 'Arme de poing', shotgun: 'Fusil à pompe', ammo: 'Munitions',
        grenade: 'Grenade', knife: 'Lame', rocket: 'Roquette', explosive: 'Charge explosive',
        turret: 'Affût / canon', target: 'Visée',
        eye: 'Observation', search: 'Recherche', scope: 'Optique de visée', radar: 'Radar',
        antenna: 'Antenne / signal', goggles: 'Lunettes', camera: 'Caméra', thermo: 'Thermique',
        microscope: 'Microscope', wave: 'Acoustique',
        drone: 'Drone', helicopter: 'Hélicoptère', plane: 'Avion', parachute: 'Parachute',
        satellite: 'Satellite',
        tank: 'Blindé', truck: 'Camion / convoi', wheel: 'Roue / chenille', fuel: 'Carburant',
        shield: 'Bouclier', helmet: 'Casque', vest: 'Gilet', suit: 'Combinaison', mask: 'Masque',
        extinguisher: 'Extincteur', wall: 'Blindage / mur',
        flask: 'Ballon', vial: 'Éprouvette', atom: 'Thaumique / EVE', dna: 'Biologie',
        syringe: 'Seringue', medic: 'Médical', cup: 'Café / boisson',
        battery: 'Batterie', bolt: 'Énergie', chip: 'Électronique', magnet: 'Magnétisme',
        solar: 'Panneau', tool: 'Mécanique',
        box: 'Colis', crate: 'Caisse', warehouse: 'Dépôt', clipboard: 'Procédure', scale: 'Pesée',
        link: 'Sangle / lien', brush: 'Nettoyage', drop: 'Fluide', spray: 'Aérosol',
        leaf: 'Végétal', tent: 'Camp', map: 'Carte', compass: 'Boussole', mountain: 'Relief',
        moon: 'Nuit', spark: 'Éclat',
        person: 'Agent', team: 'Équipe', badge: 'Accréditation', paw: 'Canin', bone: 'Ration canine',
        doc: 'Dossier', archive: 'Archives', folder: 'Répertoire', stamp: 'Tampon', key: 'Clé',
        lock: 'Verrou', database: 'Base de données', terminal: 'Terminal',
        glitch: 'Instable', rift: 'Faille', portal: 'Portail', skull: 'Menace', hex: 'Générique'
    };

    /* Données historiques : emoji → icône. Les familles comptent plus que le
       pictogramme exact. */
    var MAP = {
        '🧹': 'brush', '🪥': 'brush', '🧽': 'brush',
        '📝': 'clipboard', '🗄️': 'archive', '🗄': 'archive', '📋': 'clipboard',
        '🔍': 'search',
        '👁️': 'eye', '👁': 'eye', '🕶️': 'goggles', '🕶': 'goggles', '🔭': 'scope', '🪖': 'helmet',
        '🔐': 'lock', '🔒': 'lock',
        '☕': 'cup', '🫖': 'cup', '🍼': 'cup',
        '⚗️': 'atom', '⚗': 'atom', '🧴': 'vial', '🧊': 'vial', '🔬': 'microscope', '🩹': 'medic',
        '🛠️': 'tool', '🛠': 'tool', '🔧': 'tool', '🔩': 'tool', '⚙️': 'tool', '⚙': 'tool',
        '🎛️': 'chip', '🎛': 'chip', '✋': 'tool',
        '🛢️': 'fuel', '🛢': 'fuel', '💧': 'drop', '❄️': 'drop', '❄': 'drop',
        '🌬️': 'wave', '🔇': 'wave',
        '🪢': 'link', '🧵': 'link', '⛓️': 'link', '⛓': 'link', '🦮': 'link', '🪝': 'link',
        '🎇': 'spark', '🎆': 'spark', '💥': 'explosive', '🔥': 'spark', '🚀': 'rocket',
        '🎯': 'target', '🔫': 'rifle', '🗡️': 'knife', '🗡': 'knife', '🥈': 'ammo',
        '🛡️': 'shield', '🛡': 'shield', '🧱': 'wall', '🥼': 'suit', '🧯': 'extinguisher',
        '🐕': 'paw', '🦴': 'bone',
        '🦟': 'drone', '🌀': 'drone', '🐝': 'drone', '🦅': 'helicopter', '🚁': 'helicopter',
        '🔋': 'battery', '🧲': 'magnet',
        '🌡️': 'thermo', '🌡': 'thermo',
        '📦': 'crate', '🗑️': 'box', '🗑': 'box', '💺': 'box',
        '🌲': 'leaf', '⛺': 'tent',
        '◉': 'glitch', '◌': 'glitch', '▓': 'glitch', '█': 'glitch', '▒': 'glitch', '░': 'glitch'
    };

    function keyFor(value) {
        var raw = String(value == null ? '' : value).trim();
        if (PATHS[raw]) return raw;
        if (MAP[raw]) return MAP[raw];
        if (raw && MAP[raw.charAt(0)]) return MAP[raw.charAt(0)];
        return 'hex';
    }

    /** Pose la planche de symboles une seule fois par page. */
    function ensure() {
        if (!document.body || document.getElementById(SPRITE_ID)) return;
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.id = SPRITE_ID;
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
        svg.innerHTML = Object.keys(PATHS).map(function (key) {
            return '<symbol id="ic-' + key + '" viewBox="0 0 24 24" fill="none" ' +
                'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
                'stroke-linejoin="round"><path d="' + PATHS[key] + '"></path></symbol>';
        }).join('');
        document.body.insertBefore(svg, document.body.firstChild);
    }

    var Icons = {
        keyFor: keyFor,
        ensure: ensure,
        categories: CATEGORIES,
        label: function (key) { return LABELS[keyFor(key)] || keyFor(key); },

        /** Icône pour un contexte HTML (cartes, fiche, tableaux, console). */
        html: function (value, className) {
            ensure();
            return '<svg class="ico ico-item ' + (className || '') + '" aria-hidden="true">' +
                '<use href="#ic-' + keyFor(value) + '"></use></svg>';
        },

        /** Icône pour un contexte SVG (points de l'arbre), centrée sur 0,0. */
        svg: function (value, size, className) {
            ensure();
            var s = size || 22;
            return '<use class="g-ico ' + (className || '') + '" href="#ic-' + keyFor(value) + '" ' +
                'x="' + (-s / 2) + '" y="' + (-s / 2) + '" width="' + s + '" height="' + s + '"></use>';
        },

        /** Sélecteur de preset : grille d'icônes rangées par type.
         *  Renvoie du HTML ; le câblage est fait par Icons.wirePicker. */
        pickerHTML: function (current) {
            ensure();
            var active = keyFor(current);
            return '<div class="icon-picker" data-icon-picker>' +
                CATEGORIES.map(function (cat) {
                    return '<div class="icon-cat">' +
                        '<span class="icon-cat-label">' + cat.label + '</span>' +
                        '<div class="icon-grid">' +
                            cat.keys.map(function (key) {
                                return '<button type="button" class="icon-opt' + (key === active ? ' active' : '') +
                                    '" data-icon-key="' + key + '" title="' + (LABELS[key] || key) +
                                    '" aria-label="' + (LABELS[key] || key) + '"' +
                                    (key === active ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>' +
                                    '<svg class="ico" aria-hidden="true"><use href="#ic-' + key + '"></use></svg>' +
                                    '</button>';
                            }).join('') +
                        '</div></div>';
                }).join('') + '</div>';
        },

        /** Relie le sélecteur à un champ : un clic écrit la clé dans `input`. */
        wirePicker: function (root, input) {
            var picker = root.querySelector('[data-icon-picker]');
            if (!picker || !input) return;
            picker.addEventListener('click', function (e) {
                var btn = e.target.closest('[data-icon-key]');
                if (!btn) return;
                picker.querySelectorAll('.icon-opt').forEach(function (b) {
                    b.classList.remove('active');
                    b.setAttribute('aria-pressed', 'false');
                });
                btn.classList.add('active');
                btn.setAttribute('aria-pressed', 'true');
                input.value = btn.getAttribute('data-icon-key');
                input.dispatchEvent(new Event('change', { bubbles: true }));
            });
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ensure);
    } else {
        ensure();
    }

    global.GOC = global.GOC || {};
    global.GOC.Icons = Icons;
})(window);

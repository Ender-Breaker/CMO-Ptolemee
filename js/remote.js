/* ==========================================================================
   GOC — Division PTOLÉMÉE · Liaison Firebase (navigateur)
   Actif seulement si js/firebase-config.js est renseigné.
    - Connexion Google (Firebase Authentication).
    - État officiel reçu des Cloud Functions (fonction `sync`), filtré selon le rôle.
    - Chaque action de la liste blanche (js/ops.js) est affichée tout de suite,
      puis envoyée au serveur (fonction `op`) qui la rejoue en transaction et
      renvoie l'état officiel. Les envois partent un par un, dans l'ordre, avec
      un identifiant de requête : un envoi répété après une coupure réseau n'est
      jamais appliqué deux fois.
   ========================================================================== */

(function (global) {
    'use strict';

    var GOC = global.GOC;
    if (!GOC || !GOC.remote) return;

    var CFG = global.GOC_FIREBASE;
    var UI = GOC.UI, Store = GOC.Store, Consent = GOC.Consent, Auth = GOC.Auth;
    var SDK = 'https://www.gstatic.com/firebasejs/' + (CFG.sdk || '10.14.1') + '/';
    var POLL_MS = 45000;

    var auth = null;
    var calls = {};
    var listeners = [];
    var queue = [];
    var busy = false;
    var dirty = false;
    var pendingData = null;
    var inflight = null, rerun = null;
    var signingIn = false;
    var lastIdentity = null;
    var syncTimer = null;

    var Remote = {
        /** Compte Google connecté (objet Firebase) ou null. */
        user: null,
        /** Dossier côté serveur de ce compte Google, quel que soit son statut, ou null. */
        account: null,
        /** Vrai une fois qu'un état a été reçu du serveur. */
        online: false,

        /** `fn(data)` après chaque état officiel appliqué. */
        onSync: function (fn) { listeners.push(fn); },
        /** Nombre d'actions pas encore confirmées par le serveur. */
        pending: function () { return queue.length; },

        sync: sync,
        requestSync: requestSync,
        signIn: signIn,
        signOut: signOut,
        register: register,
        errorText: errorText
    };
    GOC.Remote = Remote;

    /* ------------------------------------------------------------------
       Démarrage
       ------------------------------------------------------------------ */

    var bootTimeout = setTimeout(function () {
        giveUp('Le serveur PTOLÉMÉE met trop de temps à répondre.');
    }, 20000);

    loadScripts(['firebase-app-compat.js', 'firebase-auth-compat.js', 'firebase-functions-compat.js'], function (error) {
        if (error || !global.firebase) return giveUp('Impossible de charger Firebase (connexion internet ?).');
        try {
            global.firebase.initializeApp({
                apiKey: CFG.apiKey, authDomain: CFG.authDomain, projectId: CFG.projectId, appId: CFG.appId
            });
            auth = global.firebase.auth();
            var functions = global.firebase.app().functions(CFG.region || 'europe-west1');
            calls.sync = functions.httpsCallable('sync', { timeout: 30000 });
            calls.op = functions.httpsCallable('op', { timeout: 60000 });
            calls.register = functions.httpsCallable('register', { timeout: 30000 });
        } catch (e) {
            return giveUp('Configuration Firebase invalide.');
        }

        if (GOC.Ops) GOC.Ops.install(send);

        var first = true;
        auth.onAuthStateChanged(function (user) {
            Remote.user = user;
            if (first) {
                first = false;
                sync().then(started, function (err) { giveUp(errorText(err)); });
            } else if (!signingIn) {
                sync().then(null, noop);
            }
        });
        auth.getRedirectResult().then(null, function (err) {
            GOC.ready(function () { UI.toast(errorText(err), 'error'); });
        });
    });

    function started() {
        clearTimeout(bootTimeout);
        GOC.markReady();
        setInterval(function () { if (!document.hidden) requestSync(); }, POLL_MS);
        document.addEventListener('visibilitychange', function () { if (!document.hidden) requestSync(); });
        global.addEventListener('beforeunload', function (e) {
            if (!queue.length) return;
            e.preventDefault();
            e.returnValue = '';
        });
    }

    function giveUp(message) {
        clearTimeout(bootTimeout);
        var wasReady = Remote.online;
        GOC.markReady();
        if (!wasReady) {
            UI.toast(message + ' Les données affichées sont vides.', 'error');
            document.documentElement.classList.add('is-offline');
        }
    }

    function loadScripts(files, done) {
        var i = 0;
        (function next() {
            if (i >= files.length) return done(null);
            var s = document.createElement('script');
            s.src = SDK + files[i++];
            s.onload = next;
            s.onerror = function () { done(new Error(s.src)); };
            document.head.appendChild(s);
        })();
    }

    /* ------------------------------------------------------------------
       État officiel
       ------------------------------------------------------------------ */

    /** Demande l'état au serveur. Deux demandes simultanées sont fusionnées. */
    function sync() {
        if (!calls.sync) return Promise.reject(new Error('Firebase indisponible.'));
        if (inflight) {
            if (!rerun) {
                var again = function () { rerun = null; return sync(); };
                rerun = inflight.then(again, again);
            }
            return rerun;
        }
        inflight = calls.sync({}).then(function (res) {
            inflight = null;
            receive(res.data);
            return res.data;
        }, function (err) {
            inflight = null;
            throw err;
        });
        return inflight;
    }

    /** Synchronisation différée, regroupe les demandes rapprochées. */
    function requestSync() {
        if (syncTimer || !calls.sync) return;
        syncTimer = setTimeout(function () {
            syncTimer = null;
            if (queue.length || busy) return; // l'état arrivera avec la réponse des actions
            sync().then(null, noop);
        }, 400);
    }

    function receive(data) {
        Remote.online = true;
        if ('account' in data) Remote.account = data.account || null;
        if (busy || queue.length) { pendingData = data; return; }
        apply(data);
    }

    function apply(data) {
        Store.hydrate(data.state, Remote.account && Remote.user && Remote.account.id === Remote.user.uid ? Remote.account.id : null);
        var me = Auth.current();
        var identity = me ? me.id + ':' + me.role : '';
        var header = document.querySelector('[data-header]');
        if (header && header.innerHTML && identity !== lastIdentity) UI.header();
        lastIdentity = identity;
        var pts = document.getElementById('hdr-points');
        if (pts && me) pts.textContent = UI.number(me.points) + ' PR';
        UI.announcements();
        listeners.forEach(function (fn) {
            try { fn(data); } catch (e) { console.error(e); }
        });
    }

    /* ------------------------------------------------------------------
       Actions : file d'attente ordonnée, identifiant de requête, relances
       ------------------------------------------------------------------ */

    function send(name, args, ids) {
        queue.push({ op: name, args: args, ids: ids, requestId: GOC.uid('req') });
        pump();
    }

    function pump() {
        if (busy || !queue.length) return;
        busy = true;
        attempt(queue[0], 0).then(function (data) {
            queue.shift();
            if (data.result && data.result.ok === false) {
                UI.toast('Refusé par le serveur : ' + data.result.error, 'error');
            }
            Remote.online = true;
            if ('account' in data) Remote.account = data.account || null;
            pendingData = data;
        }, function (err) {
            queue.shift();
            UI.toast('Action non enregistrée : ' + errorText(err), 'error');
            dirty = true; // l'affichage local ne correspond plus au serveur
        }).then(function () {
            busy = false;
            if (queue.length) return pump();
            if (dirty) {
                dirty = false;
                pendingData = null;
                sync().then(null, noop);
            } else if (pendingData) {
                var data = pendingData;
                pendingData = null;
                apply(data);
            }
        });
    }

    function attempt(item, tries) {
        return calls.op(item).then(function (res) {
            return res.data;
        }, function (err) {
            var code = err && err.code;
            if (tries < 2 && (code === 'functions/unavailable' || code === 'functions/deadline-exceeded')) {
                return wait(1500 * (tries + 1)).then(function () { return attempt(item, tries + 1); });
            }
            throw err;
        });
    }

    /* ------------------------------------------------------------------
       Compte Google
       ------------------------------------------------------------------ */

    /** Connexion Google. `remember` : session conservée entre les visites (cookie
     *  « connexion enregistrée » accepté), sinon fermée avec l'onglet. */
    function signIn(remember) {
        if (!auth) return Promise.reject(new Error('Firebase indisponible.'));
        var P = global.firebase.auth.Auth.Persistence;
        var provider = new global.firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        signingIn = true;
        return auth.setPersistence(remember && Consent.allows('persistance') ? P.LOCAL : P.SESSION).then(function () {
            return auth.signInWithPopup(provider);
        }).then(null, function (err) {
            var code = err && err.code;
            // Fenêtres surgissantes bloquées (mobiles, consoles, navigateurs intégrés) : redirection.
            if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
                return auth.signInWithRedirect(provider).then(function () { return new Promise(noop); });
            }
            throw err;
        }).then(function () {
            signingIn = false;
            return sync();
        }, function (err) {
            signingIn = false;
            throw err;
        });
    }

    function signOut() {
        if (!auth) return Promise.resolve();
        return auth.signOut().then(function () {
            Remote.account = null;
            Remote.user = null;
            Store.hydrate(null, null);
        });
    }

    /** Dépose une demande d'affectation pour le compte Google connecté. */
    function register(data) {
        if (!calls.register) return Promise.reject(new Error('Firebase indisponible.'));
        return calls.register(data).then(function (res) {
            Remote.account = res.data.account || null;
            return res.data;
        });
    }

    /* ------------------------------------------------------------------
       Utilitaires
       ------------------------------------------------------------------ */

    function errorText(err) {
        var code = (err && err.code) || '';
        var map = {
            'functions/unauthenticated': 'Session expirée : reconnectez-vous.',
            'functions/unavailable': 'Serveur injoignable, réessayez dans un instant.',
            'functions/deadline-exceeded': 'Le serveur n\'a pas répondu à temps.',
            'functions/resource-exhausted': 'Trop de demandes, patientez un peu.',
            'auth/popup-closed-by-user': 'Fenêtre de connexion fermée.',
            'auth/cancelled-popup-request': 'Connexion annulée.',
            'auth/network-request-failed': 'Réseau indisponible.',
            'auth/unauthorized-domain': 'Ce domaine n\'est pas autorisé dans Firebase Authentication.'
        };
        if (map[code]) return map[code];
        if (/^functions\/(invalid-argument|permission-denied|already-exists|failed-precondition|not-found)$/.test(code)) {
            return err.message;
        }
        return (err && err.message) || 'Erreur inconnue.';
    }

    function wait(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function noop() {}
})(window);

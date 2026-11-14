/* ==========================================================================
   GOC — Division PTOLÉMÉE · Pages inscription.html et connexion.html
   Mode local : identifiant + mot de passe. Mode Firebase : compte Google.
   ========================================================================== */

GOC.ready(function () {
    'use strict';

    var Auth = GOC.Auth, UI = GOC.UI, Consent = GOC.Consent;
    var Remote = GOC.remote ? GOC.Remote : null;

    UI.boot();

    function alertBox(host, message, kind) {
        document.getElementById(host).innerHTML =
            '<div class="alert alert-' + (kind || 'error') + '">' + message + '</div>';
    }

    function homeFor(user) {
        if (!user) return 'index.html';
        if (Auth.can('gradé')) return 'admin.html';
        if (user.role === 'membre') return 'recherches.html';
        return 'laboratoire.html';
    }

    /** Explication d'un dossier Google pas (ou plus) actif. */
    function accountText(account) {
        if (account.status === 'pending') {
            return 'Votre demande (<b>' + UI.escape(account.username) + '</b>) est encore en attente de validation par un haut gradé.';
        }
        if (account.status === 'rejected') {
            return 'Votre demande d\'accès a été refusée' +
                (account.rejectReason ? ' : <i>' + UI.escape(account.rejectReason) + '</i>' : '') +
                '. Contactez le commandement.';
        }
        if (account.status === 'suspended') return 'Ce compte est suspendu.';
        return 'Dossier inconnu.';
    }

    function receiptHTML(user, title) {
        return '<div class="alert alert-ok"><b>' + title + '</b></div>' +
            '<h2>Dossier ' + UI.escape(user.username) + ' — en attente</h2>' +
            '<p class="muted" style="margin-top:.8rem">Votre demande a été transmise au ' +
            'commandement. Un haut gradé doit la valider avant votre première connexion.</p>' +
            '<ul class="muted" style="margin:1rem 0 0 1.2rem; font-size:.9rem">' +
                '<li>Nom RP : <b>' + UI.escape(user.rpName) + '</b></li>' +
                '<li>Équipe : <b>' + UI.escape(UI.teamLabel(user.team)) + '</b></li>' +
                '<li>Discord : <b>' + UI.escape(user.discord) + '</b></li>' +
                '<li>Google : <b>' + UI.escape(user.google) + '</b></li>' +
                '<li>Statut : <b>en attente de validation</b></li>' +
            '</ul>' +
            '<p class="dim" style="margin-top:1.2rem">Signalez votre demande sur le Discord du ' +
            'projet pour accélérer le traitement.</p>' +
            '<p style="margin-top:1.4rem"><a class="btn" href="index.html">Retour à l\'accueil</a>' +
            '<a class="btn btn-ghost" href="decouvertes.html" style="margin-left:.5rem">Voir les découvertes</a></p>';
    }

    /* ------------------------------------------------------------------
       Inscription
       ------------------------------------------------------------------ */

    var signup = document.getElementById('signup-form');
    if (signup) {
        if (Auth.current()) {
            location.replace(homeFor(Auth.current()));
            return;
        }

        var linked = { discord: '', google: '' };

        var showAccount = function (account) {
            if (account.status === 'pending') {
                signup.innerHTML = receiptHTML(account, 'Demande déjà enregistrée pour ce compte Google.');
            } else {
                signup.innerHTML = '<div class="alert alert-warn">' + accountText(account) + '</div>' +
                    '<p style="margin-top:1rem"><a class="btn" href="index.html">Retour à l\'accueil</a></p>';
            }
        };

        var setLinked = function (kind, value) {
            linked[kind] = value;
            document.getElementById('su-' + kind).value = value;
            var box = document.getElementById('box-' + kind);
            box.classList.toggle('linked', !!value);
            box.querySelector('[data-value]').textContent = value || 'Aucun compte lié';
            box.querySelector('[data-link]').textContent = value ? 'Modifier' : 'Lier';
        };

        /** Mode Firebase : l'adresse Google vient de la connexion, pas d'une saisie. */
        var afterGoogle = function () {
            if (Auth.current()) { location.replace(homeFor(Auth.current())); return true; }
            if (Remote.account) { showAccount(Remote.account); return true; }
            if (Remote.user) setLinked('google', Remote.user.email || '');
            return false;
        };

        if (Remote && afterGoogle()) return;

        document.querySelectorAll('[data-link]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var kind = btn.getAttribute('data-link');
                if (Remote && kind === 'google') return googleLink(btn);
                openLinkModal(kind);
            });
        });

        var googleLink = function (btn) {
            btn.disabled = true;
            Remote.signIn(true).then(function () {
                btn.disabled = false;
                if (!afterGoogle()) UI.toast('Compte Google lié.', 'ok');
            }, function (err) {
                btn.disabled = false;
                UI.toast(Remote.errorText(err), 'error');
            });
        };

        /** Liaison déclarative : Discord toujours, Google seulement en mode local. */
        var openLinkModal = function (kind) {
            var isDiscord = kind === 'discord';
            var body =
                '<p class="muted" style="margin-bottom:1rem">' +
                (isDiscord
                    ? 'Indiquez le nom d\'utilisateur Discord avec lequel vous êtes présent sur le serveur du projet. Un haut gradé vérifiera la correspondance avant de valider votre compte.'
                    : 'Indiquez l\'adresse Google qui servira de moyen de récupération et de contrôle d\'unicité.') +
                '</p>' +
                '<div class="field"><label for="lk-val">' +
                (isDiscord ? 'Nom d\'utilisateur Discord' : 'Adresse Google') + '</label>' +
                '<input type="' + (isDiscord ? 'text' : 'email') + '" id="lk-val" maxlength="40" placeholder="' +
                (isDiscord ? 'elias.varn' : 'prenom.nom@gmail.com') + '" value="' + UI.escape(linked[kind]) + '"></div>' +
                '<div class="alert alert-warn">Liaison déclarative : aucune donnée n\'est transmise à ' +
                (isDiscord ? 'Discord' : 'Google') + '.</div>' +
                '<button class="btn btn-block" type="button" id="lk-ok">Lier le compte</button>';

            UI.modal(isDiscord ? 'Lier un compte Discord' : 'Lier un compte Google', body, function (root, close) {
                var input = root.querySelector('#lk-val');
                input.focus();
                root.querySelector('#lk-ok').addEventListener('click', function () {
                    var value = input.value.trim();
                    if (!value) { UI.toast('Champ vide.', 'error'); return; }
                    if (!isDiscord && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
                        UI.toast('Adresse e-mail invalide.', 'error');
                        return;
                    }
                    setLinked(kind, value);
                    close();
                    UI.toast('Compte ' + (isDiscord ? 'Discord' : 'Google') + ' lié.', 'ok');
                });
            });
        };

        signup.addEventListener('submit', function (e) {
            e.preventDefault();

            if (!linked.discord) return alertBox('signup-alert', 'Vous devez lier un compte Discord.');
            if (!linked.google) {
                return alertBox('signup-alert', Remote ? 'Connectez d\'abord votre compte Google.' : 'Vous devez lier un compte Google.');
            }
            if (!document.getElementById('su-age').checked) {
                return alertBox('signup-alert', 'Vous devez confirmer avoir 13 ans ou plus.');
            }
            if (!document.getElementById('su-data').checked) {
                return alertBox('signup-alert', 'Vous devez autoriser la consultation de votre dossier par les hauts gradés.');
            }

            var teamInput = document.querySelector('input[name="team"]:checked');
            if (!teamInput) return alertBox('signup-alert', 'Choisissez votre équipe.');

            var data = {
                team: teamInput.value,
                username: document.getElementById('su-user').value,
                rpName: document.getElementById('su-rp').value,
                discord: linked.discord,
                motivation: document.getElementById('su-motiv').value,
                terms: document.getElementById('su-terms').checked
            };

            if (Remote) {
                var check = GOC.Accounts.validateRequest(data);
                if (!check.ok) return alertBox('signup-alert', UI.escape(check.error));
                var submit = signup.querySelector('[type="submit"]');
                submit.disabled = true;
                Remote.register(data).then(function (res) {
                    signup.innerHTML = receiptHTML(res.account, 'Demande enregistrée.');
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                }, function (err) {
                    submit.disabled = false;
                    alertBox('signup-alert', UI.escape(Remote.errorText(err)));
                });
                return;
            }

            data.password = document.getElementById('su-pwd').value;
            data.password2 = document.getElementById('su-pwd2').value;
            data.google = linked.google;
            var result = Auth.register(data);

            if (!result.ok) return alertBox('signup-alert', UI.escape(result.error));

            signup.innerHTML = receiptHTML(result.user, 'Demande enregistrée.');
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }

    /* ------------------------------------------------------------------
       Connexion
       ------------------------------------------------------------------ */

    var login = document.getElementById('login-form');
    if (login) {
        var params = new URLSearchParams(location.search);
        var suite = params.get('suite');
        var goOn = function (user) {
            location.href = suite && /^[a-z-]+\.html$/.test(suite) ? suite : homeFor(user);
        };

        if (Auth.current()) {
            location.replace(homeFor(Auth.current()));
            return;
        }

        if (params.get('requis')) {
            var need = GOC.ROLES[params.get('requis')];
            alertBox('login-alert',
                'Cette page requiert le niveau <b>' + UI.escape(need ? need.label : params.get('requis')) +
                '</b>. Connectez-vous pour continuer.', 'warn');
        }

        var remember = document.getElementById('li-remember');
        var bindConsentLink = function () {
            var link = document.querySelector('[data-open-consent]');
            if (link) {
                link.addEventListener('click', function (e) {
                    e.preventDefault();
                    UI.cookieBanner(true);
                });
            }
        };
        remember.addEventListener('change', function () {
            if (remember.checked && !Consent.allows('persistance')) {
                alertBox('login-alert',
                    'La connexion enregistrée nécessite le cookie correspondant. ' +
                    '<a href="#" data-open-consent>Modifier mes choix de cookies</a>.', 'warn');
                bindConsentLink();
            }
        });

        /** Mode Firebase : compte Google connecté mais dossier absent ou inactif. */
        var explain = function () {
            var account = Remote.account;
            if (!Remote.user) return;
            if (!account) {
                alertBox('login-alert', 'Aucun dossier n\'est associé à <b>' + UI.escape(Remote.user.email || 'ce compte Google') +
                    '</b>. <a href="inscription.html">Déposer une demande d\'affectation</a>.', 'warn');
                return;
            }
            alertBox('login-alert', accountText(account), account.status === 'pending' ? 'warn' : 'error');
            if (account.status !== 'pending') Remote.signOut();
        };

        if (Remote) {
            explain();
            var google = document.getElementById('li-google');
            var googleLogin = function () {
                google.disabled = true;
                Remote.signIn(remember.checked).then(function () {
                    google.disabled = false;
                    var user = Auth.current();
                    if (user) return goOn(user);
                    explain();
                }, function (err) {
                    google.disabled = false;
                    alertBox('login-alert', UI.escape(Remote.errorText(err)));
                });
            };
            google.addEventListener('click', googleLogin);
            login.addEventListener('submit', function (e) { e.preventDefault(); googleLogin(); });
            return;
        }

        login.addEventListener('submit', function (e) {
            e.preventDefault();
            var result = Auth.login(
                document.getElementById('li-user').value,
                document.getElementById('li-pwd').value,
                remember.checked
            );

            if (!result.ok) return alertBox('login-alert', UI.escape(result.error));

            if (remember.checked && !result.remembered) {
                UI.toast('Session ouverte pour cette visite seulement (cookie de persistance refusé).');
            }
            goOn(result.user);
        });
    }
});

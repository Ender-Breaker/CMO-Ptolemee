# Division PTOLÉMÉE — portail GOC

Site RP de la Division PTOLÉMÉE, branche de soutien de la Global Occult Coalition :
arbre de recherche graphique, financement collectif en points de recherche (PR), deux équipes
(Quartier-maître / Recherche & Développement), gestion des affectations et console dev.

Charte graphique : `#424248` · `#A4C2EC` · `#5C95E6` · `#275495`.

## Deux modes

| | Mode local (démo) | Mode Firebase (production) |
|---|---|---|
| Activé quand | `apiKey` vide dans `js/firebase-config.js` | `apiKey` renseignée |
| Données | navigateur (localStorage) | Cloud Firestore |
| Connexion | identifiant + mot de passe | compte Google (Firebase Authentication) |
| Règles du jeu | exécutées dans le navigateur | rejouées par les Cloud Functions, seules à écrire |
| Multijoueur | non (une base par navigateur) | oui |

Le code des règles est **le même fichier** dans les deux cas (`js/core.js`, `js/research.js`,
`js/ops.js`) : les Cloud Functions le chargent tel quel, rien n'est dupliqué.

### Mode local

Ouvrir `index.html` dans un navigateur suffit. Pour que les **vrais cookies** fonctionnent
(connexion enregistrée), servez le dossier en HTTP (`npx serve .`). En `file://`, le site bascule
sur un miroir `localStorage` avec la même sémantique d'expiration.

### Mode Firebase : mise en service

Hébergement du site : **Cloudflare Pages**. Serveur (Cloud Functions), base (Firestore) et
connexion (Authentication) : **Firebase**.

Prérequis : projet Firebase en offre **Blaze**, Node 22, `npm i -g firebase-tools`, `firebase login`.

1. **Projet** : remplacer `remplacer-par-id-du-projet` dans `.firebaserc` par l'ID du projet.
2. **Connexion Google** : console Firebase → *Authentication* → *Sign-in method* → activer
   **Google**. Dans *Paramètres → Domaines autorisés*, **ajouter le domaine Cloudflare**
   (`<projet>.pages.dev`, plus le domaine personnalisé s'il y en a un).
3. **Application Web** : console → *Paramètres du projet* → *Vos applications* → ajouter une
   application Web (sans Firebase Hosting), puis recopier `apiKey`, `authDomain`, `projectId`,
   `appId` dans `js/firebase-config.js`. Ces valeurs sont publiques par nature.
4. **Base Firestore** : console Firebase → *Firestore Database* → *Créer une base de données* →
   édition Standard, ID `(default)`, emplacement **`europe-west1`** (définitif), mode
   **production**. Rien d'autre à créer : les documents sont écrits au premier appel. Les règles
   (`firestore.rules`) interdisent tout accès direct depuis le navigateur ; seules les Cloud
   Functions lisent et écrivent.
5. **Serveur** :
   ```powershell
   cd serveur; npm install; npm test; cd ..
   firebase deploy
   ```
   Déploie les fonctions et les règles Firestore. Au premier déploiement, la CLI demande
   `ADMIN_EMAILS` (adresse(s) Google du compte dev) et l'enregistre dans `serveur/.env.<projet>`.
   Le moteur (`js/core.js`, `research.js`, `ops.js`) est recopié dans `serveur/engine/` avant
   chaque déploiement.
6. **Site (Cloudflare Pages)** : le dossier publié est `dist/`, produit par `node scripts/pages.js`
   (pages, style, `js/`, `assets/` et en-têtes de sécurité `_headers` ; ni le README, ni la
   configuration Firebase, ni le serveur).
   - *Avec Git* : Workers & Pages → Créer → Pages → connecter le dépôt ; commande de build
     `node scripts/pages.js`, répertoire de sortie `dist` (et répertoire racine `CMO` si le
     dépôt contient le dossier parent).
   - *Sans Git* : lancer `node scripts/pages.js`, puis Pages → *Téléverser des fichiers* → déposer
     le dossier `dist`.

   Le serveur s'appelait `functions/` : il a été renommé `serveur/`, car Cloudflare Pages
   interpréterait un dossier `functions/` comme ses propres fonctions.

Le premier appel crée l'arbre officiel.

### Fonctionnement

| Fonction | Rôle |
|----------|------|
| `sync` | État officiel, **filtré selon le rôle** : les visiteurs ne reçoivent aucun dossier ni journal et seulement le texte des découvertes publiées ; les chercheurs ne voient des autres que nom, rôle, équipe, et reçoivent les entrées corrompues déjà brouillées ; coordonnées et journal réservés aux hauts gradés ; le compte dev n'existe que pour lui-même. |
| `op` | Une action de la **liste blanche** de `js/ops.js` (versement, lancement, validation, édition de l'arbre…) avec le rôle minimal requis. |
| `register` | Demande d'affectation du compte Google connecté (un compte Google = un dossier). |
| `tick` | Toutes les 5 minutes : clôture des travaux arrivés à terme, purge des requêtes de plus de 7 jours. |

- **Stockage** : `division/etat` (arbre, réglages et comptes, JSON compressé : une seule lecture
  par synchronisation), `division/journal` (1 000 dernières actions), `requetes/*` (envois déjà
  traités, purgés après 7 jours). L'usage reste dans le quota gratuit de Firestore pour un
  serveur RP de taille normale.
- **Pas de double dépense** : chaque action s'exécute dans une transaction Firestore qui lit puis
  réécrit l'état ; deux versements simultanés sont appliqués l'un après l'autre et le second voit
  le solde réel. Tout solde négatif est en plus refusé à l'enregistrement.
- **Pas de double application** : chaque envoi porte un identifiant de requête ; un envoi répété
  (coupure réseau, double clic) renvoie le résultat déjà enregistré.
- **Affichage immédiat** : le navigateur applique l'action localement, l'envoie, puis remplace sa
  copie par l'état officiel renvoyé. Si le serveur refuse, un message s'affiche et la copie est
  corrigée. Les autres joueurs apparaissent à la synchronisation suivante (45 s, ou au retour sur
  l'onglet).
- **Discord** : pseudo **déclaratif** saisi à l'inscription, vérifié à la main par le haut gradé
  qui valide la demande. Aucune connexion à Discord.

### Tests

```powershell
cd serveur
npm test    # moteur serveur, relais navigateur, vraies fonctions sur un Firestore simulé en mémoire
```

## Compte développeur

| Mode | Accès |
|------|-------|
| local | identifiant `Admin`, mot de passe `GOConTOP` |
| Firebase | se connecter avec une adresse Google listée dans `ADMIN_EMAILS` (pas de mot de passe) |

Retirer une adresse de `ADMIN_EMAILS` ne rétrograde pas un compte déjà créé : le supprimer depuis
la console (*Personnel*) si nécessaire.

Ce compte est **invisible** pour tous les autres comptes :

- absent des listes Personnel / Points / Demandes et des compteurs ;
- ses actions sont masquées du journal des hauts gradés ;
- jamais inclus dans une attribution collective de PR ;
- son nom n'apparaît pas comme « pilote » d'une recherche qu'il lance ;
- le rôle « Développeur » n'est attribuable à personne.

Il sert à éditer l'arbre, créer les événements positifs/négatifs et publier les annonces.
En mode local, il est recréé à chaque réinitialisation de la base. En mode Firebase, la
réinitialisation (*Maintenance*) ne régénère que l'arbre, les directives et les annonces : les
comptes et le journal sont conservés, et l'import JSON ne touche pas non plus aux comptes.

## Pages

| Fichier | Accès | Contenu |
|---------|-------|---------|
| `index.html` | public | Accueil, annonces, deux équipes |
| `ptolemee.html` | public | Présentation de la division |
| `decouvertes.html` | public | Arbre limité aux recherches **achevées** |
| `inscription.html` | public | Demande d'affectation (équipe + pseudo Discord + compte Google + nom RP) |
| `connexion.html` | public | Authentification (mot de passe en local, Google en mode Firebase) |
| `laboratoire.html` | chercheur | Arbre opérationnel |
| `recherches.html` | membre | Archives complètes |
| `admin.html` | haut gradé / dev | Console |
| `conditions.html` | public | CGU + cookies |

## Rôles

`invité` → `chercheur` → `membre GOC` → `haut gradé` → *(développeur, caché)*

Un compte créé reste **en attente** jusqu'à validation par un haut gradé, qui fixe le rôle et
peut corriger l'équipe.

## Console

| Onglet | Accès | Contenu |
|--------|-------|---------|
| Éditeur d'arbre | dev | Placement graphique des recherches et des liens |
| Demandes | haut gradé | Validation / refus, rôle, équipe |
| Personnel | haut gradé | Rôle, équipe, suspension (dev : suppression) |
| Points | haut gradé | PR à un compte, une équipe, un rôle ou à tous |
| Événements & annonces | dev | Modificateurs ± temporaires, messages publics |
| Catalogue | dev | Vue tableau de toutes les recherches |
| Paliers | dev | Colonnes de l'arbre |
| Journal | haut gradé | 400 dernières actions |
| Maintenance | dev | Export / import JSON, réinitialisation |

### Éditeur d'arbre

Chaque **palier est une zone redimensionnable** : dans l'éditeur, tirez son bord droit, haut ou
bas (double-clic sur un bord : ajuster au contenu), ou réglez sa largeur en pixels dans la fiche
du palier. Une zone ne peut jamais rogner ses propres recherches.

Dans chaque palier, la **racine** est posée sur une ligne en haut de l'arbre ; les recherches
sont ensuite rangées en **groupes lus de gauche à droite**. Dans un groupe, plusieurs branches
parallèles convergent vers une principale ; **seules certaines secondaires se suivent**
(ex. Lubrifiant → Écouvillon), les autres se font dans n'importe quel ordre. Une principale peut
ouvrir une nouvelle étape (VINDEX → accessoires SINKER → éventail des trois armes G2).

### Recherches répétables

Réglages dans la fiche d'une recherche (*Commandement → Catalogue* ou double-clic dans l'éditeur) :

- **Répétable** : après chaque achèvement, la recherche repart en financement. Nombre maximum de
  répétitions facultatif (0 = illimité). Le nombre d'achèvements est visible sur le point (↻ n).
- **Exiger plusieurs achèvements** : dans la liste des prérequis, ou en cliquant un lien dans
  l'éditeur, on indique combien de fois la source doit avoir été achevée. Le lien affiche alors
  un compteur (ex. `3/10`).
- **Progression par répétition** : +x % composé par répétition sur la durée, le coût et/ou la
  vitesse de financement (PR crédités par versement). Désactivable recherche par recherche, ou
  pour tout l'arbre (case dans *Catalogue*).
- **Boost à l'achèvement** : effet temporaire sur toute la division (ex. −5 % de coût pendant
  12 h). Non cumulable par défaut : un nouvel achèvement prolonge le boost en cours.

Exemple livré (palier 0) : **Réservoir Caféinique RCI-108** (répétable, −5 % de coût 12 h) →
**Cafetière Niv. 2** après 10 répétitions (−5 % de durée 12 h) → **Cafetière Niv. 3** après 5
répétitions du niveau 2 (+5 % de rendement 12 h). La progression principale n'exige le café
qu'une seule fois.

### Malus d'abandon

Dans la fiche d'une recherche, section *Malus d'abandon* :

- **Famille** (ex. `café`) : les recherches d'une même famille partagent leur dernier achèvement ;
  en achever une suffit à suspendre le malus.
- **Activer / désactiver** le malus pour la recherche, ou pour tout l'arbre (case dans *Catalogue*).
- **Réglages** : effet (coût ou durée en hausse, rendement en baisse), délai de grâce en jours,
  malus au départ, hausse par jour et maximum.
- Il se déclenche quand ni la recherche ni sa famille n'a été achevée depuis le délai de grâce,
  puis grandit chaque jour jusqu'au maximum. Aucun malus avant le premier achèvement, ni pour une
  famille qui ne peut plus être relancée. Une famille ne porte qu'un malus par effet (le plus fort).
- Visible dans le bandeau des effets (▼ Délaissement), dans la fiche et par un halo rouge sur le point.

Réglage livré : famille **café**, 14 jours de grâce, +1 % de coût puis +1 % par jour, 25 % maximum.

### Paliers corrompus

- Le développeur **corrompt ou purge** un palier depuis *Commandement → Paliers* ou depuis
  l'inspecteur de l'éditeur (bouton ☣ Corrompre / ✦ Purger). Par défaut, l'opération s'applique
  aussi aux recherches du palier.
- **Archives** (membres) : le palier corrompu est affiché, mais près de la moitié des caractères
  est brouillée (noms, codes, descriptions, rapports), et ils changent en permanence.
- **Laboratoire** (chercheurs) : le palier est affiché lui aussi, en encore moins lisible : trois
  caractères sur quatre brouillés, icônes et équipes masquées, texte flouté, chiffres illisibles.
  Aucune action possible (« Accès refusé : données instables ») et introuvable par la recherche.
- Sur les deux pages, toutes les 9 à 30 s, une **poussée d'instabilité** fait vaciller le palier et
  brouille ses libellés d'un coup (animation adoucie si l'appareil demande moins d'animations).
- Le registre public ne montre jamais un palier corrompu. En mode Firebase, les visiteurs n'en
  reçoivent pas le texte, et les chercheurs le reçoivent déjà en partie brouillé.

### Se déplacer dans l'arbre

| Appareil | Commandes |
|----------|-----------|
| Souris | glisser : se déplacer · molette : zoom · clic : fiche · double-clic : zoomer ici |
| Pavé tactile | deux doigts : se déplacer · pincer : zoom |
| Écran tactile | glisser : se déplacer · pincer : zoom · double-toucher : zoomer ici · bouton « Fiche » |
| Clavier | flèches : recherche voisine · Maj + flèches : se déplacer · + / − · 0 : tout voir · Entrée · Échap |
| Manette | stick gauche : se déplacer · stick droit / gâchettes : zoom · croix : voisine · A / B · LB / RB : palier · Y : tout voir |

S'y ajoutent : boutons de palier (en haut à gauche), mini-carte cliquable, plein écran, aide
« ? », mise en évidence du chemin menant à la recherche sélectionnée, et masquage progressif des
libellés quand on dézoome. Sur petit écran, la première vue cadre le palier en cours. Chaque recherche est un
**point** : hexagone pour une principale, cercle pour une secondaire.

Un palier peut contenir **plusieurs principales**, et toute recherche — principale ou
secondaire — peut **débloquer une ou plusieurs autres** recherches, de n'importe quel type.

| Geste | Effet |
|-------|-------|
| Double-clic dans le vide | Créer une recherche à cet endroit |
| Glisser un point | Le déplacer ; changer de colonne change son palier |
| Tirer depuis le port ● d'un point vers un autre | Ajouter un prérequis |
| Cliquer un lien puis `Suppr` | Retirer le prérequis |
| Double-clic sur un point | Fiche complète |
| Molette / pincer, glisser le fond | Zoom, déplacement |

Les boucles de prérequis sont refusées.

## Mécanique de recherche

```
locked ──(prérequis achevés)──▶ funding ──(PR atteints)──▶ ready
                                                             │ lancement
                                   done ◀──(fin du chrono)── running
```

- Les recherches sont **chères et longues** : de 500 PR / 4 h pour les plus simples à
  40 000 PR / 3 jours au palier III. Le plancher (500 PR, 4 h) est imposé par le moteur :
  `MIN_COST` / `MIN_DURATION` dans `js/research.js`. L'arbre d'origine est défini dans
  `seedTree()` (`js/core.js`).
- Une base existante est **migrée** au chargement : comptes, événements, annonces, paliers et
  recherches créés à la main sont conservés ; seul l'arbre d'exemple est remplacé.
- **Financement collectif** : chaque versement va dans une cagnotte commune.
- **Événements** cumulatifs à fenêtre de temps : `temps`, `cout` (négatif = positif pour les
  joueurs), `rendement` (positif = positif). La polarité est calculée et affichée
  automatiquement.

## Cookies

| Nom | Catégorie | Durée | Consentement |
|-----|-----------|-------|--------------|
| `goc_consent` | essentiel | 6 mois | non requis |
| `goc_session` | essentiel | session (24 h) | non requis |
| `goc_session` (30 j) | connexion enregistrée | 30 jours | **requis** |
| `pref::*` | préférences (filtres, vue arbre/liste, onglet) | jusqu'à effacement | **requis** |

En mode Firebase, `goc_session` n'est pas utilisé : la session Google est conservée par Firebase
Authentication dans le stockage du navigateur, pour la visite seulement si la connexion
enregistrée est refusée ou « Rester connecté » décoché.

## Structure

```
CMO/
├── index.html ptolemee.html decouvertes.html laboratoire.html recherches.html
├── inscription.html connexion.html admin.html conditions.html
├── style.css
├── firebase.json .firebaserc       fonctions + Firestore (le site est sur Cloudflare Pages)
├── firestore.rules                 aucun accès direct du navigateur à la base
├── js/
│   ├── firebase-config.js  clés publiques Firebase (vide = mode local)
│   ├── core.js        stockage, cookies, auth, rôles, équipes, annonces, UI      ┐ partagés
│   ├── research.js    moteur : paliers, recherches, liens, positions, PR, événements │ navigateur
│   ├── ops.js         comptes, maintenance, liste blanche, filtrage par rôle       ┘ + serveur
│   ├── remote.js      liaison Firebase : Google, synchronisation, envoi des actions
│   ├── graph.js       arbre SVG : rendu, zoom, déplacement, édition
│   ├── page-auth.js   inscription + connexion
│   ├── page-tree.js   arbre + fiche + vue liste (modes public / chercheur / complet)
│   └── page-admin.js  console
├── scripts/pages.js    construit dist/ pour Cloudflare Pages
└── serveur/
    ├── index.js       Cloud Functions : sync, op, register, tick
    ├── engine.js      charge le moteur partagé dans un bac à sable
    ├── store.js       Firestore : transactions, lecture / écriture, purge
    └── test/          tests moteur, navigateur, Firestore simulé
```

## Limites connues

- **Mode local** : tout est stocké dans le navigateur, rien n'est partagé entre deux machines, et
  le compte dev n'est invisible que dans l'interface (son mot de passe figure dans ce README).
- **Mode Firebase** : les fonctions `sync` sont appelables sans connexion (pages publiques).
  Pour limiter les abus, activer **App Check** (console Firebase) puis ajouter
  `enforceAppCheck: true` aux options des fonctions dans `serveur/index.js`.
- Les autres joueurs n'apparaissent qu'à la synchronisation suivante (45 s au plus).
- Changer `DB_VERSION` dans `js/core.js` régénère la base locale au prochain chargement ; côté
  serveur, l'état est migré automatiquement par le moteur.

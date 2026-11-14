-- ==========================================================================
-- GOC — Division PTOLÉMÉE · Schéma PostgreSQL (Cloud SQL)
-- Appliqué automatiquement au démarrage des Cloud Functions (idempotent).
-- Peut aussi être exécuté à la main dans Cloud SQL Studio.
-- ==========================================================================

-- Un seul démarrage à la fois applique le schéma.
SELECT pg_advisory_xact_lock(7310108);

-- Dossiers du personnel. `id` = identifiant Firebase Authentication (compte Google).
CREATE TABLE IF NOT EXISTS comptes (
    id          TEXT PRIMARY KEY,
    username    TEXT NOT NULL,
    rp_name     TEXT NOT NULL,
    discord     TEXT NOT NULL DEFAULT '',          -- pseudo déclaratif, vérifié par un haut gradé
    email       TEXT NOT NULL,                     -- adresse Google (fournie par Firebase, vérifiée)
    team        TEXT,
    role        TEXT NOT NULL DEFAULT 'chercheur',
    status      TEXT NOT NULL DEFAULT 'pending',
    hidden      BOOLEAN NOT NULL DEFAULT FALSE,    -- compte dev : invisible de tous les autres
    points      BIGINT NOT NULL DEFAULT 0,
    note        TEXT NOT NULL DEFAULT '',          -- motivation déposée avec la demande
    created_at  BIGINT NOT NULL,                   -- horodatages en millisecondes (comme le moteur)
    approved_at BIGINT,
    approved_by TEXT,
    extra       JSONB NOT NULL DEFAULT '{}'::jsonb, -- champs secondaires (motif de refus…)
    CONSTRAINT comptes_points CHECK (points >= 0),  -- filet de sécurité : jamais de solde négatif
    CONSTRAINT comptes_role CHECK (role IN ('chercheur', 'membre', 'gradé', 'admin')),
    CONSTRAINT comptes_status CHECK (status IN ('pending', 'approved', 'rejected', 'suspended')),
    CONSTRAINT comptes_team CHECK (team IS NULL OR team IN ('qm', 'rd'))
);
CREATE UNIQUE INDEX IF NOT EXISTS comptes_username_unique ON comptes (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS comptes_email_unique ON comptes (lower(email));

-- État du jeu : paliers, recherches, directives, annonces, réglages.
-- Une seule ligne, verrouillée (SELECT … FOR UPDATE) pendant chaque action :
-- les actions sont appliquées l'une après l'autre, jamais en parallèle.
CREATE TABLE IF NOT EXISTS etat (
    id         SMALLINT PRIMARY KEY CHECK (id = 1),
    revision   BIGINT NOT NULL DEFAULT 0,
    data       JSONB NOT NULL,
    updated_at BIGINT NOT NULL
);

-- Journal de la division.
CREATE TABLE IF NOT EXISTS journal (
    id     TEXT PRIMARY KEY,
    at     BIGINT NOT NULL,
    actor  TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    hidden BOOLEAN NOT NULL DEFAULT FALSE           -- action du compte dev
);
CREATE INDEX IF NOT EXISTS journal_at ON journal (at DESC);

-- Requêtes déjà traitées : un envoi répété (coupure réseau, double clic) renvoie
-- le résultat enregistré au lieu de rejouer l'action. Purgé après 7 jours.
CREATE TABLE IF NOT EXISTS requetes (
    id       TEXT PRIMARY KEY,                     -- uid + ':' + identifiant de requête
    compte   TEXT NOT NULL,
    op       TEXT NOT NULL,
    resultat JSONB,
    at       BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS requetes_at ON requetes (at);

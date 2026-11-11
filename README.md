# Wanted

Application web mobile pour **Wanted**, une chasse à l'homme urbaine en deux manches : chaque joueur est à la fois chasseur et cible.

> Dépôt distinct de [`evasion-urbaine-poitiers`](https://github.com/willbac-chronicles/evasion-urbaine-poitiers), qui reste en l'état comme modèle d'un autre jeu.

## Documents

- [Cahier des charges](docs/cahier-des-charges.md) : écrans, logique de jeu, données, sécurité, calendrier.

## Stack

- Front statique (HTML/JS), hébergé sur GitHub Pages.
- Carte : Leaflet 1.9.4 + fond OpenStreetMap/CARTO.
- Backend : Supabase (Postgres, connexion anonyme, fonctions SQL `security definer`, Storage, `pg_cron`).

## Structure

- `index.html` + `assets/player.js` : écran joueur (connexion, attente, dispersion, fiche cible, capture, code, scores, classement).
- `org.html` + `assets/org.js` : écran organisateur (pilotage de la partie, joueurs, photos, corrections, messages, journal, export).
- `assets/common.js` : client Supabase, session anonyme, horloge calée sur le serveur.
- `config.js` : URL du projet et clé publique (jamais de clé secrète ici).
- `supabase/schema.sql` : tables, sécurité, fonctions et bucket photos. Ré-exécutable.
- `assets/push.js`, `sw.js`, `manifest.webmanifest` : notifications web et installation sur l'écran d'accueil.
- `supabase/functions/push-dispatch` : fonction Edge qui envoie les notifications (clés VAPID créées et gardées en base).

## Installation de la base

1. Supabase → Authentication → Sign In / Providers : activer **Allow anonymous sign-ins**.
2. Supabase → SQL Editor : exécuter `supabase/schema.sql`. Le dernier résultat affiche le **code organisateur** : le garder pour soi.
3. Supabase → Edge Functions → nouvelle fonction `push-dispatch` avec le contenu de `supabase/functions/push-dispatch/index.ts`, **vérification JWT désactivée** (la base l'appelle avec son propre jeton).
4. Ouvrir `org.html`, saisir le code organisateur, créer les joueurs et leurs photos.

## Fonctionnement

- Chaque appel fait avancer la partie selon l'heure du serveur (tirage au START, fin de manche à +60 min) ; une tâche `pg_cron` fait de même toutes les 10 s et réveille l'envoi des notifications.
- Le front interroge `get_my_state` toutes les 3 s pendant une manche, 10 s sinon (organisateur : 5 s).
- Notifications : file `push_jobs` remplie par les fonctions SQL, envoyée par `push-dispatch` (appel `pg_net` immédiat + rattrapage toutes les 10 s).

## État

v0 (accès, photos, tirage, capture, scores). Pings et carte : jalon du 5 déc. 2026.

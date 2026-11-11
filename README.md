# Wanted

Application web mobile pour **Wanted**, une chasse à l'homme urbaine en deux manches : chaque joueur est à la fois chasseur et cible.

> Dépôt distinct de [`evasion-urbaine-poitiers`](https://github.com/willbac-chronicles/evasion-urbaine-poitiers), qui reste en l'état comme modèle d'un autre jeu.

## Documents

- [Cahier des charges](docs/cahier-des-charges.md) : écrans, logique de jeu, données, sécurité, calendrier.

## Stack

- Front statique (HTML/JS), hébergé sur GitHub Pages.
- Carte : Leaflet 1.9.4 + fond OpenStreetMap/CARTO.
- Backend : Supabase (Postgres, connexion anonyme, fonctions SQL `security definer`, Storage, `pg_cron`).

## État

En cours de construction. v0 visée le 28 nov. 2026.

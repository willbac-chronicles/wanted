# Wanted — Cahier des charges de l'appli web (v1.1)

*Rédigé le 11 nov. 2026, mis à jour le même jour avec les décisions prises.*
Légende : **[C]** confirmé · **[P]** proposé · **[Ouvert]** à décider

---

## 1. Cadre

- Dépôt `willbac-chronicles/wanted`, distinct de `evasion-urbaine-poitiers`, qui reste en l'état. [C]
- Stack : GitHub Pages (front statique HTML/JS) + Supabase. [C]
- Carte : Leaflet 1.9.4 + fond OpenStreetMap/CARTO, comme l'ancien dépôt. Périmètre importé d'un KMZ Google Earth via `kmz_to_geojson.py` (repris de l'ancien dépôt). [C]
- Briques à reprendre de l'ancien dépôt : accès par code et pseudo, connexion anonyme, carte avec périmètre, minuteur du prochain ping, Start et réinitialisation, protection contre les doubles envois. [P]
- Interface pensée d'abord pour le téléphone. Direction artistique : **western de Noël sur papier d'avis de recherche**, fond clair uniquement. [C]
  - Couleurs : rouge cerise #8E1F2C (action, capture, alerte), bleu nuit #1E3A5F (pings, carte, infos), vert sapin #1F4D3A (immunité, validation), or #C9A227 (points, toujours avec texte brun), parchemin #E8DDC7 (avis de recherche, bordure double brune), blanc neige #F7F5F0 (fond), brun #2D241E (texte), #5C5248 (texte secondaire).
  - Polices : Rye (« WANTED », titres d'affiche), Cinzel (petites capitales de section), Nunito (tout le reste).
  - Accessibilité : zones tactiles ≥ 44 px, contraste ≥ 4,5:1, jamais la couleur seule (icône ou mot en plus), icônes SVG au trait.
  - Décor : petits lutins originaux dans les zones vides, sans animation continue.
- Deux rôles : **joueur** et **organisateur**. [C]

## 2. Limites techniques

| Limite | Choix |
|---|---|
| Le navigateur ne peut pas envoyer la position si le téléphone est verrouillé ou la page fermée | Le joueur appuie sur **« Envoyer ma position »** dans une fenêtre de **1 min** après l'heure du ping (+10 s de marge réseau côté serveur). Le GPS est « réchauffé » 45 s avant chaque ping. [C] |
| Notifications web peu fiables sur iPhone | Bandeau, son et vibration quand la page est ouverte, plus un groupe de messagerie de secours. Pas de notifications web en v1. [P] |
| La clé publique Supabase est visible dans le code | Aucun accès direct aux tables : tout passe par des fonctions SQL (§ 6). [C] |
| Horloges des téléphones décalées | Toutes les heures viennent du serveur ; `get_my_state` renvoie `server_now` et le front calcule les minuteurs à partir de là. [C] |
| Le site est statique : rien ne déclenche les événements à heure fixe | Tout est **déduit de l'heure de START** (fenêtres de ping, fin de manche). Le tirage se fait au premier appel après la fin de la dispersion, sous verrou. `pg_cron` en complément si besoin. [C] |

## 3. Écrans joueur

1. **Connexion** : saisie du code d'accès personnel, puis affichage du pseudo. [C]
2. **Attente** : état de la partie (accueil, briefing), rappel des règles clés.
3. **Dispersion** : compte à rebours de 10 min. Aucune cible ni aucun code visible. [C]
4. **Jeu** (écran principal) :
   - Fiche cible : photo et pseudo. [C]
   - Bouton **« Wanted ! »**, qui ouvre la saisie du code de la cible. [C]
   - Bouton **« Afficher mon code »** : code à 4 chiffres en grand, masqué par défaut. [P]
   - Carte : périmètre, dernière position connue de la cible avec son heure, toutes les positions pendant le ping général. [C]
   - Minuteur du prochain ping, puis bouton **« Envoyer ma position »** pendant la fenêtre. [C]
   - Score de la manche, score total, indicateur d'immunité (2 min). [C]
   - Fil des messages de l'organisateur.
   - [Ouvert] Afficher au joueur combien de chasseurs le poursuivent.
5. **Regroupement / fin** : classement intermédiaire, puis classement final.

## 4. Écran organisateur

**Préparation**
- Créer les joueurs (pseudo, code d'accès), prendre la photo depuis le téléphone de l'organisateur et l'envoyer. [P]
- Importer le périmètre (polygone issu du KMZ). [P]

**Pilotage**
- Boutons : Lancer la dispersion (manche 1 ou 2), Fin de manche, Regroupement, Fin du jeu, Réinitialiser. [C]
- Tirage automatique au premier appel après la fin de la dispersion ; bouton « Tirer maintenant » en secours. [C]
- Pings déduits de START : chasseurs à +15, +30, +45 ; général à +40. [C]

**Contrôles en direct**
- Révéler la position d'un joueur (à ses chasseurs ou à tous).
- Demander la position à un joueur ou à tous (ping manuel, même fenêtre de 1 min).
- Message à tous ou à un joueur.
- Corrections : ajuster les points avec un motif (sert aussi à annuler un −3 dû à une panne), annuler une capture, réattribuer une cible.
- Vue d'ensemble : tableau des joueurs (score, cible, nombre de chasseurs, immunité, dernière position, hors périmètre) et carte des positions connues.
- Journal horodaté de tous les événements.

**Après le jeu**
- Export du classement.
- Bouton « Purger les données » : supprime photos et positions. [C]

## 5. Logique de jeu

**Manche** : 60 min après START. [C]

**Tirage des cibles** [C]
- **Tirage de départ en boucle** : les joueurs sont mélangés puis chacun chasse le suivant. Tout le monde a exactement un chasseur au départ.
- Manche 2 : nouveau tirage en boucle.
- **Réattributions au hasard** parmi les joueurs, en excluant le chasseur lui-même et la cible qu'il vient de quitter. Plusieurs chasseurs peuvent avoir la même cible.

**Capture en deux temps** [C]
1. **« Wanted ! »** (`spot_target`) : le chasseur pense avoir trouvé sa cible. La cible est prévenue (bandeau, vibration, bip, son code affiché) et **doit s'arrêter**. Le chasseur n'est pas nommé.
2. **Saisie du code** (`submit_capture`) : possible seulement pendant la **minute** qui suit « Wanted ! », 3 essais.
   - Code bon : +3 pour le chasseur, −2 pour la cible ; nouveau code et 2 min d'immunité pour la cible ; **tous les chasseurs** de cette cible reçoivent une nouvelle cible au hasard.
   - Minute écoulée ou 3 codes faux : **repérage raté** — la cible est immunisée 2 min et le chasseur ne peut plus utiliser « Wanted ! » pendant 2 min. Aucun point.
3. Une cible ne peut être repérée que par un chasseur à la fois. « Wanted ! » est indisponible si la cible est immunisée.
4. Ce mécanisme remplace l'ancien blocage « 3 codes faux en 5 min ».

Limite : la cible n'est prévenue que si la page est ouverte (pas de notification quand le téléphone est verrouillé). Le front interroge le serveur toutes les 3 s pendant une manche.

**Pings**
- Ping chasseur : chaque chasseur voit la position envoyée par sa cible. [C]
- Ping général (+40) : toutes les positions sont visibles par tous. [C]
- **Ping manqué : −3**, appliqué automatiquement. En cas de panne technique avérée, l'organisateur corrige à la main. [C]
- Hors périmètre : détecté à l'envoi, en tenant compte de la précision GPS (signalé seulement si la position est hors zone même en retirant la marge d'erreur), puis signalé à l'organisateur. Pénalité appliquée par l'organisateur. [P]

**Bonus survivant** [C sur le principe, P sur la règle]
- À chaque ping chasseur, on enregistre le nombre de chasseurs de chaque joueur.
- En fin de manche : +1 par ping où le joueur avait au moins 2 chasseurs et n'a pas été trouvé depuis le ping précédent.

**Score** : somme des événements de points, aucun total stocké en dur. [C]

## 6. Données (Supabase)

| Table | Contenu principal |
|---|---|
| `games` | statut (accueil / dispersion / manche / regroupement / terminé), manche en cours, heures de début de dispersion et de START, réglages |
| `players` | pseudo, hash du code d'accès, chemin de la photo, code de capture actuel, immunité jusqu'à, consentement |
| `player_devices` | lien entre une session anonyme Supabase et un joueur |
| `assignments` | manche, chasseur, cible, attribuée à, close à, motif (capture / fin de manche / correction) |
| `captures` | manche, chasseur, cible, horodatage, annulée oui/non |
| `pings` | manche, type (chasseur / général / manuel), heure, fin de fenêtre, portée |
| `ping_snapshots` | ping, joueur, nombre de chasseurs à ce moment |
| `positions` | ping, joueur, latitude, longitude, précision, heure, hors périmètre |
| `score_events` | joueur, manche, points, motif, référence |
| `messages` | destinataire (vide = tous), texte, heure |
| `code_attempts` | chasseur, heure, réussi oui/non |
| *(plus tard)* `quests` | — |

**Sécurité** [C]
- Connexion anonyme Supabase : le téléphone obtient une session, liée au joueur une seule fois à la saisie du code d'accès.
- RLS activé partout, **aucune lecture ni écriture directe** sur les tables de jeu ; toute la logique passe par des fonctions SQL `security definer` qui identifient le joueur par sa session : `get_my_state`, `submit_capture`, `send_position`, `get_leaderboard`, plus des fonctions `org_*` réservées à l'organisateur.
- Codes d'accès longs (6 caractères ou plus, lettres et chiffres).
- Le front interroge `get_my_state` toutes les 10 s environ.
- Photos : bucket **privé**, liens signés accessibles aux seuls joueurs connectés, purgés après le jeu.

## 7. Calendrier

| Échéance | Contenu |
|---|---|
| Sam. 28 nov. | v0 : accès, photos, tirage, capture par code, scores |
| Sam. 5 déc. | Pings, ping général, écran organisateur complet, purge |
| Week-end du 12–13 déc. | Test en conditions réelles avec 5 ou 6 personnes dans le centre-ville |
| 14–18 déc. | Corrections uniquement |

Points de vigilance :
- La murder party du 6 déc. tombe entre deux jalons.
- Le projet Supabase gratuit se met en pause après 7 jours sans activité : le réveiller avant le test et avant le jeu.
- Vérifier dès la v0 que Safari sur iPhone ne redemande pas l'accès à la position à chaque rechargement.

## 8. Points ouverts

- [Ouvert] Afficher ou non au joueur le nombre de chasseurs qui le poursuivent.
- [Ouvert] Montant de la pénalité hors périmètre.
- [Ouvert] Date du jeu.
- [Ouvert] Quêtes : à concevoir après l'équilibrage, hors v0.
- [Ouvert] Tracé du périmètre dans Google Earth, puis export KMZ.

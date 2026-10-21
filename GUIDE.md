# ✈ FlightMap — le guide complet

> Ce document explique **tout** : ce que fait le site, comment l'installer en 2 minutes, chaque fonctionnalité, chaque fichier, chaque route de l'API, chaque variable de configuration, comment le mettre en ligne gratuitement, et quoi faire quand ça ne marche pas.
> Le `README.md` est la version courte ; ici, c'est la version longue.

---

## Sommaire

1. [C'est quoi](#1-cest-quoi)
2. [Installation en 2 minutes](#2-installation-en-2-minutes)
3. [Utiliser le site](#3-utiliser-le-site)
4. [Les données : d'où ça vient, ce que ça coûte (rien)](#4-les-données)
5. [Configuration (.env)](#5-configuration-env)
6. [Architecture et fichiers](#6-architecture-et-fichiers)
7. [L'API (toutes les routes)](#7-lapi)
8. [Mettre en ligne (gratuit)](#8-mettre-en-ligne)
9. [Sécurité, quotas, garde-fous](#9-sécurité-quotas-garde-fous)
10. [Tests](#10-tests)
11. [Dépannage](#11-dépannage)
12. [Licences et attributions](#12-licences-et-attributions)
13. [Limites connues](#13-limites-connues)

---

## 1. C'est quoi

Un **mini-FlightRadar24** qui tourne sur ton ordinateur (ou un hébergeur gratuit) :

- une carte avec **tous les avions en vol** en temps réel, qui bougent de façon fluide ;
- un clic sur un avion → modèle, photo, compagnie, trajet, **trace réelle** parcourue, altitude/vitesse/cap, **horaires et portes**, météo à l'arrivée, **toutes les données ADS-B** (vent, température, autopilote…), historique des vols, événements (remise de gaz, attente…) ;
- un clic sur un **aéroport** → départs, arrivées, pistes, piste en service, METAR ;
- filtres, recherche mondiale, suivi d'un avion, alertes, favoris, statistiques, rejouer une journée, export GPX/KML, mode « au-dessus de moi », FR/EN, installable comme une appli.

**Sans aucune clé d'API, sans compte, sans abonnement.** Une clé gratuite optionnelle ajoute les horaires/portes ; un e-mail de contact optionnel active les grandes photos.

### Comment c'est possible gratuitement

Trois règles, appliquées partout :

1. **Le navigateur ne parle jamais aux sources externes.** Tout passe par ton serveur Node. Sinon 100 visiteurs = 100× le trafic et ton IP est bannie des réseaux bénévoles.
2. **Cache partout, persistant** (SQLite) : une fiche avion ne change pas → gardée 30 jours ; un trajet → 12 h ; les positions → 4 s mais partagées entre tous les visiteurs d'une même zone.
3. **Enrichissement à la demande** : les infos détaillées ne sont demandées **qu'au clic**, jamais en boucle.

---

## 2. Installation en 2 minutes

### Prérequis

- **Node.js 22.13 ou plus** (24 recommandé) : https://nodejs.org (prends la version LTS). Node 22.13+ inclut SQLite, donc **rien à compiler**.
- Une connexion Internet (pour les données en direct).

### Windows

1. Dézippe le dossier `flightmap` où tu veux.
2. Double-clique **`build.bat`** : il vérifie Node, installe les dépendances, télécharge le référentiel (aéroports, pistes, appareils remarquables ≈ 15 Mo), génère les icônes, crée `.env`, lance les tests.
3. Double-clique **`start.bat`** : le serveur démarre et le navigateur s'ouvre sur http://localhost:3000.

Options : `build.bat --force` (refait tout), `build.bat --no-test`, `start.bat 8080` (autre port), `start.bat --dev` (redémarre à chaque modification de fichier).

> Si le zip contenait déjà `node_modules/` et `data/`, `build.bat` les détecte et ne refait pas le travail.

### Linux / macOS

```bash
chmod +x build.sh && ./build.sh
npm start
```

### À la main (toutes plateformes)

```bash
npm install
npm run setup-data      # aéroports, pistes, appareils remarquables
npm run icons           # icônes PWA (déjà fournies)
cp .env.example .env    # facultatif : clés d'API, contact
npm start               # http://localhost:3000
```

### Vérifier que tout va bien

- http://localhost:3000 → la carte avec des avions.
- http://localhost:3000/api/health → JSON : sources actives, référentiel chargé (`airports`, `runways`, `notable`), persistance `sqlite`, quotas, caches.
- Au démarrage, la console affiche ce qui est actif (photos Planespotters, horaires, persistance).

---

## 3. Utiliser le site

### La carte

| Élément | Signification |
|---|---|
| Couleur de l'avion | altitude : gris = sol, bleu = bas, vert = moyen, jaune = croisière, blanc = très haut (légende en bas à gauche) |
| Contour **or** | appareil remarquable (gouvernemental, militaire, historique… base plane-alert-db) |
| Contour / remplissage **rouge** | urgence (squawk 7500 détournement, 7600 panne radio, 7700 urgence) |
| Contour **bleu** | avion sélectionné |
| Étiquette | callsign dès le zoom 9 ; + altitude et vitesse dès le zoom 10 ; jamais superposées |
| Points **jaunes / gris** | aéroports (grands dès le zoom 7, moyens dès le zoom 9) — cliquables |
| Trait **coloré** | trace réelle de l'avion sélectionné (couleur = altitude) |
| Pointillé bleu | vers la destination annoncée |

Entre deux mises à jour (5 s), les avions continuent leur route (cap × vitesse) : c'est une **interpolation**, pas une position reçue.

### Barre du haut

- **Recherche** : callsign (`AFR1496`), immatriculation (`F-GKXM`) ou hex (`392aec`). Cherche d'abord dans la zone affichée, puis **dans le monde entier**. Raccourci : `/`.
- **⚲ Filtres** : voir ci-dessous.
- **📍 Ma zone** : géolocalisation (ou clic sur la carte) → avions au-dessus de toi avec **azimut et élévation** (pour les repérer à l'œil nu) et **prochains passages**.
- **★ Mon compte** : favoris, règles d'alerte, canaux, boîte de réception.
- **📊** : statistiques.
- **EN / FR** : langue. `t` = thème clair/sombre, `f` = plein écran, `Échap` = fermer.
- **Installer** : apparaît sur Chrome/Edge/Android quand le site peut être installé comme une appli.

### Filtres et alertes (⚲)

- **Afficher seulement** : militaires, urgences, appareils remarquables, masquer les avions au sol.
- **Altitude** min / max.
- **Compagnie** (code ICAO à 3 lettres : AFR, RYR, BAW…) et **type** (A320, B77W…). Les **vues rapides** montrent les compagnies et types les plus présents à l'écran : un clic filtre.
- **Texte libre** : callsign, immat, modèle.
- **Vue militaire / OSINT** : ravitailleurs, surveillance/AWACS, chasseurs, transport, hélicoptères, gouvernemental/VIP, drones. La case **« Dessiner les orbites »** trace le chemin récent de ces avions (à partir de ce que ton serveur a vu — 0 appel externe).
- **Alertes (notification)** : prévenu (toast + notification navigateur si tu l'autorises) quand une urgence / un remarquable / un militaire apparaît dans la zone affichée.
- Le compteur en haut indique « affichés / total ». Les filtres sont mémorisés dans ton navigateur.

### Le panneau d'un avion (clic sur un avion)

De haut en bas :

1. **Callsign, compagnie, badges** (urgence, militaire, remarquable).
2. **◎ Suivre** — la carte recentre en continu et le serveur interroge l'avion par son hex : **il ne disparaît plus en sortant de la zone**. **⇪ Partager** — copie un lien `?hex=…`. **☆ Favori** — enregistré dans ton compte.
3. **Photo** — Planespotters (grande, jusqu'à 4 photos avec ‹ ›, photographe crédité) si `CONTACT` est configuré, sinon vignette adsbdb. Clic → page de la photo.
4. **Trajet** (départ → arrivée) et **barre de progression** (km parcourus / restants).
5. **Altitude, vitesse sol, cap, vario** — mis à jour chaque seconde.
6. **Horaires & portes** — bouton « Charger » (API à clé, voir § 5) : prévu / estimé / réel, terminal, porte, tapis, retard, statut. En dessous, **calculé localement** : décollage (réel, observé ou estimé), en vol depuis, distance restante, arrivée estimée, et si l'archive connaît ce numéro de vol : **durée habituelle** et **arrivée probable**.
7. **Trajet réel** — source adsb.lol : décollage réel, aéroport de départ constaté (signalé s'il contredit le référentiel), phase (montée / croisière / descente / approche), durée, distance réellement parcourue, altitude et vitesse max. **Événements** détectés : remise de gaz, attente en hippodrome, retour au départ, déroutement (badges cliquables + marqueurs sur la trace). **▶ Rejouer** le vol affiché (×120). **Exporter** GPX / KML / CSV. **Vols de l'appareil aujourd'hui** (cliquables : chaque trace se dessine).
8. **Historique (30 jours)** — vols archivés par ton serveur, cliquables et rejouables.
9. **Données ADS-B** — vitesse indiquée / vraie / Mach, altitude GPS, cap vrai et magnétique, inclinaison, vent et température en altitude, altitude et cap réglés sur l'autopilote, QNH, modes, catégorie de masse, type de signal (ADS-B / MLAT), qualité de position, signal, messages.
10. **Météo à l'arrivée** (METAR).
11. **Appareil** — modèle, immatriculation, exploitant, hex, squawk, et liens vers la **fiche de l'appareil** et la **fiche du vol**.
12. **Sources** réellement utilisées pour cette fiche.

### Le panneau d'un aéroport (clic sur un point d'aéroport)

- **En-tête** : heure locale (qui avance), date, altitude — fuseau horaire déduit (pays / région / longitude, et appris auprès des APIs d'horaires quand elles répondent).
- **Galerie de photos** (jusqu'à 24, ‹ › + vignettes + touches ← →) : les photos de l'article Wikipédia et de la catégorie **Wikimedia Commons** de l'aéroport, en 960 px, avec **auteur, licence et année** sous chaque photo (obligatoire pour ces licences libres) et lien vers la page du fichier. Les logos, cartes et icônes sont filtrés. **Description** Wikipédia (en français quand la page existe). *JetPhotos (FlightRadar24) n'a pas d'API et interdit la réutilisation : ce n'est pas une option.*
- **METAR** (conditions résumées : ciel dégagé, pluie…, température, vent, visibilité, brut).
- **Piste en service** : *observée* sur les trajectoires des avions bas alignés ; sinon *probable* d'après le vent (meilleur vent de face). Les **pistes sont dessinées** sur la carte, celle en service en bleu.
- **Statistiques 7 jours** — *enregistrées par ton serveur* : mouvements, décollages, atterrissages, par jour, par heure (heure locale), **usage des pistes**, **routes les plus fréquentes**, aéroports et pays desservis. Le serveur détecte les décollages (sol → air, ou apparition en montée près d'un aéroport) et les atterrissages (air → sol, ou disparition en finale), et identifie la piste par le cap. **Chaque aéroport consulté est surveillé automatiquement pendant 24 h** (positions relevées toutes les 90 s autour de lui, 12 aéroports max en rotation) : les compteurs se remplissent même quand personne ne regarde la carte. Les routes sont complétées par lots via adsb.lol (1 requête pour 40 mouvements).
- **Derniers événements** autour de l'aéroport (remises de gaz, attentes, retours, urgences).
- **Arrivées** (avec ETA), **départs** (décollage observé ou « il y a X min »), **au sol** — déduits des avions en vol (position, cap, vario) ; l'autre extrémité du trajet vient d'adsb.lol (une seule requête pour tout le tableau). Chaque ligne est cliquable.
- **Fiche** : nom, codes, ville et pays, fuseau (UTC±), altitude, **lever et coucher du soleil** (calculés, algorithme NOAA — soleil de minuit / nuit polaire gérés), taille, vols réguliers, liens (site officiel, Wikipédia, widget), **vue satellite** (Esri World Imagery, pistes surlignées, clic → la carte s'y rend).
- Rafraîchi toutes les 60 s. Accès direct : `/?airport=CDG` ou `/airport/CDG`. Stats seules : `/api/airport/CDG/stats?days=30`. Classement des aéroports les plus actifs vus par le serveur : `/api/airports/busiest`.

> Différence avec FlightRadar24 : eux ont l'historique de tous les aéroports du monde depuis des années ; ici, les statistiques commencent quand ton serveur tourne, pour les aéroports consultés (ou les zones regardées). Après quelques jours en ligne, les grands aéroports que tes visiteurs ouvrent ont des chiffres complets.

### Pages

| Page | Contenu |
|---|---|
| `/stats.html` | avions uniques par heure, compagnies et types les plus vus, altitudes, militaires / remarquables / urgences, jours précédents, **carte de chaleur**. Compté sur les zones que les visiteurs regardent. |
| `/replay.html` | **rejouer une journée** : tous les vols archivés d'un jour animés sur la carte, ×60 à ×1800, curseur temporel. |
| `/aircraft/F-GKXM` | fiche appareil : vols 30 j, heures de vol, km, aéroports fréquentés, numéros de vol, photo, export KML par vol. |
| `/flight/AF1496` | fiche vol : durées (médiane, min, max), régularité du décollage, trajets observés, appareils utilisés, événements. |
| `/embed.html?airport=CDG` | **widget** à mettre dans un `<iframe>` (aussi `?lat&lon&z`, `?hex=` pour suivre un avion, `&theme=light`). |
| `/?tour=1` | revoir la visite guidée. |

### Compte (★) — sans mot de passe

Le navigateur crée un **jeton** aléatoire ; le serveur y rattache tes données. **Garde le jeton** (bouton copier) : c'est le seul moyen de retrouver ton compte sur un autre appareil (colle-le puis ↵).

- **Favoris** : avions enregistrés, ouvre-les d'un clic (→).
- **Règles d'alerte** (20 max) : « avion F-GKXM (ou hex) en vol », « vol AFR1496 en vol », « type A388 en approche de LFPG ». Vérifiées toutes les 1–5 min (rythme borné pour respecter les sources), cooldown 2 h par règle.
- **Canaux** : la boîte de réception (toasts dans la page, toujours) + **Telegram** et/ou **e-mail** si le serveur les a configurés (§ 5). « Tester » envoie une alerte de test.

### Accessibilité

- `←` `→` (ou `J` `K`) passent d'un avion visible à l'autre (du plus proche du centre au plus loin), `Entrée` ouvre, `Échap` ferme.
- Liste hors écran des avions visibles pour les lecteurs d'écran, focus déplacé sur le panneau à l'ouverture, `role`/`aria` sur tous les panneaux.

---

## 4. Les données

| Besoin | Source | Quota | Clé | Cache |
|---|---|---|---|---|
| Positions en direct | **adsb.lol** (principal, ODbL) → adsb.fi → airplanes.live | ~1 req/s chacun | non | 4 s, par zone |
| Identité (hex → modèle, immat, exploitant) | **adsbdb** → hexdb.io → base OpenSky locale (optionnelle) | — | non | 30 j |
| Photos | **Planespotters.net** (si `CONTACT`) → adsbdb (vignette) | ~1 req/s | non (contact) | 30 j |
| Trajet (callsign → départ/arrivée) | **adsb.lol routeset** → adsbdb → hexdb.io | — | non | 12 h |
| Aéroports, pistes | **OurAirports** (domaine public) — fichiers locaux | 0 appel | non | — |
| Appareils remarquables | **plane-alert-db** — fichier local | 0 appel | non | — |
| Météo METAR | **aviationweather.gov** (NOAA) | 100/min | non | 10 min |
| Trace réelle | **adsb.lol** `trace_full` + `trace_recent` (fichiers statiques) | ~1 req/s | non | 45 s |
| Horaires, portes, retards | **AeroDataBox** → **AirLabs** → **Aviationstack** | 300 / 1 000 / 100 par mois | **oui** (gratuite) | 10–15 min |
| Historique > 24 h, stats, prédictions | **ton serveur** (SQLite) | — | — | — |

Détails qui comptent :

- **adsb.lol** : projet bénévole. Une requête par seconde maximum, sinon 429 et ton IP est pénalisée. Le serveur a un *backoff* (30 s de pause après un 429) et bascule sur adsb.fi.
- **airplanes.live** répond 403 tant que tu ne leur as pas écrit (contact@airplanes.live) : c'est normal, il est en dernier de la chaîne.
- **Aviationstack** via apilayer : la clé ne marche que sur `https://api.apilayer.net/aviationstack/v1/…` ; les heures sont renvoyées en heure locale avec un faux suffixe `+00:00` — le serveur les réinterprète avec le fuseau de l'aéroport. Chaque réponse contient une ligne par codeshare : le serveur choisit l'exploitant réel.
- **Traces** : adsb.lol ne garde que ~24 h. Ton serveur **archive** dans SQLite les vols des avions que quelqu'un a consultés (rafraîchis toutes les 20 min pendant 24 h, 60 avions max par passage) → historique 30 jours, prédictions, fiches, rejouer une journée.
- **Devenir feeder** (récepteur ADS-B ~40 €) : tu rends aux réseaux ce que tu consommes, ton IP n'est plus limitée, et **AeroDataBox devient illimité gratuit** pour les feeders. Guide : https://adsb.lol/feed

---

## 5. Configuration (.env)

Copie `.env.example` en `.env` (build.bat le fait). **Tout est facultatif.** En ligne, mets ces variables dans le dashboard de l'hébergeur (jamais dans le code).

| Variable | Défaut | Effet |
|---|---|---|
| `PORT` | `3000` | port du serveur |
| `CONTACT` | — | `mailto:toi@exemple.fr` ou `https://ton-site/contact` → active les **photos Planespotters** (2× plus grandes). Exigé par leur API. |
| `AVIATIONSTACK_KEY` | — | horaires/portes via Aviationstack (100/mois gratuits) — clé sur https://app.apilayer.com |
| `AIRLABS_KEY` | — | horaires via AirLabs (~1 000/mois) — https://airlabs.co |
| `AERODATABOX_KEY` | — | horaires via AeroDataBox (~300/mois, **illimité si feeder**) — https://rapidapi.com/aedbx-aedbx/api/aerodatabox |
| `AVIATIONSTACK_QUOTA` / `AIRLABS_QUOTA` / `AERODATABOX_QUOTA` | `100` / `1000` / `300` | ton quota mensuel si ton plan diffère |
| `SCHEDULE_AUTO` | `0` | `1` = horaires chargés dès le clic (sinon bouton, pour économiser un petit quota) |
| `SCHEDULE_PER_IP_DAY` | `10` | consultations d'horaires par visiteur et par jour |
| `TELEGRAM_BOT_TOKEN` | — | alertes Telegram. Crée un bot avec @BotFather (`/newbot`), colle le jeton. Les visiteurs connectent leur chat via « Connecter le bot » dans ★. |
| `RESEND_API_KEY` | — | alertes e-mail via Resend (3 000/mois gratuits) |
| `BREVO_API_KEY` | — | alertes e-mail via Brevo (300/jour gratuits) — l'un ou l'autre |
| `MAIL_FROM` | `FlightMap <onboarding@resend.dev>` | expéditeur |
| `PUBLIC_URL` | — | URL publique du site (liens dans les alertes) |
| `DATA_DIR` | `./data` | dossier de SQLite et du quota (monte un volume en prod) |
| `COMMERCIAL` | `0` | `1` = ne garde que les sources autorisées en usage commercial (adsb.lol) |
| `LOCAL_FIRST` | `0` | `1` = la base locale répond avant les APIs (0 appel, mais pas de photo) |
| `USER_AGENT` | `flightmap/2.0…` | identité envoyée aux APIs |

**Sécurité des clés** : `.env` est dans `.gitignore` et exclu du Dockerfile. Si une clé a circulé (message, capture d'écran, dépôt public), régénère-la.

---

## 6. Architecture et fichiers

```
NAVIGATEUR                      TON SERVEUR (Node/Express)                 SOURCES
──────────                      ─────────────────────────                  ───────
carte Leaflet ◀── SSE 5 s ───  /api/stream  ── cache 4 s ──▶ adsb.lol → adsb.fi → airplanes.live
(canvas)       (ou poll)       /api/aircraft/hex, /api/search ────▶ idem (suivre, recherche mondiale)
clic avion ── 1 fois ──▶  /api/flight/:hex ── SQLite 30 j ──▶ adsbdb → hexdb → local ; Planespotters
                                            ── SQLite 12 h ──▶ routeset → adsbdb → hexdb ; OurAirports (local)
                                            ── 10 min ───────▶ NOAA METAR
                          /api/trail/:hex ── 45 s ───────────▶ adsb.lol traces → découpage en vols → archive SQLite
bouton horaires ──▶ /api/flight/:hex/schedule ── quota + SQLite ──▶ AeroDataBox → AirLabs → Aviationstack
clic aéroport ──▶ /api/airport/:code ──▶ positions autour + routeset par lot + METAR + pistes (local)
```

### Serveur

| Fichier | Rôle |
|---|---|
| `server.js` | toutes les routes, rate-limits, SSE, fichiers statiques, chargement de `.env` |
| `lib/providers.js` | **tous les appels externes sans clé** : positions (zone / hex / recherche), identité, photos, trajets (unitaires et par lot), météo ; backoff 429 ; historique local des positions ; index immat → hex |
| `lib/trail.js` | trace adsb.lol → découpage en vols (« legs »), aéroports devinés, callsign par vol, événements |
| `lib/events.js` | détection : remise de gaz, attente, retour, déroutement ; flux des 24 h |
| `lib/archive.js` | archive des vols dans SQLite, job de rafraîchissement, historique 30 j |
| `lib/registry.js` | prédiction de durée, fiches avion et vol, correspondance IATA→ICAO |
| `lib/airport.js` | fiche d'aéroport : tableau, piste en service, faits, Wikipédia, stats, événements |
| `lib/movements.js` | détection des décollages / atterrissages + piste, statistiques par aéroport, surveillance automatique des aéroports consultés |
| `lib/geo.js` | fuseau horaire (pays / région / longitude + appris), lever / coucher du soleil (NOAA), noms de pays |
| `lib/wiki.js` | photo et description Wikipédia (cache 30 j) |
| `lib/schedule.js` | horaires : AeroDataBox / AirLabs / Aviationstack, normalisation, fuseaux, codeshares |
| `lib/quota.js` | compteur mensuel / journalier des APIs à clé, persistant (`data/quota.json`) |
| `lib/accounts.js` | comptes légers, favoris, règles, moteur d'alertes, Telegram, e-mail |
| `lib/export.js` | GPX / KML / CSV |
| `lib/stats.js` | agrégats journaliers, noms de compagnies |
| `lib/store.js` | SQLite via `node:sqlite` (repli JSON) : cache KV, vols, stats |
| `lib/cache.js` | cache TTL en mémoire, optionnellement persistant ; déduplication |
| `lib/stream.js` | SSE : une requête amont par zone quel que soit le nombre de visiteurs |
| `lib/ratelimit.js` | limites par IP et par famille de routes |
| `lib/refdata.js` | référentiel local : aéroports, aéroport le plus proche, pistes, remarquables, immats |
| `lib/limiter.js` | 1 req/s max par API + fetch avec timeout |
| `lib/csv.js` | lecteur CSV |
| `scripts/setup-data.js` | télécharge et convertit OurAirports (aéroports + pistes), plane-alert-db, OpenSky (option `--opensky`) |
| `scripts/make-icons.js` | génère les icônes PNG (encodeur maison, 0 dépendance) |

### Front (`public/`)

| Fichier | Rôle |
|---|---|
| `index.html` · `style.css` | page principale (thème clair/sombre via variables CSS) |
| `app.js` | point d'entrée (module ES) |
| `js/state.js` | état partagé, bus d'événements, préférences, utilitaires |
| `js/map.js` | carte Leaflet, tuiles OSM, thème |
| `js/render.js` | rendu canvas, couleurs, interpolation, étiquettes sans chevauchement |
| `js/data.js` | SSE / poll, suivi d'un avion, recherche mondiale |
| `js/panel.js` | panneau avion : fiche, photos, horaires, estimations, trace, événements, historique, rejouer, export, ADS-B |
| `js/filters.js` · `js/military.js` | filtres, vues rapides, vue OSINT, orbites, alertes navigateur |
| `js/airports.js` | marqueurs, panneau aéroport, pistes |
| `js/mezone.js` | ma zone |
| `js/account.js` | compte, favoris, règles, boîte de réception |
| `js/url.js` | URL partageable |
| `js/pwa.js` | service worker, installation, plein écran, thème, raccourcis |
| `js/i18n.js` | FR / EN |
| `js/a11y.js` | clavier, lecteurs d'écran |
| `js/tour.js` | visite guidée |
| `stats.html` · `replay.html` · `aircraft.html` · `flight.html` · `embed.html` | pages |
| `manifest.webmanifest` · `sw.js` · `icons/` | PWA |

### Données générées (`data/`, non versionné)

`airports.json`, `runways.json`, `notable.json` (référentiel), `aircraft-db.json` (optionnel), `flightmap.db` (SQLite : caches, vols archivés, stats, comptes), `quota.json`.

---

## 7. L'API

Toutes les routes renvoient du JSON. Les limites par IP : 240 req/min en général, 30 recherches/min, 60 traces/min, `SCHEDULE_PER_IP_DAY` horaires/jour (les réponses en cache ne comptent pas).

### Positions

| Route | Description |
|---|---|
| `GET /api/aircraft?lat&lon&dist` | avions autour d'un point (dist en NM, 25–250) |
| `GET /api/stream?lat&lon&dist` | même chose, poussé en **SSE** toutes les 5 s (`event: aircraft`) |
| `GET /api/aircraft/hex/:hex` | un avion précis, où qu'il soit |
| `GET /api/search?q=` | callsign, immat ou hex, monde entier |

### Avion

| Route | Description |
|---|---|
| `GET /api/flight/:hex?callsign&lat&lon` | fiche complète : identité, photos, trajet, météo, remarquable, décollage observé, horaires (si en cache), prédiction, mode horaires |
| `GET /api/flight/:hex/schedule?callsign&flight` | horaires / portes (dépense du quota à clé) |
| `GET /api/trail/:hex?callsign` | trace réelle : vols du jour, événements, aéroports devinés |
| `GET /api/trail/:hex/export.gpx\|kml\|csv?leg=i` ou `?archived=ISO` | export d'un vol |
| `GET /api/history/:hex?days=30` | vols archivés |
| `GET /api/local-trails?hexes=a,b,c` | positions vues par ce serveur (orbites) |
| `GET /api/registry/aircraft/:reg\|hex` | fiche appareil |
| `GET /api/registry/flight/:number` | fiche vol (`AF1496` ou `AFR1496`) |

### Aéroports, événements, stats

| Route | Description |
|---|---|
| `GET /api/airports?south&west&north&east[&min=large]` | aéroports à dessiner dans une zone |
| `GET /api/airport/:code` | fiche complète : faits (fuseau, heure locale, soleil, altitude), Wikipédia, METAR, pistes, piste en service, statistiques 7 j, événements, départs / arrivées / sol |
| `GET /api/airport/:code/stats?days=7` | statistiques seules (1–30 jours) |
| `GET /api/airports/busiest?days=7` | aéroports les plus actifs vus par ce serveur |
| `GET /api/events` | remises de gaz, attentes… des 24 h |
| `GET /api/stats?days=7` | agrégats |
| `GET /api/replay?day=YYYY-MM-DD` | tous les vols archivés d'un jour |

### Compte (en-tête `X-User-Token`)

| Route | Description |
|---|---|
| `POST /api/me/new` | crée un jeton |
| `GET /api/me` | favoris, règles, canaux, boîte de réception, info Telegram |
| `PUT /api/me/favorites` · `PUT /api/me/rules` · `PUT /api/me/channels` | mises à jour |
| `GET /api/me/inbox?since=` | notifications |
| `POST /api/me/test` | alerte de test sur tous les canaux |

### Supervision

| Route | Description |
|---|---|
| `GET /api/ping` | `ok` — ultra-léger, pour UptimeRobot |
| `GET /api/health` | sources, quotas, caches, store, SSE, comptes, référentiel |

---

## 8. Mettre en ligne

Un seul conteneur = un seul cache partagé, c'est l'idéal. **Évite le serverless** (Vercel/Netlify functions) : chaque requête démarre à froid, perd le cache, le quota et le flux SSE.

### Render (gratuit, le plus simple)

1. Pousse le projet sur GitHub (sans `.env`, `data/`, `node_modules/` — le `.gitignore` s'en charge).
2. Render → *New* → *Blueprint* → choisis le dépôt. `render.yaml` est lu : build `npm ci && npm run setup-data`, Node 24.
3. Dans *Environment*, ajoute tes variables (`CONTACT`, `AVIATIONSTACK_KEY`, `TELEGRAM_BOT_TOKEN`…, `PUBLIC_URL`).
4. Vérifie `https://ton-app.onrender.com/api/health`.

Sur le plan gratuit le disque est **éphémère** : SQLite repart de zéro à chaque *redéploiement* (pas à chaque réveil). Le service s'endort après 15 min sans visite → crée un moniteur gratuit **UptimeRobot** sur `/api/ping` toutes les 5 min : plus de mise en veille, et tu es prévenu s'il tombe.

### Fly.io / Railway / VPS (Docker)

```bash
docker build -t flightmap .
docker run -p 3000:3000 --env-file .env -v flightmap-data:/app/data flightmap
```

Le volume `/app/data` garde SQLite (archive, comptes, quota) entre les déploiements.

### VPS classique (Hetzner ~4 €/mois, le vrai déploiement « sérieux »)

```bash
git clone … && cd flightmap && ./build.sh --no-test
PORT=3000 npm start          # derrière nginx/caddy en HTTPS, ou avec pm2 : pm2 start server.js --name flightmap
```

### Obligations en ligne

- Garde les attributions en pied de page : **adsb.lol (ODbL)**, **OpenStreetMap**, **Planespotters** (photographe sous chaque photo), OurAirports.
- Si le site rapporte de l'argent : `COMMERCIAL=1` (adsb.fi, airplanes.live, OpenSky interdisent l'usage commercial).

---

## 9. Sécurité, quotas, garde-fous

- **Rate-limit par IP** par famille de routes ; en-têtes `X-RateLimit-*` et `Retry-After`.
- **Quota des APIs à clé** : plafond mensuel −5 % + plafond journalier (2× la moyenne), persistant ; quand c'est épuisé le panneau le dit et rien n'est dépensé. Limite par visiteur (`SCHEDULE_PER_IP_DAY`). Mode bouton par défaut.
- **SSE** : 300 connexions max, 4 par IP ; une seule requête amont par zone.
- **Backoff** des sources qui répondent 429/5xx ; **déduplication** des requêtes simultanées ; **caches persistants**.
- **Archivage limité** aux avions consultés, 60 par passage : on ne moissonne pas adsb.lol.
- **Moteur d'alertes** borné à 20 recherches/min au total.
- Comptes : jeton aléatoire de 48 hex, aucune donnée personnelle obligatoire ; l'e-mail et le chat Telegram ne servent qu'à envoyer les alertes.
- Les clés restent côté serveur : le navigateur ne les voit jamais.

---

## 10. Tests

```bash
npm test
```

27 tests (`node --test`, aucun framework) couvrant : découpage des traces en vols, aéroports devinés, choix du bon codeshare, conversion des fuseaux Aviationstack, quota, cache TTL et persistant, déduplication, rate-limit, store, détection d'événements, prédiction de durée, exports, piste en service. Ils tournent dans un dossier temporaire (jamais dans `data/`).

---

## 11. Dépannage

| Symptôme | Cause / solution |
|---|---|
| `build.bat` : « Node.js 22.13 ou plus est requis » | installe la LTS depuis nodejs.org, relance |
| Console : `Persistance : json (node:sqlite indisponible)` | Node trop ancien ; ça marche mais moins bien. Passe à Node 24. |
| Carte vide, « source injoignable » | pas de réseau, ou les 3 sources en pause (429). Regarde la console serveur. Attends 30 s. |
| `[live] adsb.lol en pause 30 s (HTTP 429)` | trop de requêtes depuis ton IP (deux serveurs qui tournent ? un autre outil ADS-B ?). Normal ponctuellement ; le repli adsb.fi prend le relais. |
| Photos floues / petites | ajoute `CONTACT=` dans `.env` (§ 5) et redémarre |
| « Quota gratuit du jour épuisé » | protection normale ; remis à zéro le lendemain (UTC). Augmente `*_QUOTA` si ton plan est plus large, ou passe à AeroDataBox. |
| Horaires : « Aucune clé configurée » | mets une clé dans `.env` |
| Aéroports sans pistes | relance `npm run setup-data` (fichier `runways.json`) |
| Pas d'historique / fiche vide | l'archive se construit à partir du moment où le serveur tourne et où quelqu'un consulte un avion |
| Alertes Telegram : « Non connecté » | clique « Connecter le bot », envoie `/start` (le lien le fait) ; le serveur relie ton chat sous 30 s |
| Le navigateur garde une vieille version | le service worker se met à jour au rechargement ; force avec Ctrl+F5 ou vide le cache du site |
| Port déjà utilisé | `start.bat 8080` ou `PORT=8080 npm start` |

Logs : la console du serveur. Détails : `/api/health`.

---

## 12. Licences et attributions

- **adsb.lol** : données sous **ODbL** — attribution obligatoire (présente en pied de page). ~1 req/s.
- **adsb.fi**, **airplanes.live** : gratuits, usage non commercial.
- **adsbdb**, **hexdb.io** : gratuits.
- **Planespotters.net** : photos utilisables avec **crédit du photographe** (affiché) et lien ; User-Agent avec contact obligatoire ; seules les tailles fournies par l'API sont autorisées.
- **OurAirports** : domaine public.
- **plane-alert-db** : open data (sdr-enthusiasts).
- **NOAA aviationweather.gov** : domaine public US.
- **OpenStreetMap** : tuiles sous ODbL, attribution obligatoire ; usage raisonnable des tuiles (pas de téléchargement massif).
- **Leaflet** : BSD-2. **Express** : MIT.

---

## 13. Limites connues

- **Pas de couverture océanique** : l'ADS-B est capté au sol par des bénévoles. Au milieu de l'Atlantique, personne (FlightRadar24 a des satellites).
- **Trajet parfois inconnu** : l'avion ne diffuse pas sa destination ; elle est devinée depuis le callsign. La trace réelle donne en revanche l'aéroport de départ constaté.
- **Horaires : seulement avec une clé**, dans la limite du quota gratuit.
- **Photos** : 419 × 280 px maximum via l'API Planespotters (les originaux ne sont pas exposés).
- **Historique** : seulement à partir du moment où ton serveur tourne, et pour les avions consultés.
- **Stats** : ce que le serveur a vu (les zones regardées), pas le trafic mondial.
- **Alertes** : une règle « avion en vol » est vérifiée toutes les 1–5 min selon le nombre de règles ; elle ne détecte pas un vol de 3 minutes.
- **Installation PWA** : proposée par Chrome / Edge / Android ; Safari iOS passe par « Partager → Sur l'écran d'accueil ».

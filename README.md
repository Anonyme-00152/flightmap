# ✈ FlightMap — suivi des vols en direct, 100 % gratuit

Un mini-FlightRadar24 : carte sombre (ou claire), avions qui bougent en temps réel, clic sur un avion → modèle, immatriculation, exploitant, photo, trajet, **trace réelle**, horaires & portes, météo à l'arrivée, données ADS-B complètes, historique des vols. Filtres, recherche mondiale, suivi d'un avion, alertes, statistiques, installable en PWA.

**Aucune clé API obligatoire. Aucun compte. Aucun abonnement.** Une clé gratuite optionnelle ajoute les horaires/portes.

---

📖 **Guide complet : [GUIDE.md](GUIDE.md)** — installation, chaque fonctionnalité, chaque fichier, chaque route, déploiement, dépannage.

## 🚀 Démarrer

Il te faut [Node.js 22.13 ou plus](https://nodejs.org) (24 recommandé : SQLite intégré, aucune compilation).

**Windows** : double-clique `build.bat` (installe tout), puis `start.bat`. **Linux / macOS** : `./build.sh` puis `npm start`.

À la main :

```bash
npm install
npm run setup-data      # télécharge le référentiel (aéroports, appareils remarquables)
npm start
```

Puis ouvre **http://localhost:3000**

Optionnel : copie `.env.example` en `.env` et colle une clé Aviationstack / AirLabs / AeroDataBox pour les horaires.

### Variantes

```bash
npm test                  # 17 tests (découpage des traces, codeshares, fuseaux, quota, cache, rate-limit, store)
npm run dev               # redémarrage automatique
npm run setup-data:full   # + base d'immatriculations OpenSky (~100 Mo à télécharger)
npm run icons             # régénère les icônes PWA
COMMERCIAL=1 npm start    # mode commercial : ne garde que les sources autorisées
LOCAL_FIRST=1 npm start   # la base locale répond avant les APIs (0 appel, mais pas de photo)
PORT=8080 npm start
```

---

## 🧠 Comment ça marche

```
   NAVIGATEUR                     TON BACKEND                          SOURCES
   ──────────                     ───────────                          ───────

   carte Leaflet  ◀──SSE 5 s────  /api/stream   ──cache 4 s──▶  adsb.lol → adsb.fi → airplanes.live
   (canvas)        (ou poll)      /api/aircraft                  (backoff 30 s sur 429)
   interpolation
   locale                         /api/aircraft/hex/:hex  ─────▶  idem (mode « suivre »)
                                  /api/search?q=          ─────▶  idem (callsign / immat / hex, monde entier)

   clic sur un   ──1 seule fois─▶ /api/flight/:hex
   avion                              identité  ──cache 30 j (SQLite)──▶ adsbdb → hexdb.io → base locale
                                      photo     ───────────────────────▶ adsbdb, sinon Planespotters.net
                                      trajet    ──cache 12 h (SQLite)──▶ adsb.lol routeset → adsbdb → hexdb.io
                                      aéroports ───────────────────────▶ OurAirports (local, 0 appel)
                                      badge     ───────────────────────▶ plane-alert-db (local, 0 appel)
                                      météo     ──cache 10 min─────────▶ aviationweather.gov (NOAA)

                                  /api/trail/:hex   ──cache 45 s──▶ adsb.lol trace_full + trace_recent
                                        │ découpage en vols, aéroports devinés, archivage SQLite
                                  /api/history/:hex ──────────────▶ SQLite (30 jours)

   bouton        ──à la demande─▶ /api/flight/:hex/schedule
   « horaires »                       quota + cache (SQLite) ──▶ AeroDataBox → AirLabs → Aviationstack (clé)

   /stats.html   ◀──────────────  /api/stats   ◀── agrégé de ce que le serveur voit passer (0 appel)
```

### Les 3 règles qui rendent le projet gratuit

1. **Le navigateur ne parle JAMAIS aux APIs externes.** Tout passe par le backend. Sinon : 100 visiteurs = 100 × le trafic, et ton IP se fait bannir par adsb.lol (projet bénévole, ~1 req/s tolérée).
2. **Cache partout, persistant.** `hex → modèle` ne change jamais → 30 jours. Trajet → 12 h. Horaires → 10–15 min. Positions → 4 s, mutualisées entre visiteurs d'une même zone. Les caches longs sont dans SQLite : un redémarrage ne coûte rien.
3. **Enrichissement à la demande.** Les infos détaillées ne sont demandées **qu'au clic**, jamais en boucle pour tous les avions de l'écran.

Vérifie que ça marche : **http://localhost:3000/api/health** affiche les sources actives, le quota consommé, le store, les flux SSE ouverts et le taux de succès des caches (`hitRate`).

---

## 🆕 Version 4 — ce qui s'ajoute (tout gratuit)

| | |
|---|---|
| **Aéroport en un clic** | marqueurs d'aéroports (grands dès le zoom 7, moyens dès 9). Clic → heure locale, altitude, **photo et description Wikipédia**, **METAR** avec conditions, **piste en service**, **statistiques 7 jours enregistrées par ton serveur** (mouvements, décollages / atterrissages par jour et par heure, usage des pistes, routes les plus fréquentes, aéroports et pays desservis — chaque aéroport consulté est surveillé 24 h automatiquement), derniers événements, **départs / arrivées / au sol**, fiche (fuseau, lever / coucher du soleil calculés, liens) et **vue satellite** avec pistes. `/?airport=CDG` ou `/airport/CDG`. |
| **Prédiction d'arrivée** | durée médiane des vols passés du même numéro (archive SQLite) → « durée habituelle 2 h 41 (7 vols) · arrivée probable 21:12 ». |
| **Événements** | détectés sur la trace : **remise de gaz**, **attente en hippodrome** (tours, durée), **retour au départ**, **déroutement**. Badges dans le panneau, marqueurs sur la trace, flux `/api/events`. |
| **Vue militaire / OSINT** | dans Filtres : ravitailleurs, surveillance/AWACS, chasseurs, transport, hélicoptères, gouvernemental/VIP, drones (catégories plane-alert-db) + **orbites** dessinées depuis l'historique local (0 appel externe). |
| **Ma zone** 📍 | géolocalisation (ou clic manuel) → avions **au-dessus de moi** avec azimut / élévation pour les repérer à l'œil nu, et **prochains passages** (point d'approche calculé). |
| **Fiches** | `/aircraft/F-GKXM` (vols, heures, aéroports, numéros) et `/flight/AF1496` (durées, régularité, appareils, événements). Liens dans le panneau. |
| **Rejouer une journée** | `/replay.html` : tous les vols archivés d'un jour animés sur la carte, vitesse ×60 à ×1800. |
| **Export** | GPX / KML (Google Earth, avec `gx:Track` animé) / CSV de tout vol affiché ou archivé. |
| **Compte léger** ★ | sans mot de passe (jeton local) : **favoris**, **règles d'alerte** (« F-GKXM en vol », « AFR1496 en vol », « A388 en approche de LFPG ») envoyées dans la page, par **Telegram** ou **e-mail** (Resend/Brevo). Cooldown 2 h, 20 règles max, moteur borné à 20 recherches/min au total. |
| **Widget** | `<iframe src="/embed.html?airport=CDG">` ou `?lat&lon&z` ou `?hex=` (suit l'avion). |
| **FR / EN** | bouton EN/FR, `?lang=en`, détection du navigateur. |
| **Accessibilité** | navigation clavier entre avions (← → ou J/K, Entrée), liste hors écran pour lecteurs d'écran, focus géré, `role`/`aria` sur les panneaux. |
| **Visite guidée** | 4 étapes à la première visite, `?tour=1` pour la revoir, lien en pied de page. |

---

## 🗺️ Ce qu'il y a dans l'interface

| | |
|---|---|
| **Carte** | rendu canvas (des milliers d'avions), orientés selon le cap, couleur = altitude, contour or = remarquable, rouge = urgence. Interpolation locale entre deux mises à jour. Étiquettes callsign (zoom ≥ 9) + altitude/vitesse (zoom ≥ 10) **sans chevauchement**. |
| **Flux temps réel** | SSE : le serveur pousse les positions ; repli automatique en poll. Zéro requête onglet caché. |
| **Filtres** ⚲ | militaires, urgences (7500/7600/7700), remarquables, masquer le sol, altitude min/max, compagnie, type, texte libre. **Vues rapides** : les compagnies et types les plus présents à l'écran en un clic. Compteur « affichés / total ». Mémorisé dans le navigateur. |
| **Alertes** | notification (page + navigateur) quand une urgence / un remarquable / un militaire apparaît dans la zone. |
| **Recherche** | callsign, immatriculation ou hex : dans la zone affichée d'abord, puis **le monde entier** (adsb.lol / adsb.fi). |
| **Suivre** ◎ | recentre en continu et interroge l'avion par hex : il ne disparaît plus en sortant de la zone. |
| **Partager** ⇪ | lien `?hex=…` ; la vue `?lat&lon&z` est aussi dans l'URL. |
| **Panneau** | photo (adsbdb, sinon Planespotters avec crédit photographe), trajet, barre de progression, altitude / vitesse / cap / vario, **horaires & portes** (bouton), estimation d'arrivée, **trajet réel** (décollage réel, phase, durée, distance parcourue, alt/vitesse max), **vols du jour** cliquables, **historique 30 jours**, ▶ **rejouer** un vol, **données ADS-B** (IAS/TAS/Mach, vent, température, autopilote, QNH, catégorie, signal…), météo METAR, fiche appareil. |
| **Stats** 📊 | `/stats.html` : avions uniques par heure, compagnies et types les plus vus, altitudes, militaires / remarquables / urgences, jours précédents, **carte de chaleur**. |
| **Thème / plein écran / PWA** | ☀ clair / sombre, ⤢ plein écran, installable (Android, Chrome, Edge), interface disponible hors ligne. Raccourcis : `/` recherche, `t` thème, `f` plein écran, `Échap` fermer. |

---

## 📡 Toutes les sources

### 01 · Positions en direct — *le moteur de la carte*

| Source | Quota | Clé | Commercial |
|---|---|---|---|
| **adsb.lol** — principal | dynamique, ~1 req/s | non | ✅ ODbL, attribution |
| **adsb.fi** — secours 1 | 1 req/s | non | ❌ |
| **airplanes.live** — secours 2 | 1 req/s (accès sur demande) | non | ❌ |

Même format (héritage ADS-B Exchange v2) : bascule automatique, **backoff 30 s** pour un fournisseur qui répond 429/5xx.

### 02 · Identité de l'appareil — *hex → modèle, immat, exploitant, photo*

**adsbdb** → **hexdb.io** → **base locale OpenSky**.

**Photos** : adsbdb ne fournit qu'une vignette de 200 × 133 px (et un lien « grande image » airport-data souvent en 404). Pour des photos nettes, mets **`CONTACT=mailto:toi@exemple.fr`** (ou une URL de contact) dans `.env` : **Planespotters.net** devient la source principale — 419 × 280 px, jusqu'à 4 photos par appareil (galerie ‹ ›), photographe crédité sous la photo (obligatoire). Sans `CONTACT`, leur API répond 403 et on reste sur les vignettes. Le navigateur tente d'abord la grande image, puis retombe sur la vignette ; cadre fixe 3:2, jamais étiré. Les fiches déjà en cache sont améliorées à leur prochaine consultation.

### 03 · Trajet — *callsign → départ / arrivée*

**adsb.lol routeset** → **adsbdb** (nom de la compagnie) → **hexdb.io** (codes complétés par OurAirports).

### 04 · Référentiel local — *0 appel réseau*

**OurAirports** (aéroports, domaine public), **plane-alert-db** (appareils remarquables), **OpenSky** (immatriculations, optionnel).

### 05 · Météo — *METAR à l'arrivée*

**aviationweather.gov** (NOAA) : gratuit, sans clé, 100 req/min.

### 06 · Horaires, portes, retards — *les seules APIs à clé*

L'avion ne diffuse pas son horaire : ces infos viennent des compagnies. Trois fournisseurs, chacun activé par sa clé dans `.env` :

| Fournisseur | Gratuit | Données | Variable |
|---|---|---|---|
| **AeroDataBox** (RapidAPI) — le meilleur | ~300 req/mois, **illimité si tu deviens feeder** | prévu / estimé / réel, terminal, porte, tapis, statut, UTC + local | `AERODATABOX_KEY` |
| **AirLabs** | ~1 000 req/mois | idem, moins fiable | `AIRLABS_KEY` |
| **Aviationstack** (apilayer) | 100 req/mois | prévu / estimé / réel, terminal, porte, retard | `AVIATIONSTACK_KEY` |

Ce qui empêche de griller le quota en ligne : **bouton** au lieu d'appel automatique (auto si quota ≥ 1 000/mois ou `SCHEDULE_AUTO=1`) · **compteur** mensuel (−5 %) et journalier (2× la moyenne), persistant · **limite par visiteur** (`SCHEDULE_PER_IP_DAY`, 10/jour) · **cache** partagé et persistant (10 min en vol, 6 h atterri, 30 min « pas trouvé ») · chaîne : le premier fournisseur avec du quota répond.

> Piège Aviationstack : clé apilayer → uniquement `https://api.apilayer.net/aviationstack/v1/…` ; heures renvoyées en local avec un faux suffixe `+00:00`, réinterprétées avec le fuseau de l'aéroport (testé).

### 07 · Trajet réel — *les points GPS effectivement parcourus (gratuit, sans clé)*

adsb.lol publie la trace de chaque avion sur la journée (format readsb/tar1090) : `trace_full` (journée, régénérée par lots) + `trace_recent` (à jour). `lib/trail.js` fusionne, **découpe en vols** (flag « nouveau leg », coupures > 20 min, sol → air), devine les aéroports avec OurAirports. Secours : historique enregistré par ce serveur.

**Historique long** (`lib/archive.js`) : adsb.lol ne garde que 24 h. Les vols des avions que quelqu'un a regardés sont archivés dans SQLite (30 jours) et rafraîchis toutes les 20 min pendant 24 h après le clic — 60 avions max par passage, pour rester correct avec adsb.lol. Chaque vol archivé est **rejouable** (▶).

### 08 · Données ADS-B avancées

Déjà dans les réponses des sources de positions, **0 requête supplémentaire** : IAS / TAS / Mach, altitude GPS, cap vrai et magnétique, inclinaison, vent et température en altitude, altitude et cap réglés sur l'autopilote, QNH, modes, catégorie de masse, type de signal (ADS-B / MLAT / TIS-B), qualité de position, niveau de signal, messages.

---

## ⚖️ Mode commercial

Le jour où ton site rapporte de l'argent (pub, abonnement), la moitié des sources devient interdite.

```bash
COMMERCIAL=1 npm start
```

Ce mode ne garde que **adsb.lol** pour les positions. Dans tous les cas : attribution **adsb.lol (ODbL)**, **OpenStreetMap**, **Planespotters** (photographe) obligatoires — déjà en pied de page et sous les photos.

---

## 🌍 Déployer en ligne (gratuit)

Un seul conteneur = un seul cache partagé, c'est l'idéal. **Évite le serverless** (Vercel/Netlify functions) : chaque requête démarre à froid, perd le cache, le compteur de quota et le flux SSE.

**Render (le plus simple)** — `render.yaml` fourni :
1. Pousse le projet sur GitHub.
2. Render → *New* → *Blueprint* → choisis le dépôt. Le build lance `npm ci && npm run setup-data`.
3. Dans *Environment*, colle `AVIATIONSTACK_KEY` (et les autres si tu en as). Jamais dans le code.
4. Vérifie `https://ton-app.onrender.com/api/health`.

**Fly.io / Railway / VPS** — `Dockerfile` fourni (Node 24, volume `/app/data` pour garder SQLite) :
```bash
docker build -t flightmap .
docker run -p 3000:3000 --env-file .env -v flightmap-data:/app/data flightmap
```

### Supervision (et anti-mise en veille)

Le plan gratuit Render endort le service après 15 min sans visite. Crée un moniteur gratuit sur [UptimeRobot](https://uptimerobot.com) (ou Better Stack, Cronitor) : **HTTP(s)**, URL `https://ton-app.onrender.com/api/ping`, intervalle 5 min. Tu es prévenu par mail si le site tombe, et le service ne s'endort plus. `/api/ping` répond `ok` sans rien calculer ; `/api/health` donne le détail (quota, caches, SSE, store).

À savoir :
- Sur Render gratuit le disque est éphémère : SQLite (caches, archive, quota) repart de zéro **à chaque redéploiement** (pas à chaque réveil). Sur Fly/Railway, monte un volume et pointe `DATA_DIR` dessus.
- Si une clé a circulé (message, capture d'écran, dépôt public), **régénère-la** chez le fournisseur.
- Garde le lien adsb.lol (ODbL) et l'attribution OpenStreetMap en bas de page.

### Devenir feeder — *la seule « amélioration » qui change vraiment ce que tu peux afficher*

Un récepteur ADS-B coûte ~40 € (clé USB RTL-SDR + antenne + Raspberry Pi ou n'importe quel Linux). En alimentant les réseaux :
- **adsb.lol** : tu rends ce que tu consommes, ton IP n'est plus limitée, et tu vois les avions que *ton* antenne capte (souvent mieux que la couverture publique autour de chez toi).
- **AeroDataBox** : accès **illimité gratuit** aux horaires / portes / retards pour les feeders (via [aerodatabox.com](https://aerodatabox.com) → *Free tier for feeders*).
- **adsb.fi, airplanes.live, ADS-B Exchange** : mêmes avantages.

Guide de départ : [adsb.lol → Feed](https://adsb.lol/feed) — un script installe tout en 5 min. Ensuite, dans FlightMap, rien à changer : les sources sont les mêmes, elles répondent juste mieux pour toi.

---

## 🔧 Garde-fous côté serveur

- **Rate-limit par IP et par famille** (`lib/ratelimit.js`) : 240 req/min général, 30 recherches/min, 60 traces/min, **10 consultations d'horaires/jour** (les réponses en cache ne comptent pas). Headers `X-RateLimit-*` et `Retry-After`.
- **SSE** (`lib/stream.js`) : 300 connexions max, 4 par IP, une seule requête amont par zone quel que soit le nombre de visiteurs.
- **Backoff** des sources 429/5xx, **déduplication** des requêtes simultanées, **caches persistants** (`lib/cache.js` + `lib/store.js`).
- **Archivage limité** aux avions consultés (pas le trafic mondial).

---

## ⚠️ Limites à connaître (elles sont normales)

- **Pas de couverture océanique.** L'ADS-B est capté par des récepteurs au sol. Au milieu de l'Atlantique, il n'y a personne.
- **Certains avions n'ont pas de trajet.** L'avion ne diffuse pas sa destination : les APIs la devinent depuis le callsign. La trace réelle donne en revanche l'aéroport de départ constaté — et le signale s'il contredit le référentiel.
- **Horaires, portes : seulement avec une clé** (§ 06), dans la limite du quota gratuit.
- **Historique avant la première visite : inexistant.** L'archive se construit à partir du moment où le serveur tourne et où quelqu'un regarde un avion.
- **Stats = ce que le serveur a vu**, c'est-à-dire les zones que les visiteurs ont regardées, pas le trafic mondial.

---

## 📁 Structure

```
flightmap/
├── server.js              → routes API, rate-limits, SSE, statique
├── lib/
│   ├── providers.js       → positions (zone / hex / recherche), identité, photo, trajet, météo, backoff, historique local
│   ├── trail.js           → trace réelle adsb.lol découpée en vols + aéroports devinés
│   ├── archive.js         → archive des vols (SQLite) + job de rafraîchissement
│   ├── schedule.js        → horaires/portes : AeroDataBox → AirLabs → Aviationstack (à clé)
│   ├── quota.js           → compteur mensuel/journalier des APIs à clé (persistant)
│   ├── store.js           → SQLite (node:sqlite) : cache KV, vols, stats — repli JSON
│   ├── cache.js           → cache TTL (optionnellement persistant) + déduplication
│   ├── stream.js          → flux SSE par zone
│   ├── ratelimit.js       → limites par IP
│   ├── stats.js           → agrégats journaliers
│   ├── refdata.js         → référentiel local (aéroports, aéroport le plus proche, remarquables, immats)
│   ├── limiter.js         → 1 req/s max par API + fetch avec timeout
│   └── csv.js             → lecteur CSV
├── public/
│   ├── index.html · stats.html · style.css · manifest.webmanifest · sw.js · icons/
│   ├── app.js             → point d'entrée (module)
│   └── js/                → state, map, render, data, panel, filters, url, pwa
├── scripts/
│   ├── setup-data.js      → télécharge et convertit le référentiel
│   └── make-icons.js      → icônes PNG (encodeur maison, 0 dépendance)
├── tests/                 → node --test
├── data/                  → généré (référentiel, flightmap.db, quota.json) — non versionné
├── .env.example           → clés d'API (copie en .env, jamais versionné)
└── render.yaml / Dockerfile → déploiement en ligne
```

### Variables d'environnement

| Variable | Défaut | Effet |
|---|---|---|
| `PORT` | `3000` | port du serveur |
| `COMMERCIAL` | `0` | `1` = ne garde que les sources autorisées en commercial |
| `LOCAL_FIRST` | `0` | `1` = la base locale répond avant les APIs |
| `USER_AGENT` | `flightmap/2.0…` | identité envoyée aux APIs (certaines l'exigent) |
| `AERODATABOX_KEY` / `AIRLABS_KEY` / `AVIATIONSTACK_KEY` | — | horaires / portes |
| `*_QUOTA` | `300` / `1000` / `100` | quota mensuel de chaque fournisseur si ton plan diffère |
| `SCHEDULE_AUTO` | `0` | `1` = horaires chargés dès le clic (sinon bouton) |
| `SCHEDULE_PER_IP_DAY` | `10` | consultations d'horaires par visiteur et par jour |
| `DATA_DIR` | `./data` | dossier de SQLite et du quota (volume en prod) |
| `CONTACT` | — | e-mail ou URL de contact : active les photos Planespotters (2× plus grandes) |
| `TELEGRAM_BOT_TOKEN` | — | alertes Telegram (bot créé via @BotFather) |
| `RESEND_API_KEY` / `BREVO_API_KEY` | — | alertes e-mail (l'un ou l'autre) |
| `MAIL_FROM` | `FlightMap <onboarding@resend.dev>` | expéditeur des e-mails |
| `PUBLIC_URL` | — | URL publique, pour les liens dans les alertes |

### Nouvelles routes (v4)

```
GET /api/airports?south&west&north&east[&min=large]   aéroports à dessiner
GET /api/airport/:code                                 tableau départs / arrivées / sol / pistes / METAR
GET /api/trail/:hex?callsign=                          (callsign étiquette le vol, détecte le déroutement)
GET /api/trail/:hex/export.(gpx|kml|csv)?leg=i|archived=ISO
GET /api/local-trails?hexes=a,b,c                      orbites (historique local)
GET /api/history/:hex?days=30                          vols archivés
GET /api/registry/aircraft/:reg|hex · /api/registry/flight/:number
GET /api/events                                        remises de gaz, attentes… (24 h)
GET /api/replay?day=YYYY-MM-DD                         tous les vols archivés d'un jour
POST /api/me/new · GET /api/me · PUT /api/me/{favorites,rules,channels} · GET /api/me/inbox · POST /api/me/test
```

### Fichiers ajoutés (v4)

```
lib/airport.js      tableau d'aéroport, piste en service
lib/events.js       détection d'événements + flux récent
lib/registry.js     prédiction, fiches avion / vol
lib/export.js       GPX / KML / CSV
lib/accounts.js     comptes légers, règles, Telegram / e-mail
public/js/i18n.js · airports.js · mezone.js · account.js · military.js · a11y.js · tour.js
public/aircraft.html · flight.html · replay.html · embed.html
tests/features.test.js
```

Les variables sont lues depuis `.env` en local (fichier ignoré par git) ou depuis le dashboard de l'hébergeur en ligne.

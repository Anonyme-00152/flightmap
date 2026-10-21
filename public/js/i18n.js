/**
 * Internationalisation FR / EN.
 * La clé est la phrase française ; `t(fr)` renvoie la traduction si la langue
 * est l'anglais et qu'elle existe, sinon la phrase française telle quelle.
 * Le HTML statique est traduit via data-i18n / data-i18n-ph / data-i18n-title.
 */
const EN = {
  // barre
  'Callsign, immat. ou hex — monde entier (ex : AFR123, F-GKXM)': 'Callsign, registration or hex — worldwide (e.g. AFR123, F-GKXM)',
  'Filtres': 'Filters', 'Filtres et alertes': 'Filters & alerts', 'Statistiques': 'Statistics', 'Mode clair': 'Light mode', 'Mode sombre': 'Dark mode',
  'Plein écran': 'Fullscreen', 'Installer': 'Install', 'avions': 'aircraft', 'connexion…': 'connecting…', 'Ma zone': 'My area', 'Mon compte': 'My account',
  'Mes favoris et alertes': 'My favourites & alerts', 'Langue': 'Language',
  // filtres
  'Afficher seulement': 'Show only', 'Militaires': 'Military', 'Urgences (7500 / 7600 / 7700)': 'Emergencies (7500 / 7600 / 7700)',
  'Appareils remarquables': 'Notable aircraft', 'Masquer les avions au sol': 'Hide aircraft on ground', 'Altitude': 'Altitude',
  'Compagnie (code ICAO, ex : AFR)': 'Airline (ICAO code, e.g. AFR)', "Type d'appareil (ex : A320, B77W)": 'Aircraft type (e.g. A320, B77W)',
  'Texte libre (callsign, immat., modèle)': 'Free text (callsign, registration, model)', 'Alertes (notification)': 'Alerts (notification)',
  'Urgence dans la zone': 'Emergency in view', 'Appareil remarquable dans la zone': 'Notable aircraft in view', 'Militaire dans la zone': 'Military in view',
  'Réinitialiser les filtres': 'Reset filters', 'Vue militaire / OSINT': 'Military / OSINT view', 'Tous militaires': 'All military',
  'Ravitailleurs': 'Tankers', 'Surveillance / AWACS': 'Surveillance / AWACS', 'Chasseurs': 'Fighters', 'Transport militaire': 'Military transport',
  'Hélicoptères': 'Helicopters', 'Gouvernemental / VIP': 'Government / VIP', 'Drones': 'Drones', 'Dessiner les orbites': 'Draw orbits',
  // panneau
  'Suivre': 'Follow', 'Suivi': 'Following', 'Partager': 'Share', 'Favori': 'Favourite', 'Favori ✓': 'Favourite ✓',
  'Trajet inconnu — vol privé, militaire ou callsign non commercial.': 'Route unknown — private, military or non-commercial callsign.',
  'Vitesse sol': 'Ground speed', 'Cap': 'Track', 'Vario': 'V/S', 'Horaires & portes': 'Times & gates', 'Départ': 'Departure', 'Arrivée': 'Arrival',
  'Prévu': 'Scheduled', 'Estimé': 'Estimated', 'Réel': 'Actual', 'Heures locales de chaque aéroport.': 'Local time at each airport.',
  'Charger les horaires et portes': 'Load times & gates', 'Chargement…': 'Loading…', 'Réessayer': 'Retry',
  'Décollage': 'Take-off', 'En vol depuis': 'Airborne for', 'Distance restante': 'Remaining distance', 'Arrivée estimée': 'Estimated arrival',
  'Durée habituelle': 'Usual duration', 'Arrivée probable': 'Likely arrival', 'Trajet réel': 'Actual track', 'Décollage réel': 'Actual take-off',
  'Depuis': 'From', 'Phase': 'Phase', 'Durée de vol': 'Flight time', 'Distance parcourue': 'Distance flown', 'Altitude max': 'Max altitude',
  'Vitesse sol max': 'Max ground speed', 'Rejouer': 'Replay', 'Arrêter': 'Stop', 'Événements': 'Events', 'Exporter': 'Export',
  "Vols de cet appareil aujourd'hui · clique pour voir la trace": "This aircraft's flights today · click to show the track",
  'Historique (30 jours, archivé par ce serveur)': 'History (30 days, archived by this server)', 'Données ADS-B': 'ADS-B data',
  'Météo à l\'arrivée': 'Weather at destination', 'Appareil': 'Aircraft', 'Modèle': 'Model', 'Immatriculation': 'Registration', 'Exploitant': 'Operator',
  'Code ICAO (hex)': 'ICAO code (hex)', 'Au sol': 'On ground', 'Montée initiale': 'Initial climb', 'Montée': 'Climb', 'Approche': 'Approach',
  'Descente': 'Descent', 'Croisière': 'Cruise', 'Palier': 'Level', 'non observé': 'not observed', 'en cours': 'in progress', 'hier': 'yesterday',
  'Fermer': 'Close', 'Signal perdu — plus de position reçue depuis 90 s.': 'Signal lost — no position received for 90 s.',
  'Chargement des détails…': 'Loading details…', 'Détails indisponibles.': 'Details unavailable.',
  'Remise de gaz': 'Go-around', 'Attente en hippodrome': 'Holding pattern', 'Retour au départ': 'Return to departure', 'Déroutement': 'Diversion', 'Urgence': 'Emergency',
  // aéroport
  'Départs': 'Departures', 'Arrivées': 'Arrivals', 'Piste en service': 'Runway in use', 'observée': 'observed', 'probable (vent)': 'likely (wind)',
  'Aucun mouvement détecté pour le moment.': 'No movement detected yet.', 'dans': 'in', 'il y a': 'ago', 'Pistes': 'Runways', 'vent': 'wind',
  'Statistiques': 'Statistics', '7 derniers jours': 'Last 7 days', 'mouvements': 'movements', 'décollages': 'takeoffs', 'atterrissages': 'landings',
  'Mouvements par jour': 'Movements per day', 'Mouvements par heure (heure locale)': 'Movements per hour (local time)', 'Usage des pistes': 'Runway usage',
  'Routes les plus fréquentes': 'Busiest routes', 'Derniers événements': 'Latest events', "Fiche de l'aéroport": 'Airport facts', 'Vue satellite': 'Satellite view',
  'heure locale': 'local time', 'alt.': 'elev.', 'Nom': 'Name', 'Ville, pays': 'City, country', 'Fuseau horaire': 'Timezone', 'Lever du soleil': 'Sunrise',
  'Coucher du soleil': 'Sunset', 'soleil de minuit': 'midnight sun', 'nuit polaire': 'polar night', 'Taille': 'Size', 'grand aéroport': 'large airport',
  'aéroport moyen': 'medium airport', 'petit aéroport': 'small airport', 'Vols réguliers': 'Scheduled service', 'oui': 'yes', 'non': 'no', 'Site officiel': 'Official site',
  'Widget': 'Widget', 'Liens': 'Links', 'lire la suite': 'read more', 'Orage': 'Thunderstorm', 'Pluie': 'Rain', 'Neige': 'Snow', 'Brouillard / brume': 'Fog / mist',
  'Ciel dégagé': 'Clear', 'Couvert': 'Overcast', 'Nuageux': 'Cloudy', 'Peu nuageux': 'Few clouds', 'Pas encore de données.': 'No data yet.', 'Piste': 'Runway',
  'Aucune piste identifiée pour l\'instant.': 'No runway identified yet.', 'Trajets pas encore connus.': 'Routes not known yet.', 'aéroports': 'airports', 'pays': 'countries',
  'Décollages': 'Takeoffs', 'en bleu': 'in blue', 'en vert': 'in green', 'Observé par ce serveur depuis': 'Observed by this server since',
  'cet aéroport est surveillé automatiquement pendant 24 h après chaque consultation.': 'this airport is watched automatically for 24 h after each visit.',
  'Aucun mouvement enregistré encore : ce serveur commence à surveiller cet aéroport maintenant (24 h après chaque consultation). Reviens dans quelques heures.': 'No movement recorded yet: this server starts watching this airport now (24 h after each visit). Come back in a few hours.',
  // ma zone
  'Au-dessus de moi': 'Above me', 'Prochains passages': 'Next passes', 'azimut': 'bearing', 'élévation': 'elevation', 'Localisation refusée.': 'Location denied.',
  'Rien à moins de 30 km pour l\'instant.': 'Nothing within 30 km for now.', 'passe à': 'passes at',
  // compte
  'Favoris': 'Favourites', 'Règles d\'alerte': 'Alert rules', 'Canaux': 'Channels', 'Boîte de réception': 'Inbox', 'Ajouter': 'Add', 'Supprimer': 'Remove',
  'Tester': 'Test', 'Jeton de compte (garde-le : sans lui, pas de récupération)': 'Account token (keep it: no recovery without it)',
  'Avion (immat. ou hex) en vol': 'Aircraft (reg. or hex) airborne', 'Vol (callsign) en vol': 'Flight (callsign) airborne', 'Type en approche d\'un aéroport': 'Type approaching an airport',
  'Aucun favori. Ouvre un avion et clique ★.': 'No favourites yet. Open an aircraft and click ★.', 'Aucune règle.': 'No rules.', 'Rien pour le moment.': 'Nothing yet.',
  // divers
  'Lien copié dans le presse-papiers.': 'Link copied to clipboard.', 'Nouvelle version disponible — recharge la page.': 'New version available — reload the page.',
  'Suivant': 'Next', 'Passer': 'Skip', 'Terminer': 'Done',
  'Clique sur un avion': 'Click an aircraft',
  'Chaque avion est cliquable : modèle, photo, trajet, trace réelle, données ADS-B. Les couleurs indiquent l\'altitude.': 'Every aircraft is clickable: model, photo, route, actual track, ADS-B data. Colours show altitude.',
  'Cherche n\'importe quel vol': 'Search any flight',
  'Callsign, immatriculation ou hex — dans la zone affichée, puis dans le monde entier.': 'Callsign, registration or hex — in the current view, then worldwide.',
  'Filtre et reçois des alertes': 'Filter and get alerts',
  'Militaires, urgences, compagnie, type, altitude… et une notification quand quelque chose apparaît dans ta zone.': 'Military, emergencies, airline, type, altitude… and a notification when something shows up in your area.',
  'Horaires, favoris, alertes': 'Times, favourites, alerts',
  'Dans la fiche d\'un vol : « Charger les horaires et portes ». Avec ★ tu gardes tes favoris et tu crées des alertes par Telegram ou e-mail.': 'In a flight\'s panel: “Load times & gates”. With ★ you keep favourites and create Telegram or e-mail alerts.',
};

const KEY = 'flightmap:lang';
let lang = 'fr';
try {
  const q = new URLSearchParams(location.search).get('lang');
  lang = q || localStorage.getItem(KEY) || (navigator.language || 'fr').slice(0, 2);
} catch { /* ignore */ }
if (lang !== 'en') lang = 'fr';

export const getLang = () => lang;

export function t(fr) {
  if (lang === 'en') return EN[fr] ?? fr;
  return fr;
}

export function setLang(next) {
  lang = next === 'en' ? 'en' : 'fr';
  try { localStorage.setItem(KEY, lang); } catch { /* ignore */ }
  document.documentElement.lang = lang;
  applyI18n(document);
}

/** Traduit le HTML statique : data-i18n (texte), data-i18n-ph (placeholder), data-i18n-title (title). */
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
}

export function initI18n() {
  document.documentElement.lang = lang;
  applyI18n(document);
  const btn = document.getElementById('lang-btn');
  if (btn) {
    const sync = () => { btn.textContent = lang === 'fr' ? 'EN' : 'FR'; btn.title = t('Langue'); };
    btn.addEventListener('click', () => { setLang(lang === 'fr' ? 'en' : 'fr'); sync(); });
    sync();
  }
}

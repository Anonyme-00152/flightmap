#!/usr/bin/env bash
# FlightMap — build.sh (Linux / macOS) : même chose que build.bat.
#   ./build.sh            installe, télécharge le référentiel, génère les icônes, crée .env, lance les tests
#   ./build.sh --force    refait tout
#   ./build.sh --no-test
# Ensuite :  npm start   (ou PORT=8080 npm start)
set -e
cd "$(dirname "$0")"
FORCE=0; NOTEST=0
for a in "$@"; do [ "$a" = "--force" ] && FORCE=1; [ "$a" = "--no-test" ] && NOTEST=1; done

echo; echo " FlightMap — installation"; echo
command -v node >/dev/null || { echo "[ERREUR] Node.js introuvable : https://nodejs.org (LTS)"; exit 1; }
NODEVER=$(node -v | sed 's/^v//'); MAJ=${NODEVER%%.*}; MIN=$(echo "$NODEVER" | cut -d. -f2)
echo " Node.js v$NODEVER"
if [ "$MAJ" -lt 22 ] || { [ "$MAJ" -eq 22 ] && [ "$MIN" -lt 13 ]; }; then echo "[ERREUR] Node.js ≥ 22.13 requis (SQLite intégré)"; exit 1; fi

if [ $FORCE = 1 ] || [ ! -f node_modules/express/package.json ]; then echo " Dépendances…"; npm install --no-audit --no-fund; else echo " Dépendances : déjà installées"; fi
if [ $FORCE = 1 ] || [ ! -f data/airports.json ] || [ ! -f data/runways.json ]; then echo " Référentiel…"; npm run setup-data || echo "[ATTENTION] référentiel non téléchargé (réseau ?) — relance plus tard"; else echo " Référentiel : déjà présent"; fi
if [ $FORCE = 1 ] || [ ! -f public/icons/icon-512.png ]; then echo " Icônes…"; npm run icons; else echo " Icônes : déjà générées"; fi
if [ -f .env ]; then echo " Configuration : .env présent"; else cp .env.example .env; echo " Configuration : .env créé depuis .env.example"; fi
if [ $NOTEST = 0 ]; then echo; npm test && echo " Tests : OK" || echo "[ATTENTION] des tests ont échoué"; fi
echo; echo " Terminé. Lance :  npm start   puis ouvre http://localhost:3000"; echo

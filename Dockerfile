# Pour Fly.io, Railway, un VPS… : docker build -t flightmap . && docker run -p 3000:3000 --env-file .env flightmap
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
# Référentiel (aéroports, appareils remarquables) embarqué dans l'image : 0 appel au démarrage
RUN npm run setup-data

# SQLite (cache, archive des vols, stats) : monte un volume sur /app/data pour le garder entre deux déploiements
VOLUME ["/app/data"]

EXPOSE 3000
CMD ["node", "server.js"]

# Fleetwake: one image serving the landing page, the dashboard, the API and Socket.IO.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
COPY simulator/package.json simulator/
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=4000
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
COPY simulator/package.json simulator/
RUN npm ci --omit=dev && npm cache clean --force
COPY server server
COPY shared shared
COPY simulator simulator
COPY landing landing
COPY --from=build /app/client/dist client/dist
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:4000/api/health || exit 1
CMD ["node", "server/src/index.js"]

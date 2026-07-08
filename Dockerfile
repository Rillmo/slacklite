FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/data/data.db \
    SECRET_PATH=/data/.jwt-secret

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server/index.js"]

FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY src ./src

ENV NODE_ENV=production
ENV PORT=4317
ENV SQLITE_PATH=/data/app.sqlite

VOLUME ["/data"]
EXPOSE 4317

CMD ["node", "src/server.js"]

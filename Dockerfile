FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build


FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY migrations ./migrations

USER node

CMD ["npm", "run", "start:api"]
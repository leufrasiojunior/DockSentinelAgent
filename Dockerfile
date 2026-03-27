ARG APP_VERSION=dev

FROM node:20-alpine AS build
WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src src

RUN npm run build

FROM node:20-alpine AS prod-deps
WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:20-alpine AS runtime
ARG APP_VERSION=dev
WORKDIR /app

RUN apk add --no-cache ca-certificates tzdata
RUN mkdir -p /var/lib/docksentinel-agent

ENV NODE_ENV=production \
  APP_VERSION=${APP_VERSION} \
  PORT=45873 \
  TZ=UTC

COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist
COPY --from=build /app/package.json /app/package.json

LABEL com.docksentinel.role="agent"

EXPOSE 45873

CMD ["node", "dist/main.js"]

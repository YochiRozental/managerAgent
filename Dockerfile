FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
# patches/ must exist before `npm ci` runs: patch-package applies via the postinstall hook
# during that exact step, not afterwards — the libsignal session-key-logging fix
# (patches/libsignal+6.0.0.patch) would silently not apply if this came after `npm ci`.
COPY patches ./patches
RUN npm ci

COPY . .

CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/index.ts"]

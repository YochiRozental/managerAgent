FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/index.ts"]

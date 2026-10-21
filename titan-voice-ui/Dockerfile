FROM node:22.23.4-slim

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

ENV NODE_ENV=development
ENV HOSTNAME=0.0.0.0

EXPOSE 3000

CMD ["pnpm", "dev"]

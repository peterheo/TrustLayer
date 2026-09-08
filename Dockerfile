# TrustLayer — one service, one process, no state.
#
# The verifier holds three capabilities and writes nothing to disk, so this
# image needs no volumes, no database and no privileged runtime.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY src ./src

# The deployment edge terminates TLS and applies rate limits; the service does
# neither, exactly as the SharedOS HTTP docs prescribe.
ENV PORT=8080
EXPOSE 8080

# Unprivileged: nothing here needs root.
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "start"]

# Cashmere OS, built for a server rather than a laptop.
#
# Three stages, so the thing that actually runs carries none of the tooling
# that built it: no compiler, no dev dependencies, no source. What ships is
# Next's standalone output, the Prisma client, and node.
#
# The build needs a DATABASE_URL because `prisma generate` reads the schema's
# datasource — but it never connects, so the placeholder below is enough and
# no real credential is ever baked into an image layer.

# ─────────────────────────────── dependencies ────────────────────────────────
FROM node:24-alpine AS deps
WORKDIR /app

# prisma.config.ts reads `env("DATABASE_URL")` at the moment it loads, and it
# throws when that is unset rather than deferring until something connects. It
# loads here because `npm ci` runs `prisma generate` on postinstall. Nothing in
# this stage opens a connection, so a placeholder satisfies it; it is set per
# stage rather than globally, so no image layer ever carries a real credential.
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"

# The manifests, so this layer is rebuilt when dependencies change rather than
# every time a line of source does — and the schema with them, because
# `postinstall` runs `prisma generate` and that reads it. Without the schema
# `npm ci` fails on its own postinstall, which reports as a bare exit code 1
# and names nothing.
#
# The schema changes far less often than the source, so the cache still holds
# across ordinary work.
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma

# Retries, because a build that dies on one dropped connection is a build that
# fails at random and tells whoever is watching that their code is broken.
RUN npm config set fetch-retries 5 \
 && npm config set fetch-retry-maxtimeout 120000 \
 && npm config set fetch-timeout 600000 \
 && npm ci --no-audit --no-fund

# ──────────────────────────────────  build  ──────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
# Trace the server's real dependencies instead of shipping node_modules whole.
ENV NEXT_STANDALONE=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The client has to exist before the build: every server component imports it,
# and a missing client fails as a type error rather than as something legible.
RUN npx prisma generate

# Standalone output: Next traces exactly which files the server needs and
# copies them, so the runtime image does not carry node_modules whole.
RUN npm run build

# This project keeps no public/ — fonts come through next/font and garment
# photographs live on a mounted volume, not in the image. Create it empty so
# the runtime stage can copy it unconditionally: without this the COPY fails
# on a missing path, and with it a public/ added later is picked up with no
# change here.
RUN mkdir -p /app/public

# ───────────────────────────────── runtime ───────────────────────────────────
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Where garment photographs live. A named volume mounts here, so images
# survive every deploy — a rebuilt container must not lose them.
ENV UPLOAD_DIR=/app/data/uploads

# Postgres client tools, so the backup script can dump and restore from inside
# the stack rather than depending on what happens to be on the host.
RUN apk add --no-cache postgresql17-client tzdata \
 && addgroup -g 1001 -S nodejs \
 && adduser -u 1001 -S nextjs -G nodejs

# Cairo time, so timestamps in the audit trail read the way the shop does.
ENV TZ=Africa/Cairo

COPY --from=build /app/.next-build/standalone ./
COPY --from=build /app/.next-build/static ./.next-build/static
COPY --from=build /app/public ./public

# Prisma's schema and migrations, so the container can apply them on start.
#
# Not node_modules/.bin/prisma: that is a symlink, and COPY follows symlinks
# and writes the target's contents as a plain file. The CLI then requires
# './cli.js' relative to .bin/ instead of build/, and the container crash-loops
# on a module that exists three directories away. The entrypoint calls
# build/index.js directly, which is what the symlink pointed at anyway.
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/prisma ./node_modules/prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/src/generated ./src/generated

# The datasource block in schema.prisma carries no url — it comes from
# prisma.config.ts, so `migrate deploy` cannot find the database without it.
# dotenv comes too, because the config imports it before anything else runs.
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY --from=build /app/node_modules/dotenv ./node_modules/dotenv

RUN mkdir -p /app/data/uploads && chown -R nextjs:nodejs /app/data

USER nextjs
EXPOSE 3000

# Standalone writes its own server. It is started directly rather than through
# next-production.mjs, which exists to keep dev and build output apart — a
# problem that cannot arise in a container that only ever runs one of them.
CMD ["node", "server.js"]

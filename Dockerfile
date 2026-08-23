# ── Stage 1: Base ──
# Digest-pinned for reproducibility, which also means it goes stale silently:
# a pinned base keeps shipping whatever CVEs it had on the day it was pinned.
# Refresh this pin (both occurrences) whenever the Trivy gate in
# .github/workflows/docker-publish.yml reports fixable findings in OS packages;
# `ignore-unfixed: true` means everything it reports has a fix available
# upstream, and for base-layer CVEs that fix is a newer base image.
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS base
RUN apk add --no-cache libc6-compat

# ── Stage 2: Dependencies ──
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── Stage 3: Builder ──
FROM base AS builder
WORKDIR /app

ARG EXTENSIONS_PRESET=hosted

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Apply extension preset (must happen before build — prebuild hook
# runs setup:extensions which reads extensions.config.json)
COPY docker/extensions.${EXTENSIONS_PRESET}.json ./extensions.config.json

# Build with placeholder sentinel values for NEXT_PUBLIC_* vars.
# These get replaced at runtime by docker-entrypoint.sh so the image
# is generic and reusable across different Supabase projects.
ENV NEXT_PUBLIC_SUPABASE_URL=__NEXT_PUBLIC_SUPABASE_URL__
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=__NEXT_PUBLIC_SUPABASE_ANON_KEY__
ENV NEXT_PUBLIC_APP_URL=__NEXT_PUBLIC_APP_URL__
ENV NEXT_PUBLIC_VAPID_PUBLIC_KEY=__NEXT_PUBLIC_VAPID_PUBLIC_KEY__
ENV NEXT_PUBLIC_SELF_HOSTED=__NEXT_PUBLIC_SELF_HOSTED__
ENV NEXT_PUBLIC_REQUIRE_MFA=__NEXT_PUBLIC_REQUIRE_MFA__
# Keep the branding placeholder intact through prebuild's inject script so
# docker-entrypoint.sh can substitute the runtime value into public/sw.js.
ENV NEXT_PUBLIC_BRANDING_APP_NAME=__NEXT_PUBLIC_BRANDING_APP_NAME__

ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ── Stage 4: Runner ──
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runner
WORKDIR /app

# su-exec drops privileges in the entrypoint after the placeholder-substitution
# step. Healthcheck uses BusyBox wget (already present in alpine), so no curl.
RUN apk add --no-cache su-exec

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# /app at runtime is split across the read-only image layer and tmpfs mounts:
#   /app/server.js, /app/node_modules/, /app/package.json   — image (read-only)
#   /app/.next/                                              — tmpfs (writable)
#   /app/public/                                             — tmpfs (writable)
# The entrypoint copies templates from /opt/nordklart-template/ into the tmpfs
# mounts at startup, runs placeholder substitution, then chmods read-only.
# This lets us run with docker-compose `read_only: true`.

COPY --from=builder /app/.next/standalone/server.js ./server.js
COPY --from=builder /app/.next/standalone/node_modules ./node_modules
COPY --from=builder /app/.next/standalone/package.json ./package.json

# Baked-in templates for runtime population of tmpfs mounts.
COPY --from=builder /app/.next/standalone/.next /opt/nordklart-template/.next
COPY --from=builder /app/.next/static /opt/nordklart-template/.next/static
COPY --from=builder /app/public /opt/nordklart-template/public

# Pre-create mount points so tmpfs has somewhere to attach when running with
# docker-compose's read_only:true. The directories are empty in the image
# layer — content is copied in by the entrypoint.
RUN mkdir -p /app/.next /app/.next/cache /app/public

COPY --chmod=755 docker-entrypoint.sh ./docker-entrypoint.sh

# No USER directive — entrypoint handles the privilege drop with su-exec
# after the root-only setup steps complete.

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]

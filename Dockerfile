# Stage 1
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev

# Stage 2
FROM node:22-slim AS runtime
ENV NODE_ENV=production
ENV TT_DATA_DIR=/var/lib/time-turtle
ENV PORT=3001
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/server server
COPY --from=build /app/shared shared
COPY --from=build /app/client/dist client/dist
RUN mkdir -p /var/lib/time-turtle && chown node:node /var/lib/time-turtle
USER node
EXPOSE 3001
CMD ["node", "server/src/index.js"]


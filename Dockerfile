FROM --platform=$BUILDPLATFORM node:22-alpine AS test
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run check && npm test

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=test /app/src ./src
COPY --from=test /app/public ./public
COPY --from=test /app/covenant ./covenant
COPY --from=test /app/vendor ./vendor
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]

FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV AI_ZERO_TOKEN_HOME=/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY dist ./dist
COPY admin-ui/dist ./admin-ui/dist

EXPOSE 8787

CMD ["node", "dist/cli.js", "serve", "--host", "0.0.0.0", "--port", "8787"]

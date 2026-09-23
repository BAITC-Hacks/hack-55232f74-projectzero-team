FROM node:24-alpine AS development
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY app ./
EXPOSE 8080
CMD ["npm", "run", "dev"]

FROM development AS build
RUN npm run build

FROM nginx:1.28-alpine AS runtime
COPY app/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080

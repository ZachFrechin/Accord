FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY packages ./packages
COPY apps/gateway ./apps/gateway
RUN npm install
RUN npm run build -w @discord2/shared
RUN npm run build -w @discord2/config
RUN npm run build -w @discord2/db
RUN npm run build -w @discord2/gateway

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
EXPOSE 4001
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/gateway ./apps/gateway
CMD ["npm", "run", "start", "-w", "@discord2/gateway"]

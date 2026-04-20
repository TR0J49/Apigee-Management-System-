FROM node:18-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Build-time env vars (baked into the JS bundle)
ENV GENERATE_SOURCEMAP=false
ENV PUBLIC_URL=/apigee
ENV REACT_APP_API_BASE=

RUN npm run build

FROM nginx:alpine

# Copy build output into /apigee sub-path to match PUBLIC_URL
COPY --from=build /app/build /usr/share/nginx/html/apigee
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]

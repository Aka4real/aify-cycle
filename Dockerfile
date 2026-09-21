FROM node:22-alpine

WORKDIR /app

# Copy application files
COPY . .

# Standardize default port to 3000 (standard for Coolify, OpenShip, Render, VPS)
ENV PORT=3000
EXPOSE 3000 4180 80

CMD ["node", "server.js"]

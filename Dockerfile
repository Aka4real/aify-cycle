FROM node:22-alpine

WORKDIR /app

# Copy application files
COPY . .

# Expose port 4180
ENV PORT=4180
EXPOSE 4180

CMD ["node", "server.js"]

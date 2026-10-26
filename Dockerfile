FROM node:22-alpine
WORKDIR /app
COPY . .
RUN npm install
CMD ["node", "index.js"]
EXPOSE 3000
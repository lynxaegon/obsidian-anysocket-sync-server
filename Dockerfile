FROM node:19-alpine
WORKDIR /app
COPY . .
RUN npm install
CMD ["node", "index.js"]
EXPOSE 3000
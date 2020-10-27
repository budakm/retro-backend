FROM node:alpine as build

WORKDIR /app
COPY package*.json ./
RUN npm install

EXPOSE 46991 46992
COPY . .

CMD [ "npm", "run", "dev" ]


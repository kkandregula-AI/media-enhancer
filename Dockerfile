FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y ffmpeg
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
CMD ["npm","start"]

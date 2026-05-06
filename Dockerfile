FROM eclipse-temurin:17-jre

WORKDIR /app

# Install Node.js
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs

# Download Lavalink
ADD https://github.com/lavalink-devs/Lavalink/releases/download/4.0.5/Lavalink.jar Lavalink.jar

# Copy bot files
COPY index.js index.js
COPY package.json package.json
COPY application.yml application.yml
COPY plugins/ plugins/

# Install bot dependencies
RUN npm install

# Start script
COPY start.sh start.sh
RUN chmod +x start.sh

CMD ["./start.sh"]

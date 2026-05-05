FROM eclipse-temurin:17-jre

WORKDIR /app

ADD https://github.com/lavalink-devs/Lavalink/releases/download/4.0.5/Lavalink.jar Lavalink.jar

COPY application.yml application.yml

CMD ["java", "-jar", "Lavalink.jar"]

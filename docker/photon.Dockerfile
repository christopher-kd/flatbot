FROM eclipse-temurin:21-jre

RUN apt-get update \
	&& apt-get install -y --no-install-recommends curl zstd gawk \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /photon

RUN curl -fL -o photon.jar https://github.com/komoot/photon/releases/download/1.2.1/photon-1.2.1.jar

COPY docker/photon-entrypoint.sh /photon-entrypoint.sh
RUN chmod +x /photon-entrypoint.sh

EXPOSE 2322
ENTRYPOINT ["/photon-entrypoint.sh"]

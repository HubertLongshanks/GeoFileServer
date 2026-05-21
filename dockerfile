FROM ghcr.io/osgeo/gdal:alpine-normal-3.12.2 AS gdal
RUN apk add nodejs 
RUN apk add --update npm
COPY /dist/ /server/
COPY ./dockerEntry.sh /
RUN chmod +x dockerEntry.sh
RUN mkdir /tmpfiles/
RUN mkdir /files
ENV TRANSFORM_FILES_PATH="/tmpfiles"
ENV TRANSFORM_SOURCE_FILES_PATH="/files"
ENV TRANSFORM_SERVER_TIMEOUT=360
EXPOSE 8080/tcp
EXPOSE 8080/udp
EXPOSE 3000/tcp
EXPOSE 3000/udp
ENTRYPOINT ["/dockerEntry.sh"]
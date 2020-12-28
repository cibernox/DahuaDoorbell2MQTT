FROM node:14
LABEL maintainer="Miguel Camba <miguel.camba@gmail.com>"

WORKDIR /app

COPY *.js ./
COPY package*.json ./

RUN npm install

ENV DAHUA_VTO_HOST=vto-host
ENV DAHUA_VTO_USERNAME=Username
ENV DAHUA_VTO_PASSWORD=Password
ENV MQTT_BROKER_HOST=mqtt-host
ENV MQTT_BROKER_PORT=1883
ENV MQTT_BROKER_USERNAME=Username
ENV MQTT_BROKER_PASSWORD=Password
ENV MQTT_BROKER_TOPIC_PREFIX=DahuaVTO

CMD node /app/DahuaVTO.js
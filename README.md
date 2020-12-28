# DahuaDoorbell2MQTT
Listens to events from Dahua VTO unit and publishes them via MQTT Message

[MQTT Events](./MQTTEvents.MD)

[Supported Models](./SupportedModels.md)

## Environment Variables
```
DAHUA_VTO_HOST: 			    Dahua VTO hostname or IP
DAHUA_VTO_USERNAME: 		  Dahua VTO username to access (should be admin)
DAHUA_VTO_PASSWORD: 		  Dahua VTO administrator password (same as accessing web management)
MQTT_BROKER_HOST: 			  MQTT Broker hostname or IP
MQTT_BROKER_PORT: 			  MQTT Broker port, default=1883
MQTT_BROKER_USERNAME: 		MQTT Broker username
MQTT_BROKER_PASSWORD: 		MQTT Broker password
MQTT_BROKER_TOPIC_PREFIX: MQTT Broker topic prefix, default=DahuaVTO
```

## Run manually
Requirements:
* All environment variables above
* Node.js

```
node DahuaVTO.js
```

## Changelog

* 2020-12-28: Initial version with Node.js


## Credits
All credits goes to <a href="https://github.com/riogrande75">@riogrande75</a> who wrote that complicated integration and <a href="https://github.com/eladbar">@elad-bar</a> who wrote the integration with MQTT in PHP.

Original code can be found in <a href="https://github.com/riogrande75/Dahua">@riogrande75/Dahua<a> and <a href="https://github.com/elad-bar/DahuaVTO2MQTT">@elad-bar/DahuaVTO2MQTT</a>.

This is basically a port to Node.js properly annotated with comments so it's easier for any contributor to help.

I might port it to Rust next for max performance (and fun).

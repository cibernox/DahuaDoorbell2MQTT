const DigestFetch = require('digest-fetch');
const net = require('net');
const fs = require('fs');
const path = require('path');
const md5 = require('md5');
const mqtt = require('mqtt');

/**
 * Class to abstract a dahua doorbell.
 *
 * On instantiation it automatically connects with the doorbell, logs in and
 * subscribes to all events.
 *
 * When an event is received, it forwards it to the MQTT broker so other systems
 * can received those events. This behavior is very generic, users need to listen
 * to those MQTT messages and create their own integrations using something like
 * node-red for instance.
 *
 * In time this could be used to create a more user-friendly integration in home assistant,
 * but a doorbell is a complicated device and I don't know enough yet to decide how such
 * integration would look.
 */

class DahuaVTO {
  deviceType;
  serialNumber;

  /**
   * {Number} requestId
   *
   * Our Request / Response ID that must be in all requests and initated by us.
   * This number auto-increments every time we send a message. Once we've logged in, every
   * response contains the request id of which it's a response of, se it could be used to
   * match responses with requests.
   *
   * I haven't bothered to do so because ,for what I saw, we only care about response order
   * for the initial setup, and we do that on request at a time.
   *
   * If we ever make requests in parallel and we need to associate response to each request,
   * we could use this. For not, it's just an auto-incremental number.
   * */

  requestId = 0;

  // Session ID will be returned after successful login
  /**
   * {Number} sessionId
   *
   * When we try to log in on the doorbell we get a sessionId. From that point on every message
   * we send over the socket needs to have include the sessionID for the doorbell to recognize us.
   */
  sessionId = 0;

  // Will be set after the login, but we initialize to 60s because it's a reasonable default
  /**
   * {Number} keepAliveInterval
   *
   * The number of seconds we have to space our keepAlive messages so the doorbell doesn't close
   * the connection.
   */
  keepAliveInterval = 60;

  /**
   * The ID returned by the `setInterval` call.
   * We keep a reference in case we want to cancel it (maybe in case of failure?)
   */
  _keepAliveTimer;

  /**
   * TCP socket to communicate with the doorbell external unit.
   */
  doorbellSocket;

  /**
   * MQTT client to publish (and maybe receive) messages.
   */
  mqttClient;

  constructor() {
    this.dahua_host = process.env.DAHUA_VTO_HOST;
    this.dahua_username = process.env.DAHUA_VTO_USERNAME;
    this.dahua_password = process.env.DAHUA_VTO_PASSWORD;
    this.mqtt_broker_host = process.env.MQTT_BROKER_HOST;
    this.mqtt_broker_port = process.env.MQTT_BROKER_PORT;
    this.mqtt_broker_username = process.env.MQTT_BROKER_USERNAME;
    this.mqtt_broker_password = process.env.MQTT_BROKER_PASSWORD;
    this.mqtt_broker_topic_prefix = process.env.MQTT_BROKER_TOPIC_PREFIX;
    this.digestClient = new DigestFetch(this.dahua_username, this.dahua_password);

    this.getDeviceDetails().then(({ deviceType, serialNumber }) => {
      this.deviceType = deviceType;
      this.serialNumber = serialNumber;
      this.start();
    });
  }

  /**
   * Starts the app by:
   *    - Opening a TCP socket to the doorbell
   *    - Connecting to the MQTT broker
   *    - Authenticating with the doorbell and subscribing to events.
   */
  start() {
      this.setupDoorbellSocket();
      this.setupMQTT();
      this.initLogin();
  }

  /**
   * Makes a request to the doorbell using digest auth to retrieve the device's information.
   *
   * The information is returned in plain text (not JSON) that we have to parse.
   * For now I think we only care about device type and serial number, which can be
   * used to disambiguate in case we have more than one doorbell.
   */
  async getDeviceDetails() {
    return this.digestClient
      .fetch(
        `http://${this.dahua_host}/cgi-bin/magicBox.cgi?action=getSystemInfo`
      )
      .then((r) => r.text())
      .then((text) => {
        const deviceDetails = text
          .trim()
          .split('\n')
          .reduce((obj, str) => {
            const [key, val] = str.split('=');
            obj[key] = val.trim();
            return obj;
          }, {});
        return deviceDetails;
      });
  }


  /**
   * Saves a snapshot of the doorbells image into the given directory (defaults to /tmp/).
   *
   * By default the file is named with a simple timestamp of the current time (YYYY-MM-DD-H-M-S.jpg)
   *
   */
  saveSnapshot(p = "/tmp/") {
    let now = new Date();
    let dateStr = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}-${now.getSeconds()}`
    let destination = path.join(p, `DoorBell_${dateStr}.jpg`);
    this.digestClient.fetch(`http://${this.dahua_host}/cgi-bin/snapshot.cgi`).then(r => {
      return r.buffer();
    }).then(buf => {
      fs.writeFile(destination, buf, 'binary', function(err) {
        if (err) {
          console.error('Error saving snapshot to disk', err);
        } else {
          console.info('Snapshot saved');
        }
      });
    });
  }

  /**
   * Creates the TCP socket connection with the doorbell on port 5000.
   *
   * Setups the listener for when we receive data over that socket
   *
   * Also setups other listeners for logging purposes mostly.
   *
   * If something goes wrong, we close everything and try to start over again.
   */
  setupDoorbellSocket() {
    let socket = new net.Socket({ readable: true, writable: true });
    socket.on('end', function () {
      console.log('Doorbell socket ended');
    });
    socket.on('close', function () {
      console.log('Doorbell socket closed');
      clearInterval(this._keepAliveTimer);
    });
    socket.on('data', this.receive.bind(this));
    socket.on('error', function (e) {
      console.error('Doorbell socket error', e);
      this.doorbellSocket.destroy();        // destroy the socket
      this.mqttClient.end(true);            // End the mqtt connection right away.
      clearInterval(this._keepAliveTimer);  // Stop sending keepalive requests
      this.start();                         // Start over again.
    });
    this.doorbellSocket = socket.connect({ port: 5000, host: this.dahua_host });
  }

  /**
   * Configure an initialize the MQTT client.
   *
   * It configures the "Last Will and Testament" (LWT), which is the message send to MQTT
   * if this client gets disconnected in an ungraceful way (e.g. a fatal error).
   *
   * It also adds listeners that right now are only used for logging.
   */
  setupMQTT() {
    this.mqttClient = mqtt.connect({
      host: this.mqtt_broker_host,
      port: this.mqtt_broker_port,
      username: this.mqtt_broker_username,
      password: this.mqtt_broker_password,
      will: {
        topic: `${this.mqtt_broker_topic_prefix}/lwt`,
        payload: 'connected',
        qos: 1,
      },
    });
    this.mqttClient.on('disconnect', function (packet) {
      console.log('MQTTDisconnect', packet);
    });
    this.mqttClient.on('message', function (topic, message, packet) {
      console.log('MQTTMessage', { topic, message, packet });
    });
  }

  /**
   * Publishes to MQTT an event with the given name and payload.
   * @param {string} name
   * @param {object} payload
   */
  publishToMQTT(name, payload) {
    let message = JSON.stringify(payload);
    this.mqttClient.publish(
      `${this.mqtt_broker_topic_prefix}/${name}/Event`,
      message
    );
  }

  /**
   * Sends a message with the given data to the doorbell's outside unit using the TCP socket.
   * @param {string} data
   *
   * This is a fairly low level way of communication, so let's dive in.
   *
   * We write binary to the socket, so we have to use buffers.
   *
   * The first 32 bytes of the message are the header.
   * After the header we concat the actual message, which is a JSON string.
   * The header has some bits that are fixed and others that are the length of the message that will
   * come after.
   *
   * I didn't reverse-engineered this myself but it works. Take it as gospel as I did.
   */
  send(data) {
    let json = JSON.stringify(data);
    let buf = Buffer.alloc(32);
    let offset = buf.writeUInt32BE(0x20000000);
    offset = buf.writeUInt32BE(0x44484950, offset);
    offset = buf.writeDoubleBE(0, offset);
    offset = buf.writeUInt32LE(json.length, offset);
    offset = buf.writeUInt32LE(0, offset);
    offset = buf.writeUInt32LE(json.length, offset);
    offset = buf.writeUInt32LE(0, offset);
    buf = Buffer.concat([buf, Buffer.from(json)]);
    this.requestId += 1;
    this.doorbellSocket.write(buf);
  }

  /**
   * Handles received messages from the TCP socket.
   * @param {Buffer} buf
   *
   * The received messages are binary. Once discarded the first 32 bytes (the header),
   * the rest of the message is parsed as as a JSON string.
   *
   * The header contains the length of the received response in bytes 16..20 and the expected
   * length of the response in bytes 24..28 in case we need it, but I haven't found a
   * reason to. Perhaps responses might be sent in several chunks? So far it doesn't seem to be
   * the case.
   *
   * Since we always make requests in the exact same order, we know the first two responses are
   * for the authentication.
   * Subsequent responses can be either events or keepalive responses.
   */
  receive(buf) {
    let str = buf.slice(32).toString();
    let obj = JSON.parse(str);
    if (this.requestId === 1) {
      this.handleFirstLoginPayload(obj);
    } else if (this.requestId === 2) {
      this.handleSecondLoginPayload(obj);
    } else if (obj.method === 'client.notifyEventStream') {
      this.handleEvents(obj.params.eventList);
    } else {
      this.handleGenericPayload(obj);
    }
  }

  /**
   * Sends the initial login request.
   * Note that does not include any password.
   * The response to this request will be negative but that is expected, it will contain the
   * necessary information to login.
   */
  initLogin() {
    this.send({
      id: 10000,
      magic: '0x1234',
      method: 'global.login',
      params: {
        clientType: '',
        ipAddr: '(null)',
        loginType: 'Direct',
        password: '',
        userName: this.dahua_username,
      },
      session: 0,
    });
  }

  /**
   * Handles the response to the initial login request.
   *
   * The response contains a session ID, a realm and a random, which in combination with
   * the username and the password are used to generate an MD5 password that is used
   * for logging in.
   *
   * @param {object} payload
   */
  handleFirstLoginPayload({ session, params: { random, realm } }) {
    this.sessionId = session;
    let randomHash = this.genMD5Hash(random, realm);
    this.send({
      id: 10000,       // I assume this ID a high number just because we have to send something.
      magic: '0x1234', // No idea what this is
      method: 'global.login',
      session: this.sessionId,
      params: {
        userName: this.dahua_username,
        password: randomHash,
        clientType: '',
        ipAddr: '(null)',
        loginType: 'Direct',
        authorityType: 'Default',
      },
    });
  }

  /**
   * Handles the response to the second (and last) response to login request.
   *
   * If successful, any subsequent message that includes the session id will be accepted for
   * as long as the socket is not closed.
   *
   * To prevent the socket from closing we send a keepalive message every so often.
   *
   * Also now that we're authenticated we subscribe to all events fired by the doorbell.
   */
  handleSecondLoginPayload(obj) {
    if (obj.result) {
      console.info('Logging to Dahua Doorbell successful');
      this.keepAliveInterval = obj.params.keepAliveInterval - 5;
      this.attachEventManager();
      this.keepConnectionAlive();
    } else {
      console.error('Failed to login. Response was: ', obj);
    }
  }

  /**
   * Handles any response not handled by any other method. I believe only keepalive responses
   * will end up here, but added some logging just in case.
   *
   * For now keepalive events are published to MQTT, but I don't see a good reason for that.
   */
  handleGenericPayload(obj) {
    if (
      obj.result === true &&
      obj.params &&
      Object.hasOwnProperty.call(obj.params, 'timeout')
    ) {
      console.info('Publish KeepAlive event');
      this.publishToMQTT('keepAlive', {
        deviceType: this.deviceType,
        serialNumber: this.serialNumber,
      });
    } else {
      console.error(
        'handleGenericPayload# Cannot handle received payload',
        obj
      );
    }
  }

  /**
   * Generates a MD5 digest of the username, password, realms and random to send as
   * password when logging in.
   * @param {*} random
   * @param {*} realm
   */
  genMD5Hash(random, realm) {
    const base_credentials = `${this.dahua_username}:${realm}:${this.dahua_password}`;
    const pwddb_hash = md5(base_credentials).toUpperCase();
    const base_pass = `${this.dahua_username}:${random}:${pwddb_hash}`;
    return md5(base_pass).toUpperCase();
  }

  /**
   * Sends the message to subscribe to all dorbell events.
   */
  attachEventManager() {
    this.send({
      id: this.requestId,
      magic: '0x1234',
      method: 'eventManager.attach',
      params: {
        codes: ['All'],
      },
      session: this.sessionId,
    });
  }

  /**
   * Handles the events sent by the doorbell.
   *
   * It just publishes those events along with some information of the device firing them
   * to MQTT
   */
  handleEvents(events) {
    events.forEach((event) => {
      console.info(`Publish event ${event.Code} to MQTT`);
      this.publishToMQTT(event.Code, {
        Action: event.eventAction,
        Data: event.Data,
        deviceType: this.deviceType,
        serialNumber: this.serialNumber,
      });
    });
  }

  /**
   * Sets up a function to be called periodically to keep the socket open by sending
   * keepalive messages.
   * @param {Number} delay (in seconds)
   */
  keepConnectionAlive(delay) {
    this._keepAliveTimer = setInterval(() => {
      let keepAlivePayload = {
        method: 'global.keepAlive',
        magic: '0x1234',
        params: {
          timeout: delay,
          active: true,
        },
        id: this.requestId,
        session: this.sessionId,
      };

      this.send(keepAlivePayload);
    }, this.keepAliveInterval * 1000);
  }
};

exports.default = DahuaVTO;

new DahuaVTO();
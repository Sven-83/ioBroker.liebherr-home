"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_client = require("./lib/api/client");
var import_errors = require("./lib/api/errors");
var import_sse = require("./lib/api/sse");
var import_commands = require("./lib/model/commands");
var import_device_store = require("./lib/model/device-store");
var import_config = require("./lib/util/config");
var import_device_key = require("./lib/util/device-key");
var import_failure_log = require("./lib/util/failure-log");
const RETRY_START_S = 60;
const START_JITTER_MS = 2e3;
const STREAM_SPACING_MS = 1e3;
class LiebherrHome extends utils.Adapter {
  client;
  store;
  commands;
  timer;
  pollSeconds = import_config.POLL_DEFAULT_S;
  retrySeconds = RETRY_START_S;
  connectionState;
  firstSync = true;
  streams = /* @__PURE__ */ new Map();
  openStreams = /* @__PURE__ */ new Set();
  realtimeState;
  keyRejected = false;
  unloading = false;
  failures = new import_failure_log.FailureLog();
  scheduler = {
    setTimeout: (callback, ms) => this.setTimeout(callback, ms),
    clearTimeout: (handle) => this.clearTimeout(handle)
  };
  constructor(options = {}) {
    super({
      ...options,
      name: "liebherr-home"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    await this.setState("info.connection", false, true);
    await this.setState("info.realtime", false, true);
    const apiKey = (0, import_client.normalizeApiKey)(this.config.apiKey);
    if (!apiKey) {
      this.log.error(
        "No API key configured. Create one in the SmartDevice app and enter it in the instance settings."
      );
      return;
    }
    if (!(0, import_device_key.isValidSalt)(this.config.deviceSalt)) {
      this.log.info("Creating the instance salt for device object IDs - the adapter restarts once");
      await this.updateConfig({ deviceSalt: (0, import_device_key.createSalt)() });
      return;
    }
    this.pollSeconds = (0, import_config.pollIntervalSeconds)(this.config.pollInterval);
    this.client = new import_client.HomeApiClient(apiKey);
    this.store = new import_device_store.DeviceStore(
      {
        // late stream events and readbacks must not touch the databases after onUnload
        ensureObject: async (id, obj) => {
          if (!this.unloading) {
            await this.extendObject(id, obj);
          }
        },
        setValue: async (id, value) => {
          if (!this.unloading) {
            await this.setState(id, value, true);
          }
        }
      },
      this.log,
      this.config.deviceSalt,
      { autoDoor: this.config.allowAutoDoor === true }
    );
    this.commands = new import_commands.CommandHandler(this.client, this.store, this.log, this.scheduler);
    this.subscribeStates("*");
    this.timer = this.setTimeout(() => void this.poll(), Math.round(Math.random() * START_JITTER_MS));
  }
  /**
   * Commands from ioBroker (ack=false) go to the command handler; it confirms with ack=true.
   *
   * @param id - Full state ID
   * @param state - State object
   */
  onStateChange(id, state) {
    if (!state || state.ack || !this.commands) {
      return;
    }
    this.commands.handle(id.slice(this.namespace.length + 1), state.val);
  }
  /**
   * One polling cycle: device list (discovery), then the controls of every device.
   * With real-time updates enabled the SSE streams deliver changes; polling stays as resync.
   */
  async poll() {
    var _a;
    this.timer = void 0;
    const { client, store } = this;
    if (!client || !store || this.keyRejected) {
      return;
    }
    try {
      const devices = await client.getDevices();
      const keys = await store.syncDevices(devices);
      const outage = this.failures.recovered(Date.now());
      if (outage !== void 0) {
        this.log.info(`Connection to the Liebherr HomeAPI restored after ${(0, import_failure_log.formatDuration)(outage)}`);
      } else if (this.connectionState !== true) {
        this.log.info(`Connected to the Liebherr HomeAPI, ${devices.length} device(s) found`);
      }
      await this.setConnected(true);
      await this.markMissingDevices(store, keys);
      for (const key of keys) {
        await this.pollDevice(client, store, key);
      }
      if (this.config.useSse) {
        this.syncStreams(client, store, keys);
      }
      this.retrySeconds = RETRY_START_S;
      this.schedule(this.pollSeconds);
    } catch (error) {
      if (error instanceof import_errors.AbortedError || this.unloading) {
        return;
      }
      await this.setConnected(false);
      if (error instanceof import_errors.KeyRejectedError) {
        await this.onKeyRejected(error.message);
        return;
      }
      const requested = error instanceof import_errors.RateLimitedError ? Math.ceil(((_a = error.retryAfterMs) != null ? _a : 0) / 1e3) : 0;
      const delay = Math.max(this.retrySeconds, requested);
      const level = this.failures.failed(Date.now());
      this.log[level](`${(0, import_errors.describeError)(error)} - retrying in ${delay} s`);
      this.schedule(delay);
      this.retrySeconds = Math.min(this.retrySeconds * 2, this.pollSeconds);
    }
  }
  /**
   * Reads and writes the controls of one device. Only "device not reachable" is handled
   * here - every other error concerns the cloud and ends the cycle.
   *
   * @param client - API client
   * @param store - Object store
   * @param key - Device key
   */
  async pollDevice(client, store, key) {
    const deviceId = store.deviceIdOf(key);
    if (!deviceId) {
      return;
    }
    try {
      const controls = await client.getControls(deviceId);
      await store.applyControls(key, controls);
      await store.setReachable(key, true);
    } catch (error) {
      if (error instanceof import_errors.DeviceUnreachableError) {
        await store.setReachable(key, false);
        return;
      }
      throw error;
    }
  }
  /**
   * Devices that disappeared from the account keep their objects but are marked unreachable.
   *
   * @param store - Object store
   * @param keys - Keys of the current device list
   */
  async markMissingDevices(store, keys) {
    const current = new Set(keys);
    if (this.firstSync) {
      this.firstSync = false;
      const view = await this.getObjectViewAsync("system", "device", {
        startkey: `${this.namespace}.`,
        endkey: `${this.namespace}.\u9999`
      });
      for (const row of view.rows) {
        const key = row.id.slice(this.namespace.length + 1);
        if (!current.has(key)) {
          this.log.info(`Device ${key} is no longer in the account - its objects are kept`);
          await this.setState(`${key}.info.reachable`, false, true);
        }
      }
    }
    for (const key of store.keys) {
      if (!current.has(key)) {
        await store.setReachable(key, false);
      }
    }
  }
  /**
   * Starts a real-time stream for every device in the list and stops streams of devices
   * that left the account.
   *
   * @param client - API client
   * @param store - Object store
   * @param keys - Keys of the current device list
   */
  syncStreams(client, store, keys) {
    const current = new Set(keys);
    let started = 0;
    for (const [key, stream] of this.streams) {
      if (!current.has(key)) {
        stream.stop();
        this.streams.delete(key);
        this.openStreams.delete(key);
      }
    }
    for (const key of keys) {
      const deviceId = store.deviceIdOf(key);
      if (this.streams.has(key) || !deviceId) {
        continue;
      }
      const stream = new import_sse.SseStream(
        client,
        deviceId,
        store.nameOf(key),
        {
          onControls: async (controls) => {
            await store.applyControls(key, controls);
            await store.setReachable(key, true);
          },
          onOpen: (open) => {
            if (open) {
              this.openStreams.add(key);
            } else {
              this.openStreams.delete(key);
            }
            void this.updateRealtime();
          },
          onUnreachable: () => void store.setReachable(key, false),
          onKeyRejected: () => void this.onKeyRejected("Liebherr HomeAPI rejected the API key (HTTP 401)")
        },
        this.log,
        { scheduler: this.scheduler }
      );
      this.streams.set(key, stream);
      stream.start(started * STREAM_SPACING_MS + Math.round(Math.random() * 500));
      started++;
    }
    void this.updateRealtime();
  }
  stopStreams() {
    for (const stream of this.streams.values()) {
      stream.stop();
    }
    this.streams.clear();
    this.openStreams.clear();
  }
  /** info.realtime: true while the streams of all devices are open */
  async updateRealtime() {
    const realtime = this.streams.size > 0 && this.openStreams.size === this.streams.size;
    if (this.realtimeState !== realtime && !this.unloading) {
      this.realtimeState = realtime;
      await this.setState("info.realtime", realtime, true);
    }
  }
  /**
   * Retrying cannot help with a rejected key - a config change restarts the instance.
   *
   * @param message - Error message
   */
  async onKeyRejected(message) {
    if (this.keyRejected) {
      return;
    }
    this.keyRejected = true;
    this.stopStreams();
    this.clearTimeout(this.timer);
    this.timer = void 0;
    await this.setConnected(false);
    await this.updateRealtime();
    this.log.error(
      `${message}. Check the key in the instance settings; creating a new key in the app invalidates the old one.`
    );
  }
  /**
   * @param seconds - Delay until the next polling cycle
   */
  schedule(seconds) {
    this.timer = this.setTimeout(() => void this.poll(), seconds * 1e3);
  }
  /**
   * @param connected - New connection state
   */
  async setConnected(connected) {
    if (this.connectionState !== connected && !this.unloading) {
      this.connectionState = connected;
      await this.setState("info.connection", connected, true);
    }
  }
  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   *
   * @param callback - Callback function
   */
  onUnload(callback) {
    var _a, _b;
    try {
      this.unloading = true;
      (_a = this.commands) == null ? void 0 : _a.stop();
      this.stopStreams();
      (_b = this.client) == null ? void 0 : _b.close();
      this.clearTimeout(this.timer);
      callback();
    } catch (error) {
      this.log.error(`Error during unloading: ${(0, import_errors.describeError)(error)}`);
      callback();
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new LiebherrHome(options);
} else {
  (() => new LiebherrHome())();
}
//# sourceMappingURL=main.js.map

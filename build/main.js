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
var import_device_store = require("./lib/model/device-store");
var import_config = require("./lib/util/config");
var import_device_key = require("./lib/util/device-key");
const RETRY_START_S = 60;
class LiebherrHome extends utils.Adapter {
  client;
  store;
  timer;
  pollSeconds = import_config.POLL_DEFAULT_S;
  retrySeconds = RETRY_START_S;
  connectionState;
  firstSync = true;
  constructor(options = {}) {
    super({
      ...options,
      name: "liebherr-home"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    await this.setState("info.connection", false, true);
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
        ensureObject: async (id, obj) => {
          await this.extendObject(id, obj);
        },
        setValue: async (id, value) => {
          await this.setState(id, value, true);
        }
      },
      this.log,
      this.config.deviceSalt
    );
    await this.poll();
  }
  /**
   * One polling cycle: device list (discovery), then the controls of every device.
   * Phase 4 adds SSE for real time; polling stays as resync.
   */
  async poll() {
    this.timer = void 0;
    const { client, store } = this;
    if (!client || !store) {
      return;
    }
    try {
      const devices = await client.getDevices();
      const keys = await store.syncDevices(devices);
      if (this.connectionState !== true) {
        this.log.info(`Connected to the Liebherr HomeAPI, ${devices.length} device(s) found`);
      }
      await this.setConnected(true);
      await this.markMissingDevices(store, keys);
      for (const key of keys) {
        await this.pollDevice(client, store, key);
      }
      this.retrySeconds = RETRY_START_S;
      this.schedule(this.pollSeconds);
    } catch (error) {
      if (error instanceof import_errors.AbortedError) {
        return;
      }
      await this.setConnected(false);
      if (error instanceof import_errors.KeyRejectedError) {
        this.log.error(
          `${error.message}. Check the key in the instance settings; creating a new key in the app invalidates the old one.`
        );
        return;
      }
      this.log.warn(`${(0, import_errors.describeError)(error)} - retrying in ${this.retrySeconds} s`);
      this.schedule(this.retrySeconds);
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
   * @param seconds - Delay until the next polling cycle
   */
  schedule(seconds) {
    this.timer = this.setTimeout(() => void this.poll(), seconds * 1e3);
  }
  /**
   * @param connected - New connection state
   */
  async setConnected(connected) {
    if (this.connectionState !== connected) {
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
    var _a;
    try {
      (_a = this.client) == null ? void 0 : _a.close();
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

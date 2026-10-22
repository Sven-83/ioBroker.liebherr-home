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
var import_config = require("./lib/util/config");
var import_device_key = require("./lib/util/device-key");
const RETRY_START_S = 60;
class LiebherrHome extends utils.Adapter {
  client;
  timer;
  pollSeconds = import_config.POLL_DEFAULT_S;
  retrySeconds = RETRY_START_S;
  connectionState;
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
    await this.checkConnection();
  }
  /**
   * Reads the device list to verify key and cloud connection, then schedules the next check.
   * Phase 2 placeholder for discovery and polling (phase 3).
   */
  async checkConnection() {
    this.timer = void 0;
    if (!this.client) {
      return;
    }
    try {
      const devices = await this.client.getDevices();
      this.retrySeconds = RETRY_START_S;
      if (this.connectionState !== true) {
        this.log.info(`Connected to the Liebherr HomeAPI, ${devices.length} device(s) found`);
      }
      await this.setConnected(true);
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
   * @param seconds - Delay until the next connection check
   */
  schedule(seconds) {
    this.timer = this.setTimeout(() => void this.checkConnection(), seconds * 1e3);
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

"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var device_store_exports = {};
__export(device_store_exports, {
  DeviceStore: () => DeviceStore
});
module.exports = __toCommonJS(device_store_exports);
var import_device_key = require("../util/device-key");
var import_redact = require("../util/redact");
var import_mapper = require("./mapper");
const NAME_MAX = 100;
function displayName(device) {
  var _a;
  const candidates = [device.nickname, device.deviceName, device.deviceType];
  const name = (_a = candidates.find((c) => typeof c === "string" && c.trim() !== "")) != null ? _a : "Liebherr device";
  return (0, import_redact.stripLineBreaks)(name).trim().slice(0, NAME_MAX);
}
class DeviceStore {
  /**
   * @param sink - Object/state access of the adapter
   * @param log - Logger
   * @param salt - Instance salt for the device keys
   * @param options - Mapping options from the instance config
   */
  constructor(sink, log, salt, options = {}) {
    this.sink = sink;
    this.log = log;
    this.salt = salt;
    this.options = options;
  }
  devices = /* @__PURE__ */ new Map();
  /** Objects written in this adapter run (common is rewritten once per start, e.g. after an update) */
  objects = /* @__PURE__ */ new Set();
  values = /* @__PURE__ */ new Map();
  reachable = /* @__PURE__ */ new Map();
  reportedUnknown = /* @__PURE__ */ new Set();
  /** common/native of every control state mapped in this run, for commands */
  infos = /* @__PURE__ */ new Map();
  /**
   * Object data of a control state, undefined until the device was read in this run.
   *
   * @param id - State ID relative to the instance
   */
  stateInfo(id) {
    return this.infos.get(id);
  }
  /**
   * Last value confirmed by the cloud.
   *
   * @param id - State ID relative to the instance
   */
  valueOf(id) {
    return this.values.get(id);
  }
  /**
   * Confirms a value the cloud does not report back (command states).
   *
   * @param id - State ID relative to the instance
   * @param value - Value to confirm with ack=true
   */
  async confirm(id, value) {
    this.values.delete(id);
    await this.write(id, value);
  }
  /**
   * Writes the last confirmed value again with ack=true, e.g. after a rejected command.
   * Clears the state's cache, so the next reading from the cloud is written in any case.
   *
   * @param id - State ID relative to the instance
   */
  async restore(id) {
    const value = this.values.get(id);
    this.values.delete(id);
    if (value !== void 0) {
      await this.write(id, value);
    }
  }
  /** Device keys known in this run */
  get keys() {
    return [...this.devices.keys()];
  }
  /**
   * deviceId (serial number) for API requests.
   *
   * @param key - Device key
   */
  deviceIdOf(key) {
    var _a;
    return (_a = this.devices.get(key)) == null ? void 0 : _a.deviceId;
  }
  /**
   * Display name for log messages.
   *
   * @param key - Device key
   */
  nameOf(key) {
    var _a, _b;
    return (_b = (_a = this.devices.get(key)) == null ? void 0 : _a.name) != null ? _b : key;
  }
  /**
   * Creates/updates the device objects for the current device list.
   *
   * @param list - Answer of GET /v1/devices
   * @returns Keys of the devices in the list
   */
  async syncDevices(list) {
    var _a;
    const keys = [];
    for (const device of list) {
      const key = (0, import_device_key.deviceKey)(device.deviceId, device.deviceType, this.salt);
      const name = displayName(device);
      const known = this.devices.get(key);
      this.devices.set(key, { deviceId: device.deviceId, name });
      keys.push(key);
      if (!known) {
        this.log.info(`Device "${name}" (${(_a = device.deviceType) != null ? _a : "unknown type"}) found as ${key}`);
      }
      if (!known || known.name !== name) {
        await this.ensure(key, { type: "device", common: { name }, native: {} }, (known == null ? void 0 : known.name) !== name);
        await this.ensureInfoObjects(key);
      }
      await this.write(`${key}.info.name`, name);
      await this.write(`${key}.info.model`, typeof device.deviceName === "string" ? device.deviceName : null);
      await this.write(`${key}.info.type`, typeof device.deviceType === "string" ? device.deviceType : null);
    }
    return keys;
  }
  /**
   * Writes the controls of one device. Works for full and partial lists (SSE sends partial
   * updates): controls missing in the list are left untouched.
   *
   * @param key - Device key
   * @param controls - Controls from /controls or an SSE event
   */
  async applyControls(key, controls) {
    for (const control of controls) {
      const mapped = (0, import_mapper.mapControl)(control, this.options);
      if (!mapped) {
        continue;
      }
      if (mapped.unknownType && !this.reportedUnknown.has(mapped.unknownType)) {
        this.reportedUnknown.add(mapped.unknownType);
        this.log.info(
          `Unknown control type "${(0, import_redact.stripLineBreaks)(mapped.unknownType).slice(0, 50)}" - stored as raw JSON`
        );
      }
      for (const channel of mapped.channels) {
        await this.ensure(`${key}.${channel.id}`, {
          type: "channel",
          common: { name: channel.name },
          native: {}
        });
      }
      for (const state of mapped.states) {
        const id = `${key}.${state.id}`;
        await this.ensure(id, { type: "state", common: state.common, native: state.native });
        this.infos.set(id, { common: state.common, native: state.native });
        await this.write(id, state.value);
      }
    }
    await this.sink.setValue(`${key}.info.lastUpdate`, Date.now());
  }
  /**
   * @param key - Device key
   * @param reachable - Whether the cloud can reach the device
   */
  async setReachable(key, reachable) {
    if (this.reachable.get(key) === reachable) {
      return;
    }
    const before = this.reachable.get(key);
    this.reachable.set(key, reachable);
    if (before !== void 0 || !reachable) {
      this.log[reachable ? "info" : "warn"](
        `Device "${this.nameOf(key)}" is ${reachable ? "reachable again" : "not reachable"}`
      );
    }
    await this.sink.setValue(`${key}.info.reachable`, reachable);
  }
  async ensureInfoObjects(key) {
    await this.ensure(`${key}.info`, { type: "channel", common: { name: "Information" }, native: {} });
    const text = (name) => ({
      name,
      type: "string",
      role: "text",
      read: true,
      write: false
    });
    await this.ensure(`${key}.info.name`, {
      type: "state",
      common: text("Name in the SmartDevice app"),
      native: {}
    });
    await this.ensure(`${key}.info.model`, { type: "state", common: text("Model"), native: {} });
    await this.ensure(`${key}.info.type`, { type: "state", common: text("Device type"), native: {} });
    await this.ensure(`${key}.info.reachable`, {
      type: "state",
      common: {
        name: "Reachable via the cloud",
        type: "boolean",
        role: "indicator.reachable",
        read: true,
        write: false
      },
      native: {}
    });
    await this.ensure(`${key}.info.lastUpdate`, {
      type: "state",
      common: { name: "Last update", type: "number", role: "value.time", read: true, write: false },
      native: {}
    });
  }
  /**
   * @param id - Object ID relative to the instance
   * @param obj - Object
   * @param force - Write even if already written in this run
   */
  async ensure(id, obj, force = false) {
    if (force || !this.objects.has(id)) {
      await this.sink.ensureObject(id, obj);
      this.objects.add(id);
    }
  }
  /**
   * Writes a value if it changed; invalid values (null) are skipped.
   *
   * @param id - State ID relative to the instance
   * @param value - New value
   */
  async write(id, value) {
    if (value === null || this.values.get(id) === value) {
      return;
    }
    this.values.set(id, value);
    await this.sink.setValue(id, value);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DeviceStore
});
//# sourceMappingURL=device-store.js.map

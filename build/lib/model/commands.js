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
var commands_exports = {};
__export(commands_exports, {
  CommandHandler: () => CommandHandler,
  DEFAULT_TIMING: () => DEFAULT_TIMING
});
module.exports = __toCommonJS(commands_exports);
var import_errors = require("../api/errors");
var import_writer = require("./writer");
const DEFAULT_TIMING = { debounceMs: 500, readbackMs: 2e3, secondReadbackMs: 8e3 };
class CommandHandler {
  /**
   * @param client - API client
   * @param store - Object store
   * @param log - Logger
   * @param scheduler - Timer functions of the adapter
   * @param timing - Delays
   */
  constructor(client, store, log, scheduler, timing = DEFAULT_TIMING) {
    this.client = client;
    this.store = store;
    this.log = log;
    this.scheduler = scheduler;
    this.timing = timing;
  }
  pending = /* @__PURE__ */ new Map();
  debounce = /* @__PURE__ */ new Map();
  chains = /* @__PURE__ */ new Map();
  stopped = false;
  /**
   * Accepts a command; invalid values are rejected right away.
   *
   * @param id - State ID relative to the instance, e.g. "fridge_db4c8f36.zones.0.setpoint"
   * @param value - Value set with ack=false
   */
  handle(id, value) {
    if (this.stopped) {
      return;
    }
    const info = this.store.stateInfo(id);
    if (!info) {
      const known = this.store.deviceIdOf(id.split(".")[0]) !== void 0;
      this.log.warn(
        `Command for ${id} ignored - ${known ? "state is read-only" : "device has not been read yet"}`
      );
      return;
    }
    let request;
    try {
      request = (0, import_writer.buildWriteRequest)(info, value, id);
    } catch (error) {
      const reason = error instanceof import_writer.CommandError ? error.message : (0, import_errors.describeError)(error);
      this.log.warn(`Command for ${id} rejected: ${reason}`);
      void this.store.restore(id);
      return;
    }
    this.pending.set(id, request);
    this.scheduler.clearTimeout(this.debounce.get(id));
    this.debounce.set(
      id,
      this.scheduler.setTimeout(() => {
        this.debounce.delete(id);
        this.enqueue(id);
      }, this.timing.debounceMs)
    );
  }
  /** Resolves when all queued commands are done (for tests) */
  async idle() {
    await Promise.all(this.chains.values());
  }
  /** Drops pending commands, used in onUnload */
  stop() {
    this.stopped = true;
    for (const handle of this.debounce.values()) {
      this.scheduler.clearTimeout(handle);
    }
    this.debounce.clear();
    this.pending.clear();
  }
  enqueue(id) {
    var _a;
    const key = id.split(".")[0];
    const chain = ((_a = this.chains.get(key)) != null ? _a : Promise.resolve()).then(() => this.execute(key, id));
    this.chains.set(key, chain);
  }
  async execute(key, id) {
    const request = this.pending.get(id);
    this.pending.delete(id);
    const deviceId = this.store.deviceIdOf(key);
    if (!request || !deviceId || this.stopped) {
      return;
    }
    const label = `"${this.store.nameOf(key)}" ${id.slice(key.length + 1)}`;
    let sent = false;
    try {
      await this.client.postControl(deviceId, request.control, request.body);
      sent = true;
      this.log.debug(`Command ${label} = ${String(request.expected)} sent`);
      if (id.endsWith(".autodoorCommand")) {
        await this.store.confirm(id, request.expected);
        return;
      }
      await this.readback(key, deviceId, request, this.timing.readbackMs);
      if (this.store.valueOf(id) !== request.expected) {
        await this.readback(key, deviceId, request, this.timing.secondReadbackMs);
      }
      if (this.store.valueOf(id) !== request.expected) {
        this.log.info(
          `Command ${label} = ${String(request.expected)} accepted, but the device reports ${String(this.store.valueOf(id))}`
        );
      }
    } catch (error) {
      this.log.warn(
        `Command ${label} = ${String(request.expected)} ${sent ? "sent, but reading it back failed" : "failed"}: ${(0, import_errors.describeError)(error)}`
      );
    } finally {
      if (!this.pending.has(id)) {
        await this.store.restore(id);
      }
    }
  }
  /**
   * @param key - Device key
   * @param deviceId - deviceId for the request
   * @param request - Sent command
   * @param delayMs - Wait before reading
   */
  async readback(key, deviceId, request, delayMs) {
    await new Promise((resolve) => this.scheduler.setTimeout(resolve, delayMs));
    if (this.stopped) {
      return;
    }
    const zoneId = typeof request.body.zoneId === "number" ? request.body.zoneId : void 0;
    const controls = await this.client.getControl(deviceId, request.control, zoneId);
    await this.store.applyControls(key, controls);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CommandHandler,
  DEFAULT_TIMING
});
//# sourceMappingURL=commands.js.map

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
var writer_exports = {};
__export(writer_exports, {
  CommandError: () => CommandError,
  buildWriteRequest: () => buildWriteRequest
});
module.exports = __toCommonJS(writer_exports);
var import_mapper = require("./mapper");
class CommandError extends Error {
  /** @param message - Reason, without secrets */
  constructor(message) {
    super(message);
    this.name = "CommandError";
  }
}
const MODE_FIELDS = {
  hydrobreeze: "hydroBreezeMode",
  icemaker: "iceMakerMode",
  biofreshplus: "bioFreshPlusMode"
};
function buildWriteRequest(info, value, stateId) {
  var _a;
  const { common, native } = info;
  if (!common.write) {
    throw new CommandError("state is read-only");
  }
  const zone = native.zoneId !== void 0 ? { zoneId: native.zoneId } : {};
  if (native.control === "temperature" && stateId.endsWith(".setpoint")) {
    const target = integer(value, common);
    if (((_a = native.steps) == null ? void 0 : _a.length) && !native.steps.includes(target)) {
      throw new CommandError(`${target} is not an allowed setpoint (${native.steps.join(", ")})`);
    }
    return {
      control: "temperature",
      body: { ...zone, target, unit: common.unit === "\xB0F" ? "\xB0F" : "\xB0C" },
      expected: target
    };
  }
  if (import_mapper.WRITABLE_TOGGLES.has(native.control)) {
    const on = bool(value);
    return { control: native.control, body: { ...zone, value: on }, expected: on };
  }
  const modeField = MODE_FIELDS[native.control];
  if (modeField) {
    const mode = typeof value === "string" ? value.trim().toUpperCase() : "";
    if (!common.states || !Object.prototype.hasOwnProperty.call(common.states, mode)) {
      const allowed = common.states ? Object.keys(common.states).join(", ") : "none";
      throw new CommandError(`"${String(value).slice(0, 20)}" is not an allowed mode (${allowed})`);
    }
    return { control: native.control, body: { ...zone, [modeField]: mode }, expected: mode };
  }
  if (native.control === "presentationlight") {
    const target = integer(value, common);
    return { control: "presentationlight", body: { target }, expected: target };
  }
  if (native.control === "autodoor" && stateId.endsWith(".autodoorCommand")) {
    const open = bool(value);
    return { control: "autodoor", body: { ...zone, value: open }, expected: open };
  }
  throw new CommandError("no write path for this state");
}
function integer(value, common) {
  var _a, _b;
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) {
    throw new CommandError(`"${String(value).slice(0, 20)}" is not a number`);
  }
  if (!Number.isInteger(number)) {
    throw new CommandError(`${number} is not a whole number`);
  }
  if (common.min !== void 0 && number < common.min || common.max !== void 0 && number > common.max) {
    throw new CommandError(`${number} is outside ${(_a = common.min) != null ? _a : "-\u221E"} \u2026 ${(_b = common.max) != null ? _b : "\u221E"}`);
  }
  return number;
}
function bool(value) {
  if (value === true || value === 1 || value === "true" || value === "1") {
    return true;
  }
  if (value === false || value === 0 || value === "false" || value === "0") {
    return false;
  }
  throw new CommandError(`"${String(value).slice(0, 20)}" is not true or false`);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CommandError,
  buildWriteRequest
});
//# sourceMappingURL=writer.js.map

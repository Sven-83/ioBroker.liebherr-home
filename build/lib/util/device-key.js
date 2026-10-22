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
var device_key_exports = {};
__export(device_key_exports, {
  createSalt: () => createSalt,
  deviceKey: () => deviceKey,
  isValidSalt: () => isValidSalt
});
module.exports = __toCommonJS(device_key_exports);
var import_node_crypto = require("node:crypto");
const SALT_BYTES = 32;
function createSalt() {
  return (0, import_node_crypto.randomBytes)(SALT_BYTES).toString("hex");
}
function isValidSalt(salt) {
  return typeof salt === "string" && /^[0-9a-f]{64}$/.test(salt);
}
function deviceKey(deviceId, deviceType, salt) {
  const type = (deviceType != null ? deviceType : "device").toLowerCase().replace(/[^a-z0-9]/g, "") || "device";
  const hash = (0, import_node_crypto.createHmac)("sha256", salt).update(deviceId).digest("hex").slice(0, 8);
  return `${type}_${hash}`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createSalt,
  deviceKey,
  isValidSalt
});
//# sourceMappingURL=device-key.js.map

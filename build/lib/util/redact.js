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
var redact_exports = {};
__export(redact_exports, {
  DEVICE_ID_PATTERN: () => DEVICE_ID_PATTERN,
  redact: () => redact,
  stripLineBreaks: () => stripLineBreaks
});
module.exports = __toCommonJS(redact_exports);
const DEVICE_ID_PATTERN = /^\d{2}\.\d{3}\.\d{3}\.\d$/;
const SERIAL_IN_TEXT = /(?<![\d.])\d{2}\.\d{3}\.\d{3}\.\d(?![\d.])/g;
const LINE_BREAKS = new RegExp(`\r
|[\r
${String.fromCharCode(133, 8232, 8233)}]`, "g");
function redact(text, secrets = []) {
  let result = text;
  for (const secret of secrets) {
    if (secret) {
      result = result.split(secret).join("***");
    }
  }
  return result.replace(SERIAL_IN_TEXT, "**.***.***.*");
}
function stripLineBreaks(value) {
  return String(value).replace(LINE_BREAKS, " ");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEVICE_ID_PATTERN,
  redact,
  stripLineBreaks
});
//# sourceMappingURL=redact.js.map

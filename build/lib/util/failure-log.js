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
var failure_log_exports = {};
__export(failure_log_exports, {
  FailureLog: () => FailureLog,
  formatDuration: () => formatDuration
});
module.exports = __toCommonJS(failure_log_exports);
class FailureLog {
  since;
  /**
   * @param now - Current time (epoch ms)
   * @returns "warn" for the first failure of an outage, "debug" for repeats
   */
  failed(now) {
    if (this.since === void 0) {
      this.since = now;
      return "warn";
    }
    return "debug";
  }
  /**
   * @param now - Current time (epoch ms)
   * @returns Length of the outage that just ended in ms, undefined if there was none
   */
  recovered(now) {
    const since = this.since;
    this.since = void 0;
    return since === void 0 ? void 0 : now - since;
  }
}
function formatDuration(ms) {
  const seconds = Math.round(ms / 1e3);
  if (seconds < 120) {
    return `${seconds} s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) {
    return `${minutes} min`;
  }
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  FailureLog,
  formatDuration
});
//# sourceMappingURL=failure-log.js.map

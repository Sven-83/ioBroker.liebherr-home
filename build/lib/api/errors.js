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
var errors_exports = {};
__export(errors_exports, {
  AbortedError: () => AbortedError,
  ApiError: () => ApiError,
  HomeApiError: () => HomeApiError,
  KeyRejectedError: () => KeyRejectedError,
  NetworkError: () => NetworkError,
  RateLimitedError: () => RateLimitedError,
  ServiceUnavailableError: () => ServiceUnavailableError,
  describeError: () => describeError
});
module.exports = __toCommonJS(errors_exports);
var import_redact = require("../util/redact");
class HomeApiError extends Error {
  /** @param message - Error message (serial numbers are redacted) */
  constructor(message) {
    super((0, import_redact.redact)((0, import_redact.stripLineBreaks)(message)));
    this.name = new.target.name;
  }
}
class NetworkError extends HomeApiError {
}
class KeyRejectedError extends HomeApiError {
  /** Fixed message */
  constructor() {
    super("Liebherr HomeAPI rejected the API key (HTTP 401)");
  }
}
class RateLimitedError extends HomeApiError {
  /** Fixed message */
  constructor() {
    super("Liebherr HomeAPI rate limit reached (HTTP 429)");
  }
}
class ServiceUnavailableError extends HomeApiError {
  status;
  /** @param status - HTTP status */
  constructor(status) {
    super(`Liebherr HomeAPI unavailable (HTTP ${status})`);
    this.status = status;
  }
}
class ApiError extends HomeApiError {
  status;
  /**
   * @param message - Error message
   * @param status - HTTP status, if any
   */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
class AbortedError extends HomeApiError {
  /** Fixed message */
  constructor() {
    super("Request aborted");
  }
}
function describeError(error) {
  if (error instanceof HomeApiError) {
    return error.message;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (0, import_redact.redact)((0, import_redact.stripLineBreaks)(message));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AbortedError,
  ApiError,
  HomeApiError,
  KeyRejectedError,
  NetworkError,
  RateLimitedError,
  ServiceUnavailableError,
  describeError
});
//# sourceMappingURL=errors.js.map

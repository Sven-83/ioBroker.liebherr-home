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
var client_exports = {};
__export(client_exports, {
  BASE_URL: () => BASE_URL,
  HTTP_TIMEOUT_MS: () => HTTP_TIMEOUT_MS,
  HomeApiClient: () => HomeApiClient,
  normalizeApiKey: () => normalizeApiKey
});
module.exports = __toCommonJS(client_exports);
var import_errors = require("./errors");
const BASE_URL = "https://home-api.smartdevice.liebherr.com";
const HTTP_TIMEOUT_MS = 15e3;
function normalizeApiKey(key) {
  return typeof key === "string" ? key.replace(/[\u0000-\u001f\u007f\s]/g, "") : "";
}
class HomeApiClient {
  apiKey;
  fetchFn;
  baseUrl;
  timeoutMs;
  shutdown = new AbortController();
  /**
   * @param apiKey - Normalised API key from the SmartDevice app
   * @param options - Optional settings
   */
  constructor(apiKey, options = {}) {
    var _a, _b, _c;
    this.apiKey = apiKey;
    this.fetchFn = (_a = options.fetch) != null ? _a : ((input, init) => fetch(input, init));
    this.baseUrl = (_b = options.baseUrl) != null ? _b : BASE_URL;
    this.timeoutMs = (_c = options.timeoutMs) != null ? _c : HTTP_TIMEOUT_MS;
  }
  /** All devices of the household (GET /v1/devices) */
  async getDevices() {
    const body = await this.getJson("/v1/devices");
    if (!Array.isArray(body)) {
      throw new import_errors.ApiError("Unexpected answer for /v1/devices (no array)");
    }
    return body.filter(
      (entry) => typeof entry === "object" && entry !== null && typeof entry.deviceId === "string"
    );
  }
  /** Aborts all running requests, used in onUnload */
  close() {
    this.shutdown.abort();
  }
  async getJson(path) {
    if (this.shutdown.signal.aborted) {
      throw new import_errors.AbortedError();
    }
    let response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: { "api-key": this.apiKey, accept: "application/json" },
        signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(this.timeoutMs)])
      });
    } catch (error) {
      if (this.shutdown.signal.aborted) {
        throw new import_errors.AbortedError();
      }
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new import_errors.NetworkError(`Timeout after ${this.timeoutMs} ms`);
      }
      throw new import_errors.NetworkError((0, import_errors.describeError)(error));
    }
    if (response.status === 401) {
      throw new import_errors.KeyRejectedError();
    }
    if (response.status === 429) {
      throw new import_errors.RateLimitedError();
    }
    if (response.status >= 500) {
      throw new import_errors.ServiceUnavailableError(response.status);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new import_errors.ApiError(`HTTP ${response.status}: ${errorMessage(text)}`, response.status);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new import_errors.ApiError("Invalid JSON in answer", response.status);
    }
  }
}
function errorMessage(text) {
  var _a;
  try {
    const body = JSON.parse(text);
    const message = (_a = body.error) != null ? _a : body.message;
    if (typeof message === "string") {
      return message.slice(0, 200);
    }
  } catch {
  }
  return text.slice(0, 200);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BASE_URL,
  HTTP_TIMEOUT_MS,
  HomeApiClient,
  normalizeApiKey
});
//# sourceMappingURL=client.js.map

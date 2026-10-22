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
  MAX_RETRY_AFTER_MS: () => MAX_RETRY_AFTER_MS,
  normalizeApiKey: () => normalizeApiKey,
  parseRetryAfter: () => parseRetryAfter
});
module.exports = __toCommonJS(client_exports);
var import_redact = require("../util/redact");
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
  /**
   * All controls of one device (GET /v1/devices/{deviceId}/controls).
   *
   * @param deviceId - deviceId from getDevices()
   */
  async getControls(deviceId) {
    return controlList(await this.getJson(`${devicePath(deviceId)}/controls`, true));
  }
  /**
   * One control, used as readback after a write (GET /v1/devices/{deviceId}/controls/{name}?zoneId=).
   *
   * @param deviceId - deviceId from getDevices()
   * @param control - Control name (write path)
   * @param zoneId - Zone of zone-bound controls
   */
  async getControl(deviceId, control, zoneId) {
    const query = zoneId !== void 0 ? `?zoneId=${zoneId}` : "";
    return controlList(
      await this.getJson(`${devicePath(deviceId)}/controls/${controlPath(control)}${query}`, true)
    );
  }
  /**
   * Sends a command (POST /v1/devices/{deviceId}/controls/{name}, answer 204).
   *
   * @param deviceId - deviceId from getDevices()
   * @param control - Control name (write path)
   * @param body - Request body, see docs/api-abgleich.md
   */
  async postControl(deviceId, control, body) {
    var _a;
    const response = await this.send(
      `${devicePath(deviceId)}/controls/${controlPath(control)}`,
      "application/json",
      AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(this.timeoutMs)]),
      body
    );
    await this.checkStatus(response, true);
    await ((_a = response.body) == null ? void 0 : _a.cancel().catch(() => void 0));
  }
  /**
   * Opens the SSE stream of one device (GET /v1/sse/devices/{deviceId}/controls).
   * No timeout here - the stream lives for hours; the caller watches it (see sse.ts).
   *
   * @param deviceId - deviceId from getDevices()
   * @param signal - Aborts the stream
   * @returns The open response, body not yet read
   */
  async openStream(deviceId, signal) {
    const response = await this.send(
      `${devicePath(deviceId, "/v1/sse")}/controls`,
      "text/event-stream",
      AbortSignal.any([this.shutdown.signal, signal])
    );
    await this.checkStatus(response, true);
    return response;
  }
  /** Aborts all running requests, used in onUnload */
  close() {
    this.shutdown.abort();
  }
  /**
   * @param path - Path below the base URL
   * @param devicePath - 404 means "device not reachable" on device paths
   */
  async getJson(path, devicePath2 = false) {
    const response = await this.send(
      path,
      "application/json",
      AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(this.timeoutMs)])
    );
    await this.checkStatus(response, devicePath2);
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new import_errors.ApiError("Invalid JSON in answer", response.status);
    }
  }
  /**
   * fetch with key header; maps low-level failures to NetworkError / AbortedError.
   *
   * @param path - Path below the base URL
   * @param accept - Accept header
   * @param signal - Abort signal (shutdown, timeout, caller)
   * @param body - JSON body - turns the request into a POST
   */
  async send(path, accept, signal, body) {
    if (this.shutdown.signal.aborted) {
      throw new import_errors.AbortedError();
    }
    const headers = { "api-key": this.apiKey, accept };
    if (body !== void 0) {
      headers["content-type"] = "application/json";
    }
    try {
      return await this.fetchFn(`${this.baseUrl}${path}`, {
        method: body === void 0 ? "GET" : "POST",
        headers,
        ...body === void 0 ? {} : { body: JSON.stringify(body) },
        signal
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
  }
  /**
   * Throws the matching error class for every non-2xx answer.
   *
   * @param response - Answer
   * @param devicePath - 404 means "device not reachable" on device paths
   */
  async checkStatus(response, devicePath2) {
    if (response.ok) {
      return;
    }
    const text = await response.text().catch(() => "");
    if (response.status === 401) {
      throw new import_errors.KeyRejectedError();
    }
    if (response.status === 404 && devicePath2) {
      throw new import_errors.DeviceUnreachableError();
    }
    if (response.status === 429) {
      throw new import_errors.RateLimitedError(parseRetryAfter(response.headers.get("retry-after"), Date.now()));
    }
    if (response.status >= 500) {
      throw new import_errors.ServiceUnavailableError(response.status);
    }
    throw new import_errors.ApiError(`HTTP ${response.status}: ${errorMessage(text)}`, response.status);
  }
}
const MAX_RETRY_AFTER_MS = 36e5;
function parseRetryAfter(header, now) {
  const value = header == null ? void 0 : header.trim();
  if (!value) {
    return void 0;
  }
  const ms = /^\d+$/.test(value) ? Number(value) * 1e3 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS) : void 0;
}
function devicePath(deviceId, prefix = "/v1") {
  if (!import_redact.DEVICE_ID_PATTERN.test(deviceId)) {
    throw new import_errors.ApiError("Invalid deviceId format");
  }
  return `${prefix}/devices/${deviceId}`;
}
function controlPath(control) {
  if (!/^[a-z]{1,40}$/.test(control)) {
    throw new import_errors.ApiError("Invalid control name");
  }
  return control;
}
function controlList(body) {
  if (!Array.isArray(body)) {
    throw new import_errors.ApiError("Unexpected answer for controls (no array)");
  }
  return body.filter(
    (entry) => typeof entry === "object" && entry !== null && typeof entry.type === "string"
  );
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
  MAX_RETRY_AFTER_MS,
  normalizeApiKey,
  parseRetryAfter
});
//# sourceMappingURL=client.js.map

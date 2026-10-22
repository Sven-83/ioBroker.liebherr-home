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
var sse_exports = {};
__export(sse_exports, {
  BACKOFF_MAX_MS: () => BACKOFF_MAX_MS,
  BACKOFF_MIN_MS: () => BACKOFF_MIN_MS,
  RATE_LIMIT_MIN_MS: () => RATE_LIMIT_MIN_MS,
  STABLE_MS: () => STABLE_MS,
  SseParser: () => SseParser,
  SseStream: () => SseStream,
  WATCHDOG_MS: () => WATCHDOG_MS
});
module.exports = __toCommonJS(sse_exports);
var import_errors = require("./errors");
const WATCHDOG_MS = 75e3;
const BACKOFF_MIN_MS = 5e3;
const BACKOFF_MAX_MS = 3e5;
const STABLE_MS = 6e4;
const RATE_LIMIT_MIN_MS = 6e4;
const MAX_LINE_LENGTH = 1e6;
class SseParser {
  pending = "";
  event = "";
  data = [];
  /**
   * @param chunk - Decoded text as it arrives
   * @returns Events completed by this chunk
   */
  feed(chunk) {
    this.pending += chunk;
    const events = [];
    let match;
    const lineBreak = /\r\n|\r|\n/g;
    let start = 0;
    while ((match = lineBreak.exec(this.pending)) !== null) {
      if (match[0] === "\r" && match.index === this.pending.length - 1) {
        break;
      }
      const event = this.line(this.pending.slice(start, match.index));
      if (event) {
        events.push(event);
      }
      start = match.index + match[0].length;
    }
    this.pending = this.pending.slice(start);
    if (this.pending.length > MAX_LINE_LENGTH) {
      throw new Error("SSE line too long");
    }
    return events;
  }
  line(line) {
    if (line === "") {
      const event = this.data.length ? { event: this.event || "message", data: this.data.join("\n") } : void 0;
      this.event = "";
      this.data = [];
      return event;
    }
    if (line.startsWith(":")) {
      return void 0;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") {
      this.event = value;
    } else if (field === "data") {
      this.data.push(value);
    }
    return void 0;
  }
}
class SseStream {
  /**
   * @param client - API client (opens the HTTP stream)
   * @param deviceId - deviceId (serial number) - never logged
   * @param label - Name for log messages
   * @param handlers - Callbacks
   * @param log - Logger
   * @param options - Scheduler, clock, random
   */
  constructor(client, deviceId, label, handlers, log, options) {
    this.client = client;
    this.deviceId = deviceId;
    this.label = label;
    this.handlers = handlers;
    this.log = log;
    this.options = options;
    var _a, _b;
    this.now = (_a = options.now) != null ? _a : Date.now;
    this.random = (_b = options.random) != null ? _b : Math.random;
  }
  now;
  random;
  controller;
  watchdog;
  retryTimer;
  backoffMs = BACKOFF_MIN_MS;
  /** Lower bound for the next reconnect (set after HTTP 429, jitter never goes below it) */
  minDelayMs = 0;
  openedAt;
  running = false;
  queue = Promise.resolve();
  /**
   * Opens the stream (no-op if running).
   *
   * @param delayMs - Start delay, spreads the connects of several devices
   */
  start(delayMs = 0) {
    if (this.running) {
      return;
    }
    this.running = true;
    if (delayMs > 0) {
      this.retryTimer = this.options.scheduler.setTimeout(() => void this.connect(), delayMs);
    } else {
      void this.connect();
    }
  }
  /** Closes the stream for good */
  stop() {
    var _a;
    this.running = false;
    this.options.scheduler.clearTimeout(this.retryTimer);
    this.options.scheduler.clearTimeout(this.watchdog);
    (_a = this.controller) == null ? void 0 : _a.abort();
    this.controller = void 0;
  }
  /** Resolves when all received events are processed (for tests) */
  idle() {
    return this.queue;
  }
  async connect() {
    var _a;
    this.retryTimer = void 0;
    if (!this.running) {
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    this.armWatchdog(controller);
    let opened = false;
    try {
      const response = await this.client.openStream(this.deviceId, controller.signal);
      if (!response.body) {
        throw new Error("SSE answer without body");
      }
      opened = true;
      this.openedAt = this.now();
      this.handlers.onOpen(true);
      this.log.debug(`Real-time stream of "${this.label}" open`);
      await this.read(response.body, controller);
      if (this.running) {
        const reason = controller.signal.aborted ? "no data received" : "ended by the server";
        this.log.debug(`Real-time stream of "${this.label}" lost: ${reason}`);
      }
    } catch (error) {
      if (error instanceof import_errors.KeyRejectedError) {
        this.running = false;
        this.handlers.onKeyRejected();
      } else if (error instanceof import_errors.DeviceUnreachableError) {
        this.handlers.onUnreachable();
      } else if (error instanceof import_errors.RateLimitedError) {
        this.minDelayMs = Math.max(RATE_LIMIT_MIN_MS, (_a = error.retryAfterMs) != null ? _a : 0);
        this.log.debug(`Real-time stream of "${this.label}": ${error.message}`);
      } else if (!(error instanceof import_errors.AbortedError) && this.running) {
        const reason = controller.signal.aborted ? "no data received" : (0, import_errors.describeError)(error);
        this.log.debug(`Real-time stream of "${this.label}" lost: ${reason}`);
      }
    } finally {
      this.options.scheduler.clearTimeout(this.watchdog);
      if (this.controller === controller) {
        this.controller = void 0;
      }
      if (opened && this.running) {
        this.handlers.onOpen(false);
      }
    }
    this.scheduleReconnect();
  }
  async read(body, controller) {
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const reader = body.getReader();
    const abort = () => void reader.cancel().catch(() => void 0);
    controller.signal.addEventListener("abort", abort, { once: true });
    try {
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        this.armWatchdog(controller);
        for (const event of parser.feed(decoder.decode(value, { stream: true }))) {
          this.dispatch(event);
        }
      }
    } finally {
      controller.signal.removeEventListener("abort", abort);
    }
  }
  dispatch(event) {
    if (event.event !== "device-update") {
      this.log.debug(`Real-time stream of "${this.label}": ignoring event "${event.event.slice(0, 50)}"`);
      return;
    }
    let controls;
    try {
      controls = JSON.parse(event.data);
    } catch {
      this.log.debug(`Real-time stream of "${this.label}": invalid JSON in event`);
      return;
    }
    if (!Array.isArray(controls)) {
      return;
    }
    this.queue = this.queue.then(() => this.handlers.onControls(controls)).catch((error) => this.log.warn(`Real-time update of "${this.label}" failed: ${(0, import_errors.describeError)(error)}`));
  }
  armWatchdog(controller) {
    this.options.scheduler.clearTimeout(this.watchdog);
    this.watchdog = this.options.scheduler.setTimeout(() => controller.abort(), WATCHDOG_MS);
  }
  scheduleReconnect() {
    if (!this.running) {
      return;
    }
    if (this.openedAt !== void 0 && this.now() - this.openedAt >= STABLE_MS) {
      this.backoffMs = BACKOFF_MIN_MS;
    }
    this.openedAt = void 0;
    const delay = Math.max(Math.round(this.backoffMs * (0.8 + this.random() * 0.4)), this.minDelayMs);
    this.minDelayMs = 0;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    this.retryTimer = this.options.scheduler.setTimeout(() => void this.connect(), delay);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  RATE_LIMIT_MIN_MS,
  STABLE_MS,
  SseParser,
  SseStream,
  WATCHDOG_MS
});
//# sourceMappingURL=sse.js.map

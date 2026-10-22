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
var mapper_exports = {};
__export(mapper_exports, {
  mapControl: () => mapControl
});
module.exports = __toCommonJS(mapper_exports);
const ZONE_POSITIONS = /* @__PURE__ */ new Set(["top", "middle", "bottom"]);
function safeIdPart(value) {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 50);
}
function isInt(value) {
  return typeof value === "number" && Number.isInteger(value);
}
function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function zoneChannel(zoneId, position) {
  const pos = typeof position === "string" && ZONE_POSITIONS.has(position) ? ` (${position})` : "";
  return { id: `zones.${zoneId}`, name: `Zone ${zoneId}${pos}` };
}
const FUNCTIONS_CHANNEL = { id: "functions", name: "Functions" };
const RAW_CHANNEL = { id: "raw", name: "Unknown controls (raw data)" };
function enumState(base, name, native, values, current, role = "level.mode") {
  const value = typeof current === "string" ? current : null;
  const all = value && !values.includes(value) ? [...values, value] : values;
  return {
    id: `${base}.${safeIdPart(name)}`,
    common: {
      name,
      type: "string",
      role,
      read: true,
      write: false,
      states: Object.fromEntries(all.map((v) => [v, v]))
    },
    native,
    value,
    writable: true
  };
}
function mapControl(control) {
  if (typeof control !== "object" || control === null || typeof control.type !== "string") {
    return void 0;
  }
  const name = typeof control.name === "string" && control.name ? control.name : control.type;
  const zoneId = isInt(control.zoneId) && control.zoneId >= 0 ? control.zoneId : void 0;
  const zone = zoneId !== void 0 ? zoneChannel(zoneId, control.zonePosition) : void 0;
  const native = { control: name.toLowerCase(), ...zoneId !== void 0 ? { zoneId } : {} };
  const base = zone ? zone.id : FUNCTIONS_CHANNEL.id;
  const channels = [zone != null ? zone : FUNCTIONS_CHANNEL];
  switch (control.type) {
    case "TemperatureControl": {
      if (!zone) {
        break;
      }
      const unit = control.unit === "\xB0F" ? "\xB0F" : "\xB0C";
      const steps = control.setTemperatureStepsEnabled === true && Array.isArray(control.setTemperatureSteps) ? control.setTemperatureSteps.filter(isInt) : [];
      return {
        channels,
        states: [
          {
            id: `${base}.temperature`,
            common: {
              name: "Temperature",
              type: "number",
              role: "value.temperature",
              unit,
              read: true,
              write: false
            },
            native,
            value: numberOrNull(control.value),
            writable: false
          },
          {
            id: `${base}.setpoint`,
            common: {
              name: "Target temperature",
              type: "number",
              role: "level.temperature",
              unit,
              ...isInt(control.min) ? { min: control.min } : {},
              ...isInt(control.max) ? { max: control.max } : {},
              step: 1,
              read: true,
              write: false
            },
            native: steps.length ? { ...native, steps } : native,
            value: numberOrNull(control.target),
            writable: true
          }
        ]
      };
    }
    case "ToggleControl":
      return {
        channels,
        states: [
          {
            id: `${base}.${safeIdPart(name)}`,
            common: { name, type: "boolean", role: "switch", read: true, write: false },
            native,
            value: typeof control.value === "boolean" ? control.value : null,
            writable: true
          }
        ]
      };
    case "HydroBreezeControl":
      return zone ? {
        channels,
        states: [
          enumState(base, "hydrobreeze", native, ["OFF", "LOW", "MEDIUM", "HIGH"], control.currentMode)
        ]
      } : void 0;
    case "IceMakerControl": {
      if (!zone) {
        break;
      }
      const modes = control.hasMaxIce === true ? ["OFF", "ON", "MAX_ICE"] : ["OFF", "ON"];
      return { channels, states: [enumState(base, "icemaker", native, modes, control.iceMakerMode)] };
    }
    case "BioFreshPlusControl": {
      if (!zone) {
        break;
      }
      const modes = Array.isArray(control.supportedModes) ? control.supportedModes.filter((m) => typeof m === "string") : [];
      return { channels, states: [enumState(base, "biofreshplus", native, modes, control.currentMode)] };
    }
    case "AutoDoorControl":
      if (!zone) {
        break;
      }
      return {
        channels,
        states: [
          {
            ...enumState(base, "autodoor", native, ["CLOSED", "OPEN", "MOVING"], control.value, "value"),
            writable: false
          }
        ]
      };
    case "PresentationLightControl":
      return {
        channels: [FUNCTIONS_CHANNEL],
        states: [
          {
            id: `${FUNCTIONS_CHANNEL.id}.presentationlight`,
            common: {
              name: "Presentation light",
              type: "number",
              role: "level.dimmer",
              min: 0,
              ...isInt(control.max) ? { max: control.max } : {},
              step: 1,
              read: true,
              write: false
            },
            native: { control: "presentationlight" },
            value: numberOrNull(control.value),
            writable: true
          }
        ]
      };
    default:
      break;
  }
  return rawControl(control, name, zoneId);
}
function rawControl(control, name, zoneId) {
  const id = `${RAW_CHANNEL.id}.${safeIdPart(name)}${zoneId !== void 0 ? `_zone${zoneId}` : ""}`;
  return {
    channels: [RAW_CHANNEL],
    states: [
      {
        id,
        common: { name: `${control.type} ${name}`, type: "string", role: "json", read: true, write: false },
        native: { control: name.toLowerCase(), ...zoneId !== void 0 ? { zoneId } : {} },
        value: JSON.stringify(control),
        writable: false
      }
    ],
    unknownType: control.type
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  mapControl
});
//# sourceMappingURL=mapper.js.map

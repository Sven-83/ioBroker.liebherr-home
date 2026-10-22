/*
 * Types of the Liebherr SmartDevice HomeAPI, derived from docs/homeapi-openapi.json.
 * Everything coming from the cloud is still validated by the mapper - these types
 * describe the documented shape, not a guarantee.
 */

/** Device types listed in the spec - the API may add more, so unknown strings are kept */
export type DeviceType = 'FRIDGE' | 'FREEZER' | 'COMBI' | 'WINE' | (string & {});

/** Entry of GET /v1/devices (schema "Device") */
export interface Device {
    /** deviceId = serial number, format 00.000.000.0 - never log or store it */
    deviceId: string;
    /** Name given in the SmartDevice app */
    nickname?: string;
    /** Device type */
    deviceType?: DeviceType;
    /** Product image */
    imageUrl?: string | null;
    /** Model name, e.g. "IRBbi 4170-150 2" */
    deviceName?: string | null;
}

/** Fields shared by all controls (schema "DeviceControl", discriminator "type") */
export interface BaseControl {
    /** Discriminator, e.g. "TemperatureControl" */
    type: string;
    /** Control name, also the write path, e.g. "temperature", "supercool" */
    name?: string;
    /** Zone of zone-bound controls */
    zoneId?: number;
    /** top | middle | bottom */
    zonePosition?: string;
    /** Further fields depending on the type */
    [field: string]: unknown;
}

/** One entry of GET /v1/devices/{deviceId}/controls or of an SSE event */
export type DeviceControl = BaseControl;

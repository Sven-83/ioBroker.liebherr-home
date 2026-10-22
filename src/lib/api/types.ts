/*
 * Types of the Liebherr SmartDevice HomeAPI, derived from docs/homeapi-openapi.json.
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

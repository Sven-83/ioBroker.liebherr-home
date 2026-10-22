/*
 * Keeps secrets out of logs: the API key and Liebherr serial numbers (deviceId).
 */

/** deviceId format of the HomeAPI (= serial number), see docs/api-abgleich.md */
export const DEVICE_ID_PATTERN = /^\d{2}\.\d{3}\.\d{3}\.\d$/;

const SERIAL_IN_TEXT = /(?<![\d.])\d{2}\.\d{3}\.\d{3}\.\d(?![\d.])/g;

/** CR/LF plus the other separators log viewers split on (NEL, LS, PS) */
const LINE_BREAKS = new RegExp(`\r\n|[\r\n${String.fromCharCode(0x85, 0x2028, 0x2029)}]`, 'g');

/**
 * Removes serial numbers and the given secrets (e.g. the API key) from a text.
 *
 * @param text - Text that may contain secrets
 * @param secrets - Literal values to mask, empty values are ignored
 */
export function redact(text: string, secrets: readonly string[] = []): string {
    let result = text;
    for (const secret of secrets) {
        if (secret) {
            result = result.split(secret).join('***');
        }
    }
    return result.replace(SERIAL_IN_TEXT, '**.***.***.*');
}

/**
 * Flattens line breaks of server-supplied strings (nicknames etc.) so they
 * cannot forge log lines (CWE-117).
 *
 * @param value - Value from the cloud
 */
export function stripLineBreaks(value: unknown): string {
    return String(value).replace(LINE_BREAKS, ' ');
}

/**
 * Formats a `BUILD_ID` value from a `Date`. Dashes replace the colons of an
 * ISO timestamp so the value is safe in a filename, a URL, and a shell
 * argument.
 * @module build-id
 */

/**
 * @param {Date} date - The moment to format, interpreted in UTC.
 * @returns {string} `YYYY-MM-DDTHH-MM-SSZ`, for example `2026-08-29T16-49-32Z`.
 */
export function formatBuildId(date) {
    return date.toISOString()
        .replace(/\.\d{3}Z$/, 'Z')
        .replace(/:/g, '-');
}

/**
 * @typedef {Object} CloudflareApiErrorDetail
 * @property {string} [code] - Cloudflare-specific error code.
 * @property {string} [message] - Human-readable error description.
 */

/**
 * Thrown by {@link module:cloudflare-api-client} when Cloudflare rejects a
 * request or returns an unsuccessful API envelope. Carries the HTTP status
 * and the Cloudflare error array as properties, so a caller can branch on
 * `status` rather than matching the message text.
 */
export default class CloudflareApiError extends Error {

    /**
     * @param {string} message - Human-readable error description.
     * @param {Object} options - Error detail.
     * @param {number} options.status - HTTP response status. May be a non-2xx
     *     status, or 200 when Cloudflare's envelope reports `success: false`.
     * @param {CloudflareApiErrorDetail[]} [options.errors] - Cloudflare error
     *     array from the response envelope, copied rather than referenced.
     * @param {string} options.method - HTTP method of the failed request.
     * @param {string} options.url - URL of the failed request.
     * @param {Error} [options.cause] - Underlying cause, forwarded to `Error`.
     */
    constructor(message, options) {
        const {
            status,
            errors = [],
            method,
            url,
            cause,
        } = options ?? {};

        super(message, cause ? { cause } : undefined);

        Object.defineProperties(this, {
            name: {
                enumerable: true,
                value: this.constructor.name,
            },
            code: {
                enumerable: true,
                value: this.constructor.name,
            },
            status: {
                enumerable: true,
                value: status,
            },
            errors: {
                enumerable: true,
                value: [ ...errors ],
            },
            method: {
                enumerable: true,
                value: method,
            },
            url: {
                enumerable: true,
                value: url,
            },
        });
    }
}

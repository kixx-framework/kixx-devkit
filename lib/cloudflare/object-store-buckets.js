import { isNonEmptyString, isPlainObject, isUndefined } from '../vendor/kixx-assert/mod.js';
import UsageError from '../usage-error.js';

/**
 * Reads and validates the R2 buckets declared by one environment's
 * `OBJECT_STORE.buckets` block. Both resource provisioning and binding
 * assembly read buckets through here, so a value one accepts can never be
 * rejected by the other after a bucket was already created.
 * @module object-store-buckets
 */

const JURISDICTIONS = [ 'default', 'eu', 'fedramp' ];

/**
 * @typedef {Object} ObjectStoreBucket
 * @property {string} configPath - Config path of the bucket entry, such as `OBJECT_STORE.buckets.files`.
 * @property {string} bindingName - Worker binding name.
 * @property {string} bucketName - R2 bucket name.
 * @property {string|undefined} jurisdiction - `eu` or `fedramp`, or undefined for the default jurisdiction.
 * @property {string|undefined} locationHint - Location hint used only when the bucket is created.
 * @property {string|undefined} storageClass - Storage class used only when the bucket is created.
 */

/**
 * @param {Object} environmentConfig - One environment's block from `cloudflare-config.js`.
 * @returns {ObjectStoreBucket[]} Declared buckets in configuration order; empty without an `OBJECT_STORE` block.
 * @throws {UsageError} When a bucket entry is malformed, naming its config path.
 */
export function readObjectStoreBuckets(environmentConfig) {
    const block = environmentConfig.OBJECT_STORE;

    if (!block) {
        return [];
    }

    const buckets = block.buckets ?? {};

    return Object.keys(buckets).map((key) => {
        const configPath = `OBJECT_STORE.buckets.${ key }`;
        const bucket = buckets[key];

        if (!isPlainObject(bucket)) {
            throw new UsageError(`${ configPath } must be an object`);
        }

        const jurisdiction = readOptionalString(bucket.jurisdiction, `${ configPath }.jurisdiction`);

        if (!isUndefined(jurisdiction) && !JURISDICTIONS.includes(jurisdiction)) {
            throw new UsageError(
                `${ configPath }.jurisdiction must be one of: ${ JURISDICTIONS.join(', ') }`,
            );
        }

        return {
            configPath,
            bindingName: requireString(bucket.bindingName, `${ configPath }.bindingName`),
            bucketName: requireString(bucket.bucketName, `${ configPath }.bucketName`),
            // "default" is normalized away so it produces the same binding,
            // and so the same bindings hash, as omitting the key.
            jurisdiction: jurisdiction === 'default' ? undefined : jurisdiction,
            // Cloudflare owns these vocabularies and validates them on create.
            locationHint: readOptionalString(bucket.locationHint, `${ configPath }.locationHint`),
            storageClass: readOptionalString(bucket.storageClass, `${ configPath }.storageClass`),
        };
    });
}

function requireString(value, path) {
    if (!isNonEmptyString(value)) {
        throw new UsageError(`${ path } is required and must be a non-empty string`);
    }

    return value;
}

function readOptionalString(value, path) {
    if (isUndefined(value)) {
        return undefined;
    }

    if (!isNonEmptyString(value)) {
        throw new UsageError(`${ path } must be a non-empty string when present`);
    }

    return value;
}

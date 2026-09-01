/**
 * Authenticated client for the Kixx Publishing API.
 * @module publishing-api-client
 */

import {
    assert,
    assertArray,
    assertNonEmptyString,
    isFunction,
    isObjectNotNull,
    isUndefined,
} from 'kixx-assert';

import { getBlobSize } from './addressing.js';
import PublishingApiError, { createPublishingApiError } from './publishing-api-error.js';

const JSON_API_CONTENT_TYPE = 'application/vnd.api+json';
const MAX_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 100;
const RETRY_STATUSES = new Set([ 429 ]);

/**
 * Sends Publishing API requests to one application environment.
 */
export default class PublishingAPIClient {

    #baseUrl;
    #token;
    #fetch;
    #wait;
    #random;

    /**
     * @param {Object} options - Client configuration
     * @param {string} options.origin - Published application's origin
     * @param {string} options.token - Publishing bearer token
     * @param {typeof fetch} [options.fetch] - Fetch implementation
     * @param {(milliseconds: number) => Promise<void>} [options.wait] - Retry wait implementation
     * @param {() => number} [options.random] - Retry jitter source
     */
    constructor(options) {
        const {
            origin,
            token,
            fetch: fetchImpl = fetch,
            wait = delay,
            random = Math.random,
        } = options ?? {};

        assertNonEmptyString(origin);
        assertNonEmptyString(token);
        assert(isFunction(fetchImpl), 'PublishingAPIClient() requires a fetch function');
        assert(isFunction(wait), 'PublishingAPIClient() requires a wait function');
        assert(isFunction(random), 'PublishingAPIClient() requires a random function');

        this.#baseUrl = new URL('/publishing-api/v1/', origin);
        this.#token = token;
        this.#fetch = fetchImpl;
        this.#wait = wait;
        this.#random = random;
    }

    /**
     * Retrieves the server's publishing capabilities without making a write.
     * @returns {Promise<Object>} Discovery attributes and enforced limits
     */
    async discover() {
        const response = await this.#request('');
        return response.data.attributes;
    }

    /**
     * Reports stored objects in a deduplicated set of requested ids.
     * @param {string[]} objectIds - Object ids to check
     * @param {Object} options - Server-discovered limits
     * @param {number} options.maxObjectStatusIds - Maximum ids per request
     * @returns {Promise<Array<{objectId: string, size: number}>>} Stored objects in server order
     */
    async getObjectStatus(objectIds, options) {
        const { maxObjectStatusIds } = options ?? {};

        assertArray(objectIds);
        assert(
            Number.isInteger(maxObjectStatusIds) && maxObjectStatusIds > 0,
            'getObjectStatus() requires a positive maxObjectStatusIds limit',
        );

        const uniqueIds = [ ...new Set(objectIds) ];
        const storedObjects = [];

        for (let index = 0; index < uniqueIds.length; index += maxObjectStatusIds) {
            const batch = uniqueIds.slice(index, index + maxObjectStatusIds);
            const response = await this.#postJsonApi('objects/status', 'ObjectStatus', {
                objectIds: batch,
            });

            assertArray(response.data, 'Publishing API ObjectStatus response data');
            storedObjects.push(...response.data.map((resource) => ({
                objectId: resource.id,
                size: resource.attributes.size,
            })));
        }

        return storedObjects;
    }

    /**
     * Uploads one content-addressed object as raw bytes.
     * @param {string} objectId - Expected content address
     * @param {string|ArrayBuffer} body - Object bytes
     * @param {Object} options - Server-discovered limits
     * @param {number} options.maxObjectBytes - Maximum object size
     * @returns {Promise<{objectId: string, size: number, created: boolean}>} Stored object result
     */
    async uploadObject(objectId, body, options) {
        const { maxObjectBytes } = options ?? {};

        assertNonEmptyString(objectId);
        assert(
            Number.isInteger(maxObjectBytes) && maxObjectBytes > 0,
            'uploadObject() requires a positive maxObjectBytes limit',
        );

        const size = getBlobSize(body);
        assert(size > 0, 'uploadObject() body must not be empty');
        assert(
            size <= maxObjectBytes,
            `uploadObject() body is ${ size } bytes; server limit is ${ maxObjectBytes } bytes`,
        );

        const response = await this.#request(`objects/${ encodeURIComponent(objectId) }`, {
            method: 'PUT',
            body,
        });

        return {
            objectId: response.data.id,
            size: response.data.attributes.size,
            created: response.status === 201,
        };
    }

    /**
     * Creates and fully verifies an immutable Release.
     * @param {Object} manifest - Complete Release manifest
     * @param {Object} [provenance] - Non-binding source metadata
     * @returns {Promise<Object>} Created or existing Release record
     */
    async createRelease(manifest, provenance) {
        const attributes = { manifest };
        if (!isUndefined(provenance)) {
            attributes.provenance = provenance;
        }
        const response = await this.#postJsonApi('releases', 'Release', attributes);
        return releaseRecord(response.data);
    }

    /**
     * Verifies a manifest without persisting a Release or inline content.
     * @param {Object} manifest - Complete Release manifest using stored objects
     * @returns {Promise<Object>} Release validation result
     */
    async validateRelease(manifest) {
        assert(!hasInlineContent(manifest), 'validateRelease() does not accept inline content');

        const response = await this.#postJsonApi('releases/validation', 'Release', { manifest });
        return {
            releaseId: response.data.id,
            ...response.data.attributes,
        };
    }

    /**
     * Lists Release history using stable cursor pagination.
     * @param {Object} [options] - Pagination options
     * @param {number} [options.limit] - Maximum records to return
     * @param {string} [options.cursor] - Cursor from a prior page
     * @returns {Promise<{releases: Object[], cursor: ?string}>} Release page
     */
    async listReleases(options) {
        const response = await this.#request(withPagination('releases', options));
        assertArray(response.data, 'Publishing API Release list data');
        return {
            releases: response.data.map(releaseRecord),
            cursor: response.meta?.cursor ?? null,
        };
    }

    /**
     * Gets one immutable Release record.
     * @param {string} releaseId - Release content address
     * @returns {Promise<Object>} Release record
     */
    async getRelease(releaseId) {
        assertNonEmptyString(releaseId);
        const response = await this.#request(`releases/${ encodeURIComponent(releaseId) }`);
        return releaseRecord(response.data);
    }

    /**
     * Gets one Release's complete manifest.
     * @param {string} releaseId - Release content address
     * @returns {Promise<Object>} Complete stored manifest
     */
    async getReleaseManifest(releaseId) {
        assertNonEmptyString(releaseId);
        const response = await this.#request(
            `releases/${ encodeURIComponent(releaseId) }/manifest`,
        );
        return response.data.attributes.manifest;
    }

    /**
     * Lists every registered build pointer.
     * @returns {Promise<Object[]>} Build pointer records
     */
    async listBuilds() {
        const response = await this.#request('builds');
        assertArray(response.data, 'Publishing API Build list data');
        return response.data.map(buildRecord);
    }

    /**
     * Gets one authoritative build pointer and its assignment precondition.
     * @param {string} buildId - Build pointer id
     * @returns {Promise<Object>} Build pointer record including its ETag
     */
    async getBuild(buildId) {
        assertNonEmptyString(buildId);
        const response = await this.#request(`builds/${ encodeURIComponent(buildId) }`);
        return {
            ...buildRecord(response.data),
            etag: response.etag,
        };
    }

    /**
     * Assigns a Release to a build under exactly one pointer precondition.
     * @param {string} buildId - Build pointer id
     * @param {string} releaseId - Release to assign
     * @param {Object} options - Assignment options
     * @param {string} [options.ifMatch] - Current quoted build ETag
     * @param {string} [options.ifNoneMatch] - `*` for a never-assigned build
     * @param {string} [options.reason=publish] - Assignment audit reason
     * @returns {Promise<Object>} Resulting build pointer record including its ETag
     */
    async assignBuild(buildId, releaseId, options) {
        const {
            ifMatch,
            ifNoneMatch,
            reason = 'publish',
        } = options ?? {};
        const hasIfMatch = !isUndefined(ifMatch);
        const hasIfNoneMatch = !isUndefined(ifNoneMatch);

        assertNonEmptyString(buildId);
        assertNonEmptyString(releaseId);
        assert(
            hasIfMatch !== hasIfNoneMatch,
            'assignBuild() requires exactly one of ifMatch or ifNoneMatch',
        );
        if (hasIfMatch) {
            assertNonEmptyString(ifMatch);
        } else {
            assert(ifNoneMatch === '*', 'assignBuild() ifNoneMatch must be *');
        }

        const headers = hasIfMatch
            ? { 'if-match': ifMatch }
            : { 'if-none-match': ifNoneMatch };
        const response = await this.#request(`builds/${ encodeURIComponent(buildId) }`, {
            method: 'PUT',
            headers: {
                ...headers,
                'content-type': JSON_API_CONTENT_TYPE,
            },
            body: JSON.stringify({
                data: {
                    type: 'Build',
                    id: buildId,
                    attributes: { releaseId, reason },
                },
            }),
        });

        return {
            ...buildRecord(response.data),
            etag: response.etag,
        };
    }

    /**
     * Lists successful assignments for one build.
     * @param {string} buildId - Build pointer id
     * @param {Object} [options] - Pagination options
     * @param {number} [options.limit] - Maximum records to return
     * @param {string} [options.cursor] - Cursor from a prior page
     * @returns {Promise<{activations: Object[], cursor: ?string}>} Activation page
     */
    async getBuildActivations(buildId, options) {
        assertNonEmptyString(buildId);
        const endpoint = `builds/${ encodeURIComponent(buildId) }/activations`;
        const response = await this.#request(withPagination(endpoint, options));
        assertArray(response.data, 'Publishing API Activation list data');
        return {
            activations: response.data.map((resource) => ({
                activationId: resource.id,
                ...resource.attributes,
            })),
            cursor: response.meta?.cursor ?? null,
        };
    }

    async #postJsonApi(endpoint, type, attributes) {
        return await this.#request(endpoint, {
            method: 'POST',
            body: JSON.stringify({
                data: {
                    type,
                    attributes,
                },
            }),
            headers: {
                'content-type': JSON_API_CONTENT_TYPE,
            },
        });
    }

    async #request(endpoint, options) {
        const init = options ?? {};
        const method = init.method ?? 'GET';
        const url = new URL(endpoint, this.#baseUrl);
        const headers = {
            authorization: `Bearer ${ this.#token }`,
            ...init.headers,
        };

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
            let response;

            try {
                response = await this.#fetch(url, { ...init, method, headers });
            } catch {
                if (attempt < MAX_ATTEMPTS) {
                    await this.#waitBeforeRetry(attempt);
                    continue;
                }

                throw new PublishingApiError(
                    `Publishing API network request failed after ${ attempt } attempts: ${ method } ${ url.href }`,
                    { status: null, method, url: url.href, attempts: attempt },
                );
            }

            if (isRetryableStatus(response.status) && attempt < MAX_ATTEMPTS) {
                await this.#waitBeforeRetry(attempt);
                continue;
            }

            return await this.#readResponse(response, { method, url, attempt });
        }
    }

    async #waitBeforeRetry(attempt) {
        const exponentialDelay = RETRY_BASE_DELAY_MS * (2 ** (attempt - 1));
        const jitteredDelay = exponentialDelay * (0.5 + this.#random());
        await this.#wait(jitteredDelay);
    }

    async #readResponse(response, request) {
        const { method, url, attempt } = request;
        const text = await response.text();
        const document = parseJson(text);

        if (!response.ok) {
            const errors = redactErrors(
                Array.isArray(document?.errors) ? document.errors : [],
                this.#token,
            );
            const message = this.#formatFailure(response.status, method, url, errors, text);

            throw createPublishingApiError(message, {
                status: response.status,
                errors,
                method,
                url: url.href,
                attempts: attempt,
            });
        }

        if (!document?.data) {
            throw new PublishingApiError(
                `Publishing API returned an invalid JSON:API document from ${ method } ${ url.href }`,
                { status: response.status, method, url: url.href, attempts: attempt },
            );
        }

        return {
            data: document.data,
            meta: document.meta,
            status: response.status,
            etag: response.headers?.get?.('etag') ?? null,
        };
    }

    #formatFailure(status, method, url, errors, text) {
        let message = `Publishing API returned HTTP ${ status } from ${ method } ${ url.href }`;

        if (status === 401 || status === 403) {
            message += '\nCheck .kixx/secrets.json at app.environments.<environment>.publishingToken.';
        }

        if (errors.length > 0) {
            message += `\n${ errors.map(formatJsonApiError).join('\n') }`;
        } else if (text) {
            message += `\n${ text }`;
        }

        return redact(message, this.#token);
    }
}

function releaseRecord(resource) {
    return {
        releaseId: resource.id,
        ...resource.attributes,
    };
}

function buildRecord(resource) {
    return {
        buildId: resource.id,
        ...resource.attributes,
    };
}

function withPagination(endpoint, options) {
    const { limit, cursor } = options ?? {};
    const url = new URL(endpoint, 'https://publishing.invalid/');

    if (!isUndefined(limit)) {
        url.searchParams.set('limit', String(limit));
    }
    if (!isUndefined(cursor)) {
        url.searchParams.set('cursor', cursor);
    }

    return `${ url.pathname.replace(/^\//, '') }${ url.search }`;
}

function hasInlineContent(value) {
    if (!isObjectNotNull(value)) {
        return false;
    }
    if (Object.hasOwn(value, 'content')) {
        return true;
    }
    return Object.values(value).some(hasInlineContent);
}

function isRetryableStatus(status) {
    return RETRY_STATUSES.has(status) || status >= 500;
}

function formatJsonApiError(error, index) {
    const parts = [ `Error ${ index + 1 }:` ];

    if (error.status) {
        parts.push(`status ${ error.status }`);
    }
    if (error.code) {
        parts.push(`code ${ error.code }`);
    }
    if (error.detail) {
        parts.push(error.detail);
    }
    if (error.source) {
        parts.push(`source ${ JSON.stringify(error.source) }`);
    }

    return parts.join(' ');
}

function parseJson(text) {
    if (!text) {
        return null;
    }

    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function redact(message, secret) {
    return message.split(secret).join('[redacted]');
}

function redactErrors(errors, secret) {
    return errors.map((error) => {
        return JSON.parse(redact(JSON.stringify(error), secret));
    });
}

function delay(milliseconds) {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

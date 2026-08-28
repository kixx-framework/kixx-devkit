import {
    assert,
    assertNonEmptyString,
    isPlainObject,
    isString,
    isUndefined,
} from 'kixx-assert';

const BASE_URL = 'https://api.cloudflare.com/client/v4';

/**
 * Node.js client for Cloudflare account APIs used by project tooling.
 * @module CloudflareAPIClient
 */

/**
 * @typedef {Object} KVWriteBatchItem
 * @property {string} key - Key name to write.
 * @property {string} value - UTF-8 encoded value to store.
 * @property {boolean} [base64] - Whether Cloudflare should base64 decode the value before storing it.
 * @property {number} [expiration] - UNIX epoch timestamp when the key expires.
 * @property {number} [expiration_ttl] - Number of seconds until the key expires. Must be at least 60.
 * @property {*} [metadata] - Arbitrary JSON metadata associated with the key.
 */


/**
 * Authenticated Cloudflare API client for project deployment tooling.
 */
export default class CloudflareAPIClient {

    #accountId;
    #apiToken;

    /**
     * @param {Object} options - Client configuration.
     * @param {string} options.accountId - Cloudflare account identifier.
     * @param {string} options.apiToken - Cloudflare API token sent as a Bearer token.
     * @throws {AssertionError} When accountId or apiToken is not a non-empty string.
     */
    constructor(options) {
        const {
            accountId,
            apiToken,
        } = options ?? {};

        assertNonEmptyString(accountId);
        assertNonEmptyString(apiToken);

        this.#accountId = accountId;
        this.#apiToken = apiToken;
    }

    async createWorker(payload) {
        assert(isPlainObject(payload), 'CloudflareAPIClient#createWorker() requires a payload');
        assertNonEmptyString(payload.name, 'CloudflareAPIClient#createWorker() requires a payload.name');
        const url = new URL(`${ BASE_URL }/accounts/${ this.#accountId }/workers/workers`);
        const method = 'POST';
        const headers = {
            'content-type': 'application/json',
        };

        return await this.#fetchResult(url, {
            method,
            headers,
            body: JSON.stringify(payload),
        });
    }

    /**
     * Retrieves Worker metadata and dependency references from Cloudflare.
     *
     * @param {string} workerId - Worker ID or Worker name accepted by Cloudflare's get Worker endpoint.
     * @returns {Promise<Object>} Resolves to the unwrapped Cloudflare Worker result.
     * @throws {Error} When Cloudflare returns a non-2xx HTTP response or an unsuccessful API envelope.
     */
    async getWorker(workerId) {
        assertNonEmptyString(workerId, 'CloudflareAPIClient#getWorker() requires a workerId');
        const url = new URL(`${ BASE_URL }/accounts/${ this.#accountId }/workers/workers/${ workerId }`);
        const method = 'GET';

        return await this.#fetchResult(url, { method });
    }

    async updateWorker(workerId, payload) {
        assertNonEmptyString(workerId, 'CloudflareAPIClient#updateWorker() requires a workerId');
        assert(isPlainObject(payload), 'CloudflareAPIClient#updateWorker() requires a payload');
        const url = new URL(`${ BASE_URL }/accounts/${ this.#accountId }/workers/workers/${ workerId }`);
        const method = 'PUT';
        const headers = {
            'content-type': 'application/json',
        };

        return await this.#fetchResult(url, {
            method,
            headers,
            body: JSON.stringify(payload),
        });
    }

    /**
     * Lists the most recent versions of a Worker (first page, default page size).
     *
     * @param {string} workerId - Worker ID or Worker name accepted by Cloudflare's list Versions endpoint.
     * @param {object} [options]
     * @param {number} [options.page=1] - Page number to fetch.
     * @param {number} [options.per_page=3] - Number of versions per page.
     * @returns {Promise<Array>} Resolves to the unwrapped array of Worker version objects.
     * @throws {Error} When Cloudflare returns a non-2xx HTTP response or an unsuccessful API envelope.
     */
    async listWorkerVersions(workerId, options) {
        assertNonEmptyString(workerId, 'CloudflareAPIClient#listWorkerVersions() requires a workerId');
        const { page = 1, per_page = 3 } = options ?? {};
        const url = new URL(`${ BASE_URL }/accounts/${ this.#accountId }/workers/workers/${ workerId }/versions`);
        url.searchParams.set('page', String(page));
        url.searchParams.set('per_page', String(per_page));
        const method = 'GET';

        return await this.#fetchResult(url, { method });
    }

    /**
     * Retrieves one version of a Worker from Cloudflare.
     *
     * @see https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/get
     *
     * @param {string} workerId - Worker ID or Worker name accepted by Cloudflare's get Version endpoint.
     * @param {string} versionId - Version identifier to retrieve.
     * @returns {Promise<Object>} Resolves to the unwrapped Worker version object.
     * @throws {Error} When Cloudflare returns a non-2xx HTTP response or an unsuccessful API envelope.
     */
    async getWorkerVersion(workerId, versionId) {
        assertNonEmptyString(workerId, 'CloudflareAPIClient#getWorkerVersion() requires a workerId');
        assertNonEmptyString(versionId, 'CloudflareAPIClient#getWorkerVersion() requires a versionId');
        const url = new URL(
            `${ BASE_URL }/accounts/${ this.#accountId }/workers/workers/${ workerId }/versions/${ versionId }`,
        );
        const method = 'GET';

        return await this.#fetchResult(url, { method });
    }

    /**
     * Creates a Worker version from the supplied module, binding, and runtime metadata.
     *
     * @see https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/subresources/versions/methods/create
     *
     * @param {string} workerName - Worker name accepted by Cloudflare's create Version endpoint.
     * @param {Object} version - Version metadata and module payload to send to Cloudflare.
     * @param {Object} [options] - Additional request options.
     * @param {boolean} [options.deploy] - Create a deployment from this version which routes 100% of traffic to the new version.
     * @returns {Promise<Object>} Resolves to the unwrapped Cloudflare Worker version result.
     * @throws {Error} When Cloudflare returns a non-2xx HTTP response or an unsuccessful API envelope.
     */
    async createWorkerVersion(workerName, version, options) {
        assertNonEmptyString(workerName, 'createWorkerVersion() workerName is required');
        const url = new URL(`${ BASE_URL }/accounts/${ this.#accountId }/workers/workers/${ workerName }/versions`);
        const method = 'POST';
        const headers = {
            'content-type': 'application/json',
        };

        if (!isUndefined(options?.deploy)) {
            url.searchParams.set('deploy', String(options.deploy));
        }

        return await this.#fetchResult(url, {
            method,
            headers,
            body: JSON.stringify(version),
        });
    }

    /**
     * Creates a new deployment for existing worker versions
     *
     * @see https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create
     *
     * @param {string} workerName - Worker name accepted by Cloudflare's create Version endpoint.
     * @param {Object} deployment - Deployment versions and annotations to send to Cloudflare.
     * @param {Object} [options] - Additional request options.
     * @param {boolean} [options.force] - If set to true, the deployment will be created even if normally blocked by something such rolling back to an older version when a secret has changed.
     * @returns {Promise<Object>} Resolves to the unwrapped Cloudflare Deployment result.
     */
    async createDeployment(workerName, deployment, options) {
        assertNonEmptyString(workerName, 'CloudflareAPIClient#createDeployment() requires a workerName');
        assert(
            isPlainObject(deployment),
            'CloudflareAPIClient#createDeployment() requires a deployment',
        );
        const url = new URL(`${ BASE_URL }/accounts/${ this.#accountId }/workers/scripts/${ workerName }/deployments`);
        const method = 'POST';
        const headers = {
            'content-type': 'application/json',
        };

        if (!isUndefined(options?.force)) {
            url.searchParams.set('force', String(options.force));
        }

        return await this.#fetchResult(url, {
            method,
            headers,
            body: JSON.stringify(deployment),
        });
    }

    /**
     * Executes one parameterized SQL query against a D1 database.
     *
     * @see https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query
     *
     * @param {string} databaseId - D1 database identifier.
     * @param {Object} query - Query definition.
     * @param {string} query.sql - SQL statement to execute.
     * @param {string[]} [query.params] - Ordered string parameters bound to the statement.
     * @returns {Promise<Array>} Resolves to the unwrapped D1 result array.
     * @throws {AssertionError} When databaseId or query is malformed.
     * @throws {Error} When Cloudflare returns a non-2xx HTTP response, an unsuccessful
     *     API envelope, a non-array D1 result, or an explicitly unsuccessful result entry.
     */
    async queryD1Database(databaseId, query) {
        assertNonEmptyString(databaseId, 'CloudflareAPIClient#queryD1Database() requires a databaseId');
        assert(isPlainObject(query), 'CloudflareAPIClient#queryD1Database() requires a query');
        assertNonEmptyString(query.sql, 'CloudflareAPIClient#queryD1Database() requires a query.sql');

        const { params = [] } = query;
        assert(Array.isArray(params), 'CloudflareAPIClient#queryD1Database() query.params must be an array');
        params.forEach((param, index) => {
            assert(
                isString(param),
                `CloudflareAPIClient#queryD1Database() query.params[${ index }] must be a string`,
            );
        });

        const url = new URL(`${ BASE_URL }/accounts/${ this.#accountId }/d1/database/${ databaseId }/query`);
        const method = 'POST';
        const headers = {
            'content-type': 'application/json',
        };

        const result = await this.#fetchResult(url, {
            method,
            headers,
            body: JSON.stringify({ sql: query.sql, params }),
        });

        assert(Array.isArray(result), `Expected D1 query result array from ${ method } ${ url.href }`);

        // The documented `success` field is optional per result entry; only an
        // explicit false marks a statement as failed.
        const failed = result.find((entry) => isPlainObject(entry) && entry.success === false);
        if (failed) {
            throw new Error(`Unsuccessful D1 query result from ${ method } ${ url.href }`);
        }

        return result;
    }

    /**
     * Sends an authenticated request and unwraps the Cloudflare API envelope.
     * @param {URL} url - Cloudflare API URL to request.
     * @param {RequestInit} init - Fetch request options.
     * @returns {Promise<Object|Array>} Resolves to the response result when the API call succeeds.
     * @throws {Error} When Cloudflare returns a non-2xx HTTP response or an unsuccessful API envelope.
     */
    async #fetchResult(url, init) {
        const method = init.method || 'GET';
        const headers = {
            authorization: `Bearer ${ this.#apiToken }`,
            ...init.headers,
        };

        const res = await fetch(url, { ...init, method, headers });

        if (!res.ok) {
            const text = await res.text();
            const details = text ? `: ${ text }` : '';
            throw new Error(
                `Unexpected HTTP status ${ res.status } from ${ method } ${ url.href }${ details }`,
            );
        }

        const { success, errors, messages, result } = await res.json();

        if (success) {
            return result;
        }

        let message = 'No error message provided';
        if (Array.isArray(errors) && errors.length > 0) {
            message = errors[0].message || message;
        }
        if (message === 'No error message provided' &&
            Array.isArray(messages) && messages.length > 0) {
            message = messages[0].message || message;
        }

        throw new Error(`API error "${ message }" from ${ method } ${ url.href }`);
    }
}

/**
 * Cloudflare account API client used by project tooling.
 * @module cloudflare-api-client
 */

import {
    assert,
    assertNonEmptyString,
    isBoolean,
    isPlainObject,
    isString,
    isUndefined,
} from 'kixx-assert';

const BASE_URL = 'https://api.cloudflare.com/client/v4';

/**
 * Sends authenticated requests to the Cloudflare Workers and D1 APIs.
 */
export default class CloudflareAPIClient {

    #accountId;
    #apiToken;

    /**
     * @param {Object} options - Client configuration
     * @param {string} options.accountId - Cloudflare account identifier
     * @param {string} options.apiToken - Cloudflare API token sent as a Bearer token
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

    /**
     * Creates a Worker from the supplied configuration.
     * @param {Object} payload - Worker configuration accepted by Cloudflare
     * @param {string} payload.name - Worker name
     * @returns {Promise<Object>} Created Worker result
     * @throws {Error} When Cloudflare rejects the request or returns an unsuccessful API envelope
     */
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
     * @param {string} workerId - Worker ID or name
     * @returns {Promise<Object>} Unwrapped Cloudflare Worker result
     * @throws {Error} When Cloudflare rejects the request or returns an unsuccessful API envelope
     */
    async getWorker(workerId) {
        assertNonEmptyString(workerId, 'CloudflareAPIClient#getWorker() requires a workerId');
        const url = new URL(`${ BASE_URL }/accounts/${ this.#accountId }/workers/workers/${ workerId }`);
        const method = 'GET';

        return await this.#fetchResult(url, { method });
    }

    /**
     * Replaces a Worker's configuration.
     * @param {string} workerId - Worker ID or name
     * @param {Object} payload - Replacement Worker configuration accepted by Cloudflare
     * @returns {Promise<Object>} Updated Worker result
     * @throws {Error} When Cloudflare rejects the request or returns an unsuccessful API envelope
     */
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
     * Lists a page of versions for a Worker.
     *
     * @param {string} workerId - Worker ID or name
     * @param {Object} [options] - Pagination options
     * @param {number} [options.page=1] - Page number to fetch
     * @param {number} [options.per_page=3] - Number of versions per page
     * @returns {Promise<Array<Object>>} Unwrapped Worker version results
     * @throws {Error} When Cloudflare rejects the request or returns an unsuccessful API envelope
     */
    async listWorkerVersions(workerId, options) {
        assertNonEmptyString(workerId, 'CloudflareAPIClient#listWorkerVersions() requires a workerId');
        assert(
            isUndefined(options) || isPlainObject(options),
            'CloudflareAPIClient#listWorkerVersions() options must be an object',
        );
        const { page = 1, per_page = 3 } = options ?? {};
        assert(
            Number.isInteger(page) && page > 0,
            'CloudflareAPIClient#listWorkerVersions() options.page must be a positive integer',
        );
        assert(
            Number.isInteger(per_page) && per_page > 0,
            'CloudflareAPIClient#listWorkerVersions() options.per_page must be a positive integer',
        );
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
     * @param {string} workerId - Worker ID or name
     * @param {string} versionId - Version identifier
     * @returns {Promise<Object>} Unwrapped Worker version result
     * @throws {Error} When Cloudflare rejects the request or returns an unsuccessful API envelope
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
     * @param {string} workerName - Worker name
     * @param {Object} version - Version metadata and module payload accepted by Cloudflare
     * @param {Object} [options] - Request options
     * @param {boolean} [options.deploy] - Whether to route all traffic to the new version
     * @returns {Promise<Object>} Created Worker version result
     * @throws {Error} When Cloudflare rejects the request or returns an unsuccessful API envelope
     */
    async createWorkerVersion(workerName, version, options) {
        assertNonEmptyString(workerName, 'CloudflareAPIClient#createWorkerVersion() requires a workerName');
        assert(isPlainObject(version), 'CloudflareAPIClient#createWorkerVersion() requires a version');
        assert(
            isUndefined(options) || isPlainObject(options),
            'CloudflareAPIClient#createWorkerVersion() options must be an object',
        );
        assert(
            isUndefined(options?.deploy) || isBoolean(options.deploy),
            'CloudflareAPIClient#createWorkerVersion() options.deploy must be a boolean',
        );
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
     * Creates a deployment for existing Worker versions.
     *
     * @see https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create
     *
     * @param {string} workerName - Worker name
     * @param {Object} deployment - Deployment versions and annotations accepted by Cloudflare
     * @param {Object} [options] - Request options
     * @param {boolean} [options.force] - Whether to bypass deployment safety checks
     * @returns {Promise<Object>} Created deployment result
     * @throws {Error} When Cloudflare rejects the request or returns an unsuccessful API envelope
     */
    async createDeployment(workerName, deployment, options) {
        assertNonEmptyString(workerName, 'CloudflareAPIClient#createDeployment() requires a workerName');
        assert(
            isPlainObject(deployment),
            'CloudflareAPIClient#createDeployment() requires a deployment',
        );
        assert(
            isUndefined(options) || isPlainObject(options),
            'CloudflareAPIClient#createDeployment() options must be an object',
        );
        assert(
            isUndefined(options?.force) || isBoolean(options.force),
            'CloudflareAPIClient#createDeployment() options.force must be a boolean',
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
     * Retrieves a D1 database from Cloudflare.
     *
     * @see https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/get
     *
     * @param {string} databaseId - D1 database identifier
     * @returns {Promise<Object>} Unwrapped D1 database result
     * @throws {Error} When Cloudflare rejects the request or returns an unsuccessful API envelope
     */
    async getD1Database(databaseId) {
        assertNonEmptyString(databaseId, 'CloudflareAPIClient#getD1Database() requires a databaseId');
        const url = new URL(`${ BASE_URL }/accounts/${ this.#accountId }/d1/database/${ databaseId }`);
        const method = 'GET';

        return await this.#fetchResult(url, { method });
    }

    /**
     * Creates a D1 database from the supplied configuration.
     *
     * @see https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/create
     *
     * @param {Object} payload - D1 database configuration accepted by Cloudflare
     * @param {string} payload.name - D1 database name
     * @returns {Promise<Object>} Created D1 database result
     * @throws {Error} When Cloudflare rejects the request or returns an unsuccessful API envelope
     */
    async createD1Database(payload) {
        assert(isPlainObject(payload), 'CloudflareAPIClient#createD1Database() requires a payload');
        assertNonEmptyString(payload.name, 'CloudflareAPIClient#createD1Database() requires a payload.name');
        const url = new URL(`${ BASE_URL }/accounts/${ this.#accountId }/d1/database`);
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
     * Executes one parameterized SQL query against a D1 database.
     *
     * @see https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query
     *
     * @param {string} databaseId - D1 database identifier
     * @param {Object} query - Query definition
     * @param {string} query.sql - SQL statement to execute
     * @param {string[]} [query.params=[]] - Ordered string parameters bound to the statement
     * @returns {Promise<Array<Object>>} Unwrapped D1 statement results
     * @throws {Error} When Cloudflare returns a non-2xx HTTP response, an unsuccessful
     *     API envelope, a non-array D1 result, or an explicitly unsuccessful result entry
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
     * Sends an authenticated request and unwraps its API envelope.
     * @param {URL} url - Cloudflare API URL
     * @param {RequestInit} init - Fetch request options
     * @returns {Promise<*>} Unwrapped result from a successful API envelope
     * @throws {Error} When Cloudflare rejects the request or returns an unsuccessful API envelope
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

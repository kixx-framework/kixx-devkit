/**
 * Authenticated client for the Kixx Publishing API.
 * @module publishing-api-client
 */

import {
    assert,
    assertNonEmptyString,
    isFunction,
} from 'kixx-assert';

import PublishingApiError from './publishing-api-error.js';

const JSON_API_CONTENT_TYPE = 'application/vnd.api+json';
const MAX_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 100;
const RETRY_STATUSES = new Set([ 429 ]);

/**
 * Sends stat, upload, and closure requests to one application environment.
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

    async statStaticAsset(pathname) {
        return await this.#stat(`index/static-asset/${ encodePath(pathname) }`);
    }

    async statGlobalTemplatePartials() {
        return await this.#stat('index/global-template-partials');
    }

    async statBaseTemplates() {
        return await this.#stat('index/base-templates');
    }

    async statPageMetadata(pathname) {
        return await this.#stat(optionalPath('index/page-metadata', pathname));
    }

    async statPagePartials(pathname) {
        return await this.#stat(optionalPath('index/page-partials', pathname));
    }

    async statPageIncludes(pathname) {
        return await this.#stat(optionalPath('index/page-includes', pathname));
    }

    async statPageTemplate(pathname) {
        return await this.#stat(`index/page-templates/${ encodePath(pathname) }`);
    }

    async statEmailAssets(pathname) {
        return await this.#stat(`index/emails/${ encodePath(pathname) }`);
    }

    async uploadStaticAsset(pathname, payload) {
        return await this.#put(`resources/static-asset/${ encodePath(pathname) }`, payload);
    }

    async uploadGlobalTemplatePartials(bundle) {
        return await this.#putJsonApi('resources/global-template-partials', 'GlobalTemplatePartials', { bundle });
    }

    async uploadBaseTemplates(bundle) {
        return await this.#putJsonApi('resources/base-templates', 'BaseTemplates', { bundle });
    }

    async uploadPageMetadata(pathname, metadata) {
        return await this.#putJsonApi(optionalPath('resources/page-metadata', pathname), 'PageMetadata', metadata);
    }

    async uploadPagePartials(pathname, bundle) {
        return await this.#putJsonApi(optionalPath('resources/page-partials', pathname), 'PagePartials', { bundle });
    }

    async uploadPageIncludes(pathname, bundle) {
        return await this.#putJsonApi(optionalPath('resources/page-includes', pathname), 'PageIncludes', { bundle });
    }

    async uploadPageTemplate(pathname, source) {
        return await this.#put(`resources/page-templates/${ encodePath(pathname) }`, source, {
            'content-type': 'text/plain',
        });
    }

    async uploadEmailAssets(pathname, bundle) {
        return await this.#putJsonApi(`resources/emails/${ encodePath(pathname) }`, 'EmailAssets', bundle);
    }

    async commitClosure(buildId, contentTree) {
        assertNonEmptyString(buildId);

        return await this.#putJsonApi('index/closure', 'ContentTree', {
            buildId,
            ...contentTree,
        });
    }

    async #stat(endpoint) {
        return await this.#request(endpoint, { method: 'GET', isStat: true });
    }

    async #put(endpoint, body, headers) {
        return await this.#request(endpoint, {
            method: 'PUT',
            headers,
            body,
        });
    }

    async #putJsonApi(endpoint, type, attributes) {
        return await this.#put(endpoint, JSON.stringify({
            data: {
                type,
                attributes,
            },
        }), {
            'content-type': JSON_API_CONTENT_TYPE,
        });
    }

    async #request(endpoint, options) {
        const { isStat = false, ...init } = options;
        const method = init.method ?? 'GET';
        const url = new URL(endpoint, this.#baseUrl);
        const headers = {
            authorization: `Bearer ${ this.#token }`,
            ...init.headers,
        };

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
            let response;

            try {
                response = await this.#fetch(url, { ...init, headers });
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

            if (isStat && response.status === 404) {
                return null;
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

            throw new PublishingApiError(message, {
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

        return document.data.attributes;
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

function optionalPath(endpoint, pathname) {
    const encoded = encodePath(pathname);
    return encoded ? `${ endpoint }/${ encoded }` : `${ endpoint }/`;
}

function encodePath(pathname) {
    return pathname
        .replace(/^\/+/, '')
        .split('/')
        .filter(Boolean)
        .map(encodeURIComponent)
        .join('/');
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

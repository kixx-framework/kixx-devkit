/**
 * Publishes a validated content-source scan as one atomic content closure.
 * @module publish-content
 */

import path from 'node:path';

import {
    assert,
    assertArray,
    assertNonEmptyString,
} from 'kixx-assert';

import { assertPublishableContentSources } from './content-source-report.js';

const MAX_CONCURRENCY = 6;

const RESOURCE_METHODS = {
    StaticAsset: [ 'statStaticAsset', 'uploadStaticAsset' ],
    GlobalTemplatePartials: [ 'statGlobalTemplatePartials', 'uploadGlobalTemplatePartials' ],
    BaseTemplates: [ 'statBaseTemplates', 'uploadBaseTemplates' ],
    PageMetadata: [ 'statPageMetadata', 'uploadPageMetadata' ],
    PagePartials: [ 'statPagePartials', 'uploadPagePartials' ],
    PageIncludes: [ 'statPageIncludes', 'uploadPageIncludes' ],
    PageTemplate: [ 'statPageTemplate', 'uploadPageTemplate' ],
    EmailAssets: [ 'statEmailAssets', 'uploadEmailAssets' ],
};

/**
 * A publish failure enriched with the last known pipeline state.
 */
export class PublishContentError extends Error {

    /**
     * @param {string} message - Operator-facing failure description
     * @param {Object} options - Failure details
     * @param {string} options.phase - Pipeline phase that failed
     * @param {Object} options.result - Partial publish result
     * @param {Error} options.cause - Underlying failure
     */
    constructor(message, options) {
        const { phase, result, cause } = options ?? {};

        super(message, { cause });

        Object.defineProperties(this, {
            name: {
                enumerable: true,
                value: this.constructor.name,
            },
            code: {
                enumerable: true,
                value: this.constructor.name,
            },
            phase: {
                enumerable: true,
                value: phase,
            },
            result: {
                enumerable: true,
                value: result,
            },
        });
    }
}

/**
 * Diffs and publishes one scanned source tree under a build id.
 * @param {Object} args - Publish inputs and options
 * @param {Object} args.client - Publishing API client
 * @param {string} args.buildId - Build pointer to assign on commit
 * @param {Object} args.contentSources - Result from `scanContentSources()`
 * @param {boolean} [args.bootstrap=false] - Seed an empty closure and upload every resource
 * @param {boolean} [args.dryRun=false] - Report the diff without making writes
 * @returns {Promise<Object>} Structured diff and commit result
 * @throws {UsageError} When scanned content contains validation problems
 * @throws {PublishContentError} When a Publishing API phase fails
 */
export default async function publishContent(args) {
    const {
        client,
        buildId,
        contentSources,
        bootstrap = false,
        dryRun = false,
    } = args ?? {};

    assert(client, 'publishContent() requires a Publishing API client');
    assertNonEmptyString(buildId, 'publishContent() buildId');
    assert(contentSources, 'publishContent() requires scanned content sources');
    assertArray(contentSources.resources, 'publishContent() contentSources.resources');
    assertPublishableContentSources(contentSources);

    const result = makeInitialResult(buildId, contentSources, { bootstrap, dryRun });

    if (bootstrap && !dryRun) {
        try {
            await client.commitClosure(buildId, makeContentTree([]));
            result.bootstrapped = true;
        } catch (cause) {
            throw makePublishError('bootstrap', cause, result);
        }
    }

    let diff;
    try {
        diff = bootstrap
            ? contentSources.resources.map((resource) => ({ resource, reference: null }))
            : await mapWithConcurrency(contentSources.resources, statResource);
    } catch (cause) {
        throw makePublishError('stat', cause, result);
    }

    const pending = diff.filter(({ resource, reference }) => {
        return !reference || reference.hash !== resource.hash;
    });
    const matched = diff.filter(({ resource, reference }) => {
        return reference && reference.hash === resource.hash;
    });

    result.matchedCount = matched.length;
    result.uploadedCount = pending.length;
    result.uploadedResources = pending.map(({ resource }) => summarizeResource(resource));
    result.resources = diff.map(({ resource, reference }) => ({
        ...summarizeResource(resource),
        disposition: reference && reference.hash === resource.hash ? 'matched' : 'uploaded',
    }));

    if (dryRun) {
        return result;
    }

    let uploaded;
    try {
        uploaded = await mapWithConcurrency(pending, async ({ resource }) => {
            const reference = await uploadResource(resource);
            result.completedUploadCount += 1;
            return { resource, reference };
        });
    } catch (cause) {
        throw makePublishError('upload', cause, result);
    }

    const references = [ ...matched, ...uploaded ];
    const contentTree = makeContentTree(references);
    let closure;

    try {
        closure = await client.commitClosure(buildId, contentTree);
    } catch (cause) {
        throw makePublishError('commit', cause, result);
    }

    result.committed = true;
    result.closureHash = closure.hash;
    result.nodeCount = closure.nodeCount;

    return result;

    async function statResource(resource) {
        const [ statMethod ] = getResourceMethods(resource);
        const args = resource.pathname === '/'
            && (resource.type === 'GlobalTemplatePartials' || resource.type === 'BaseTemplates')
            ? []
            : [ resource.pathname ];
        const reference = await client[statMethod](...args);
        return { resource, reference };
    }

    async function uploadResource(resource) {
        const [ , uploadMethod ] = getResourceMethods(resource);
        const args = resource.pathname === '/'
            && (resource.type === 'GlobalTemplatePartials' || resource.type === 'BaseTemplates')
            ? [ resource.payload ]
            : [ resource.pathname, resource.payload ];
        return await client[uploadMethod](...args);
    }
}

function makeInitialResult(buildId, contentSources, options) {
    const { bootstrap, dryRun } = options;

    return {
        buildId,
        dryRun,
        bootstrap,
        bootstrapped: false,
        committed: false,
        matchedCount: 0,
        uploadedCount: 0,
        completedUploadCount: 0,
        uploadedResources: [],
        resources: [],
        unmatchedFiles: [ ...contentSources.unmatchedFiles ],
        closureHash: null,
        nodeCount: null,
    };
}

function getResourceMethods(resource) {
    const methods = RESOURCE_METHODS[resource.type];
    assert(methods, `Unsupported publishing resource type: ${ resource.type }`);
    return methods;
}

function summarizeResource(resource) {
    return {
        type: resource.type,
        pathname: resource.pathname,
        hash: resource.hash,
        size: resource.size,
    };
}

function makeContentTree(entries) {
    const tree = {
        staticAssets: {},
        pages: {},
        emails: {},
    };

    for (const { resource, reference } of entries) {
        const contentReference = {
            hash: reference.hash,
            size: reference.size,
        };

        switch (resource.type) {
            case 'StaticAsset':
                tree.staticAssets[resource.pathname] = contentReference;
                break;
            case 'GlobalTemplatePartials':
                tree.globalTemplatePartials = contentReference;
                break;
            case 'BaseTemplates':
                tree.baseTemplates = contentReference;
                break;
            case 'PageMetadata':
                getPage(tree, resource.pathname).metadata = contentReference;
                break;
            case 'PagePartials':
                getPage(tree, resource.pathname).partials = contentReference;
                break;
            case 'PageIncludes':
                getPage(tree, resource.pathname).includes = contentReference;
                break;
            case 'PageTemplate': {
                const pagePathname = path.posix.dirname(resource.pathname);
                getPage(tree, pagePathname).template = {
                    pathname: resource.pathname,
                    ...contentReference,
                };
                break;
            }
            case 'EmailAssets':
                tree.emails[resource.pathname] = contentReference;
                break;
        }
    }

    return tree;
}

function getPage(tree, pathname) {
    if (!tree.pages[pathname]) {
        tree.pages[pathname] = {};
    }
    return tree.pages[pathname];
}

async function mapWithConcurrency(items, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    let firstError = null;

    const worker = async () => {
        while (!firstError && nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;

            try {
                results[index] = await mapper(items[index], index);
            } catch (error) {
                firstError ??= error;
            }
        }
    };

    const workers = Array.from(
        { length: Math.min(MAX_CONCURRENCY, items.length) },
        () => worker(),
    );
    await Promise.all(workers);

    if (firstError) {
        throw firstError;
    }

    return results;
}

function makePublishError(phase, cause, result) {
    const prefix = `Content publish failed during the ${ phase } phase: ${ cause.message }`;
    let consequence;

    if (phase === 'stat') {
        consequence = 'Nothing was published and the existing content closure was not changed. ' +
            'If this build has no content closure, rerun with --bootstrap.';
    } else if (result.bootstrapped) {
        consequence = 'The empty bootstrap closure was committed, but the final content closure was not. ' +
            'Any uploaded blobs remain unreferenced and inert.';
    } else if (phase === 'commit') {
        consequence = 'The Publishing API did not confirm the closure commit. Any uploaded blobs are safe to retry.';
    } else {
        consequence = 'No content closure was committed, so existing published content is unchanged. ' +
            'Any uploaded blobs remain unreferenced and inert.';
    }

    return new PublishContentError(`${ prefix }\n${ consequence }`, {
        phase,
        result: { ...result },
        cause,
    });
}

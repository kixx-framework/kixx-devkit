import { describe } from 'kixx-test';
import {
    assert,
    assertEqual,
    assertMatches,
} from 'kixx-assert';

import publishContent from '../../../../lib/publishing/publish-content.js';


describe('publishing/publish-content', ({ it }) => {
    it('commits every unchanged resource without uploading it', async () => {
        const resources = makeAllResourceTypes();
        const stats = new Map(resources.map((resource) => [
            resourceKey(resource.type, resource.pathname),
            { hash: resource.hash, size: resource.size + 100 },
        ]));
        const client = makeClient({ stats });

        const result = await publishContent(makeArgs(client, resources));

        assertEqual(resources.length, result.matchedCount);
        assertEqual(0, result.uploadedCount);
        assertEqual(0, client.calls.filter(({ operation }) => operation === 'upload').length);
        assertEqual(1, client.closures.length);
        assertEqual('closure-hash-1', result.closureHash);
        assertEqual(resources.length, result.nodeCount);

        const tree = client.closures[0].contentTree;
        assertEqual(101, tree.staticAssets['site.css'].size);
        assertEqual('global-hash', tree.globalTemplatePartials.hash);
        assertEqual('base-hash', tree.baseTemplates.hash);
        assertEqual('metadata-hash', tree.pages['/about'].metadata.hash);
        assertEqual('partials-hash', tree.pages['/about'].partials.hash);
        assertEqual('includes-hash', tree.pages['/about'].includes.hash);
        assertEqual('/about/page.html', tree.pages['/about'].template.pathname);
        assertEqual('template-hash', tree.pages['/about'].template.hash);
        assertEqual('email-hash', tree.emails['/welcome'].hash);
    });

    it('uploads only changed resources and commits server-returned references', async () => {
        const unchanged = makeResource('StaticAsset', 'one.css', 'one-hash');
        const changed = makeResource('StaticAsset', 'two.css', 'two-hash');
        const stats = new Map([
            [ resourceKey(unchanged.type, unchanged.pathname), { hash: unchanged.hash, size: 10 } ],
            [ resourceKey(changed.type, changed.pathname), { hash: 'old-hash', size: 20 } ],
        ]);
        const uploadReferences = new Map([
            [ resourceKey(changed.type, changed.pathname), { hash: changed.hash, size: 42 } ],
        ]);
        const client = makeClient({ stats, uploadReferences });

        const result = await publishContent(makeArgs(client, [ unchanged, changed ]));

        assertEqual(1, result.matchedCount);
        assertEqual(1, result.uploadedCount);
        assertEqual(1, result.completedUploadCount);
        assertEqual('two.css', result.uploadedResources[0].pathname);
        assertEqual(1, client.calls.filter(({ operation }) => operation === 'upload').length);
        assertEqual(10, client.closures[0].contentTree.staticAssets['one.css'].size);
        assertEqual(42, client.closures[0].contentTree.staticAssets['two.css'].size);
    });

    it('bootstraps an empty closure, skips stats, and uploads everything', async () => {
        const resources = [
            makeResource('StaticAsset', 'one.css', 'one-hash'),
            makeResource('PageMetadata', '/', 'metadata-hash'),
        ];
        const client = makeClient();

        const result = await publishContent({
            ...makeArgs(client, resources),
            bootstrap: true,
        });

        assert(result.bootstrapped);
        assertEqual(0, client.calls.filter(({ operation }) => operation === 'stat').length);
        assertEqual(2, client.calls.filter(({ operation }) => operation === 'upload').length);
        assertEqual(2, client.closures.length);
        assertEqual('{"staticAssets":{},"pages":{},"emails":{}}', JSON.stringify(client.closures[0].contentTree));
        assertEqual('one-hash', client.closures[1].contentTree.staticAssets['one.css'].hash);
        assertEqual('metadata-hash', client.closures[1].contentTree.pages['/'].metadata.hash);
    });

    it('reports the ordinary diff in a dry run without making writes', async () => {
        const matched = makeResource('StaticAsset', 'same.css', 'same-hash');
        const pending = makeResource('StaticAsset', 'changed.css', 'changed-hash');
        const stats = new Map([
            [ resourceKey(matched.type, matched.pathname), { hash: matched.hash, size: matched.size } ],
            [ resourceKey(pending.type, pending.pathname), null ],
        ]);
        const dryClient = makeClient({ stats });
        const liveClient = makeClient({ stats });

        const dryResult = await publishContent({
            ...makeArgs(dryClient, [ matched, pending ]),
            dryRun: true,
        });
        const liveResult = await publishContent(makeArgs(liveClient, [ matched, pending ]));

        assert(dryResult.dryRun);
        assertEqual(liveResult.matchedCount, dryResult.matchedCount);
        assertEqual(liveResult.uploadedCount, dryResult.uploadedCount);
        assertEqual(
            JSON.stringify(liveResult.uploadedResources),
            JSON.stringify(dryResult.uploadedResources),
        );
        assertEqual(0, dryClient.calls.filter(({ operation }) => operation === 'upload').length);
        assertEqual(0, dryClient.closures.length);
    });

    it('waits for in-flight uploads and prevents a closure commit after failure', async () => {
        const resources = [
            makeResource('StaticAsset', 'one.css', 'one-hash'),
            makeResource('StaticAsset', 'two.css', 'two-hash'),
        ];
        const client = makeClient({
            failUploadKey: resourceKey('StaticAsset', 'one.css'),
            uploadDelay: 2,
        });

        const caught = await catchAsyncError(() => publishContent(makeArgs(client, resources)));

        assertEqual('PublishContentError', caught.name);
        assertEqual('upload', caught.phase);
        assertMatches('existing published content is unchanged', caught.message);
        assertMatches('unreferenced and inert', caught.message);
        assertEqual(0, client.closures.length);
        assertEqual(0, client.activeUploads);
    });

    it('names bootstrap when the stat phase cannot open a build', async () => {
        const resource = makeResource('StaticAsset', 'one.css', 'one-hash');
        const client = makeClient({ failStat: true });

        const caught = await catchAsyncError(() => publishContent(makeArgs(client, [ resource ])));

        assertEqual('stat', caught.phase);
        assertMatches('--bootstrap', caught.message);
        assertMatches('Nothing was published', caught.message);
        assertEqual(0, client.closures.length);
    });

    it('limits both stat and upload concurrency to six requests', async () => {
        const resources = Array.from({ length: 17 }, (_value, index) => {
            return makeResource('StaticAsset', `asset-${ index }.css`, `hash-${ index }`);
        });
        const client = makeClient({ statDelay: 2, uploadDelay: 2 });

        await publishContent(makeArgs(client, resources));

        assertEqual(6, client.maxActiveStats);
        assertEqual(6, client.maxActiveUploads);
    });
});

function makeArgs(client, resources) {
    return {
        client,
        buildId: 'build-id',
        contentSources: {
            resources,
            unmatchedFiles: [ 'templates/README.md' ],
            problems: [],
        },
    };
}

function makeAllResourceTypes() {
    return [
        makeResource('StaticAsset', 'site.css', 'static-hash'),
        makeResource('GlobalTemplatePartials', '/', 'global-hash', []),
        makeResource('BaseTemplates', '/', 'base-hash', []),
        makeResource('PageMetadata', '/about', 'metadata-hash', {}),
        makeResource('PagePartials', '/about', 'partials-hash', []),
        makeResource('PageIncludes', '/about', 'includes-hash', {}),
        makeResource('PageTemplate', '/about/page.html', 'template-hash', '<main></main>'),
        makeResource('EmailAssets', '/welcome', 'email-hash', {}),
    ];
}

function makeResource(type, pathname, hash, payload = 'payload') {
    return {
        type,
        pathname,
        payload,
        hash,
        size: 1,
        sourceFiles: [],
    };
}

function makeClient(options) {
    const {
        stats = new Map(),
        uploadReferences = new Map(),
        failStat = false,
        failUploadKey = null,
        statDelay = 0,
        uploadDelay = 0,
    } = options ?? {};
    const client = {
        calls: [],
        closures: [],
        activeStats: 0,
        activeUploads: 0,
        maxActiveStats: 0,
        maxActiveUploads: 0,
        async commitClosure(buildId, contentTree) {
            this.closures.push({ buildId, contentTree });
            const nodeCount = countTreeReferences(contentTree);
            return { hash: `closure-hash-${ this.closures.length }`, nodeCount };
        },
    };
    const types = [
        [ 'StaticAsset', 'statStaticAsset', 'uploadStaticAsset' ],
        [ 'GlobalTemplatePartials', 'statGlobalTemplatePartials', 'uploadGlobalTemplatePartials' ],
        [ 'BaseTemplates', 'statBaseTemplates', 'uploadBaseTemplates' ],
        [ 'PageMetadata', 'statPageMetadata', 'uploadPageMetadata' ],
        [ 'PagePartials', 'statPagePartials', 'uploadPagePartials' ],
        [ 'PageIncludes', 'statPageIncludes', 'uploadPageIncludes' ],
        [ 'PageTemplate', 'statPageTemplate', 'uploadPageTemplate' ],
        [ 'EmailAssets', 'statEmailAssets', 'uploadEmailAssets' ],
    ];

    for (const [ type, statMethod, uploadMethod ] of types) {
        client[statMethod] = async function stat(pathname = '/') {
            const key = resourceKey(type, pathname);
            this.calls.push({ operation: 'stat', type, pathname });
            this.activeStats += 1;
            this.maxActiveStats = Math.max(this.maxActiveStats, this.activeStats);
            await delay(statDelay);
            this.activeStats -= 1;

            if (failStat) {
                throw new Error('No registered content index for BUILD_ID build-id');
            }

            return stats.has(key) ? stats.get(key) : null;
        };
        client[uploadMethod] = async function upload(pathname, payload) {
            if (type === 'GlobalTemplatePartials' || type === 'BaseTemplates') {
                payload = pathname;
                pathname = '/';
            }

            const key = resourceKey(type, pathname);
            this.calls.push({ operation: 'upload', type, pathname, payload });
            this.activeUploads += 1;
            this.maxActiveUploads = Math.max(this.maxActiveUploads, this.activeUploads);
            await delay(uploadDelay);
            this.activeUploads -= 1;

            if (key === failUploadKey) {
                throw new Error(`Upload failed for ${ pathname }`);
            }

            return uploadReferences.get(key) ?? {
                hash: findResourceHash(key, type),
                size: 1,
            };
        };
    }

    return client;

    function findResourceHash(key, type) {
        const call = client.calls.findLast((entry) => {
            return entry.operation === 'upload' && resourceKey(entry.type, entry.pathname) === key;
        });
        const matchingHash = /asset-(\d+)\.css$/.exec(call.pathname);

        if (matchingHash) {
            return `hash-${ matchingHash[1] }`;
        }
        if (call.pathname === 'one.css') {
            return 'one-hash';
        }
        if (call.pathname === 'two.css') {
            return 'two-hash';
        }
        if (call.pathname === '/') {
            return type === 'PageMetadata' ? 'metadata-hash' : `${ type }-hash`;
        }

        return `${ call.pathname }-hash`;
    }
}

function resourceKey(type, pathname) {
    return `${ type }:${ pathname }`;
}

function countTreeReferences(tree) {
    let count = Object.keys(tree.staticAssets).length + Object.keys(tree.emails).length;
    count += tree.globalTemplatePartials ? 1 : 0;
    count += tree.baseTemplates ? 1 : 0;

    for (const page of Object.values(tree.pages)) {
        count += Object.keys(page).length;
    }

    return count;
}

async function delay(milliseconds) {
    await new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

async function catchAsyncError(fn) {
    try {
        await fn();
    } catch (error) {
        return error;
    }
    return null;
}

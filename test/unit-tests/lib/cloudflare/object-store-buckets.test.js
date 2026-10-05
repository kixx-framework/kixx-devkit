import { describe } from 'kixx-test';
import { assert, assertEqual, assertUndefined } from '../../../../lib/vendor/kixx-assert/mod.js';
import { readObjectStoreBuckets } from '../../../../lib/cloudflare/object-store-buckets.js';

describe('object-store-buckets', ({ it }) => {
    it('returns an empty list without an OBJECT_STORE block', () => {
        assertEqual(0, readObjectStoreBuckets({}).length);
    });

    it('reads every bucket with its config path and creation options', () => {
        const [ bucket ] = readObjectStoreBuckets(makeConfig({
            jurisdiction: 'eu',
            locationHint: 'weur',
            storageClass: 'InfrequentAccess',
        }));

        assertEqual('OBJECT_STORE.buckets.files', bucket.configPath);
        assertEqual('OBJECT_STORE_FILES', bucket.bindingName);
        assertEqual('example-files', bucket.bucketName);
        assertEqual('eu', bucket.jurisdiction);
        assertEqual('weur', bucket.locationHint);
        assertEqual('InfrequentAccess', bucket.storageClass);
    });

    it('treats an explicit default jurisdiction the same as none', () => {
        const [ explicit ] = readObjectStoreBuckets(makeConfig({ jurisdiction: 'default' }));
        const [ omitted ] = readObjectStoreBuckets(makeConfig({}));

        assertUndefined(explicit.jurisdiction);
        assertUndefined(omitted.jurisdiction);
    });

    it('rejects an unknown jurisdiction naming its config path', () => {
        const caught = catchError(() => readObjectStoreBuckets(makeConfig({ jurisdiction: 'us' })));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('OBJECT_STORE.buckets.files.jurisdiction'), caught.message);
        assert(caught.message.includes('fedramp'), 'expected the allowed values');
    });

    it('rejects an empty optional string naming its config path', () => {
        const caught = catchError(() => readObjectStoreBuckets(makeConfig({ locationHint: '' })));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('OBJECT_STORE.buckets.files.locationHint'), caught.message);
    });

    it('rejects a missing bucket name naming its config path', () => {
        const config = makeConfig({});
        delete config.OBJECT_STORE.buckets.files.bucketName;

        const caught = catchError(() => readObjectStoreBuckets(config));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('OBJECT_STORE.buckets.files.bucketName'), caught.message);
    });
});

function makeConfig(options) {
    return {
        OBJECT_STORE: {
            type: 'r2_bucket',
            buckets: {
                files: {
                    bindingName: 'OBJECT_STORE_FILES',
                    bucketName: 'example-files',
                    ...options,
                },
            },
        },
    };
}

function catchError(fn) {
    try {
        fn();
    } catch (error) {
        return error;
    }
    return null;
}

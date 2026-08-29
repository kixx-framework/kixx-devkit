import { describe } from 'kixx-test';
import {
    assert,
    assertEqual,
    assertMatches,
    assertUndefined,
} from 'kixx-assert';
import CloudflareWorkerVersion from '../../../../lib/cloudflare/cloudflare-worker-version.js';


describe('CloudflareWorkerVersion', ({ describe }) => {

    describe('constructor validation', ({ it }) => {
        it('rejects malformed scalar configuration', () => {
            const calls = [
                [ { annotations: 'nope' }, 'annotations must be an object' ],
                [ { annotations: { 'workers/nope': 'x' } }, 'does not support the key' ],
                [ { annotations: { 'workers/tag': '' } }, 'must be a non-empty string' ],
                [ { compatibility_date: '01-01-2025' }, 'must be formatted YYYY-MM-DD' ],
                [ { compatibility_flags: 'nodejs_compat' }, 'compatibility_flags must be an array' ],
                [ { compatibility_flags: [ '' ] }, 'compatibility_flags[0] must be a non-empty string' ],
                [ { placement: {} }, 'placement requires one of' ],
                [ { placement: { mode: 'smart', typo: 1 } }, 'does not support the key "typo"' ],
                [ { cache_options: {} }, 'cache_options.enabled must be a boolean' ],
                [ { cache_options: { enabled: true, cross_version_cache: 'yes' } }, 'must be a boolean' ],
                [ { limits: {} }, 'limits requires one of' ],
                [ { limits: { cpu_ms: '50' } }, 'limits.cpu_ms must be a positive integer' ],
                [ { limits: { cpu_ms: 50.5 } }, 'limits.cpu_ms must be a positive integer' ],
                [ { limits: { subrequests: 0 } }, 'limits.subrequests must be a positive integer' ],
            ];

            for (const [ options, message ] of calls) {
                const caught = catchError(() => new CloudflareWorkerVersion(options));

                assert(caught, `expected ${ JSON.stringify(options) } to be rejected`);
                assertMatches(message, caught.message);
            }
        });

        it('accepts a full UTC timestamp as a compatibility date', () => {
            const version = makeVersion({ compatibility_date: '2021-01-01T00:00:00Z' });

            assertEqual('2021-01-01T00:00:00Z', version.toJSON().compatibility_date);
        });

        it('rejects an annotation exceeding its byte limit', () => {
            const caught = catchError(() => {
                return new CloudflareWorkerVersion({
                    annotations: { 'workers/message': 'a'.repeat(1001) },
                });
            });

            assert(caught, 'expected an over-long message to be rejected');
            assertMatches('must not exceed 1000 bytes', caught.message);
        });

        it('measures annotation limits in bytes, not characters', () => {
            // 400 four-byte characters is 1600 bytes but only 800 UTF-16 units,
            // so a length-based check would let this through.
            const caught = catchError(() => {
                return new CloudflareWorkerVersion({
                    annotations: { 'workers/message': '𝄞'.repeat(400) },
                });
            });

            assert(caught, 'expected a multi-byte message over the limit to be rejected');
            assertMatches('must not exceed 1000 bytes', caught.message);
        });

        it('does not police the compatibility flag vocabulary', () => {
            const version = makeVersion({ compatibility_flags: [ 'some_unreleased_flag' ] });

            assertEqual('some_unreleased_flag', version.toJSON().compatibility_flags[0]);
        });

        it('emits every supplied scalar field', () => {
            const version = makeVersion({
                annotations: {
                    'workers/message': 'Deploy the thing',
                    'workers/tag': 'abc123',
                    'workers/triggered_by': 'ci',
                },
                compatibility_date: '2025-01-01',
                compatibility_flags: [ 'nodejs_compat' ],
                placement: { mode: 'smart' },
                cache_options: { enabled: true, cross_version_cache: false },
                limits: { cpu_ms: 50, subrequests: 100 },
            });

            const payload = version.toJSON();

            assertEqual('Deploy the thing', payload.annotations['workers/message']);
            assertEqual('ci', payload.annotations['workers/triggered_by']);
            assertEqual('2025-01-01', payload.compatibility_date);
            assertEqual('nodejs_compat', payload.compatibility_flags[0]);
            assertEqual('smart', payload.placement.mode);
            assertEqual(true, payload.cache_options.enabled);

            // false is meaningful for cross_version_cache and must survive.
            assertEqual(false, payload.cache_options.cross_version_cache);
            assertEqual(50, payload.limits.cpu_ms);
            assertEqual(100, payload.limits.subrequests);
        });

        it('omits scalar fields that were not supplied', () => {
            const payload = makeVersion().toJSON();

            assertUndefined(payload.annotations);
            assertUndefined(payload.compatibility_date);
            assertUndefined(payload.compatibility_flags);
            assertUndefined(payload.placement);
            assertUndefined(payload.cache_options);
            assertUndefined(payload.limits);
            assertUndefined(payload.bindings);
            assertUndefined(payload.migrations);
        });
    });

    describe('addBinding()', ({ it }) => {
        it('builds each supported binding type', () => {
            const version = makeVersion();

            version.addBinding({ type: 'd1', name: 'DB', id: 'd1-id' });
            version.addBinding({ type: 'durable_object_namespace', name: 'DO', class_name: 'Counter' });
            version.addBinding({ type: 'kv_namespace', name: 'CACHE', namespace_id: 'kv-id' });
            version.addBinding({ type: 'plain_text', name: 'ENV', text: 'production' });
            version.addBinding({ type: 'r2_bucket', name: 'MEDIA', bucket_name: 'media' });
            version.addBinding({ type: 'secret_text', name: 'TOKEN', text: 'sekret' });
            version.addBinding({ type: 'version_metadata', name: 'META' });

            const { bindings } = version.toJSON();

            assertEqual(7, bindings.length);
            assertEqual('d1-id', bindings[0].id);
            assertEqual('Counter', bindings[1].class_name);
            assertEqual('kv-id', bindings[2].namespace_id);
            assertEqual('production', bindings[3].text);
            assertEqual('media', bindings[4].bucket_name);
            assertEqual('sekret', bindings[5].text);
            assertEqual('version_metadata', bindings[6].type);
            assertEqual('META', bindings[6].name);
        });

        it('rejects an unsupported binding type and names the supported ones', () => {
            const caught = catchError(() => makeVersion().addBinding({ type: 'ai', name: 'AI' }));

            assert(caught, 'expected an unsupported type to be rejected');
            assertMatches('unsupported binding type "ai"', caught.message);
            assertMatches('kv_namespace', caught.message);
        });

        it('rejects a missing required field', () => {
            const calls = [
                [ { type: 'd1', name: 'DB' }, 'requires the id field' ],
                [ { type: 'durable_object_namespace', name: 'DO' }, 'requires the class_name field' ],
                [ { type: 'kv_namespace', name: 'CACHE' }, 'requires the namespace_id field' ],
                [ { type: 'r2_bucket', name: 'MEDIA' }, 'requires the bucket_name field' ],
                [ { type: 'plain_text', name: 'ENV' }, 'requires the text field as a string' ],
                [ { type: 'secret_text', name: 'TOKEN' }, 'requires the text field as a string' ],
                [ { type: 'kv_namespace', name: 'CACHE', 'namespace-id': 'x' }, 'requires the namespace_id field' ],
                [ {}, 'requires a binding.type' ],
                [ { type: 'plain_text' }, 'requires a binding.name' ],
            ];

            for (const [ binding, message ] of calls) {
                const caught = catchError(() => makeVersion().addBinding(binding));

                assert(caught, `expected ${ JSON.stringify(binding) } to be rejected`);
                assertMatches(message, caught.message);
            }
        });

        it('accepts an empty string for a text field but not for an id field', () => {
            const version = makeVersion();

            version.addBinding({ type: 'plain_text', name: 'EMPTY', text: '' });
            assertEqual('', version.toJSON().bindings[0].text);

            const caught = catchError(() => {
                return version.addBinding({ type: 'kv_namespace', name: 'CACHE', namespace_id: '' });
            });

            assert(caught, 'expected an empty namespace_id to be rejected');
            assertMatches('requires the namespace_id field', caught.message);
        });

        it('drops fields not documented for the binding type', () => {
            const version = makeVersion();

            version.addBinding({
                type: 'kv_namespace',
                name: 'CACHE',
                namespace_id: 'kv-id',
                experimental: true,
            });

            const binding = version.toJSON().bindings[0];

            assertUndefined(binding.experimental);
            assertEqual(3, Object.keys(binding).length);
        });

        it('rejects a duplicate binding name at the call site', () => {
            const version = makeVersion();

            version.addBinding({ type: 'plain_text', name: 'ENV', text: 'a' });

            const caught = catchError(() => {
                return version.addBinding({ type: 'plain_text', name: 'ENV', text: 'b' });
            });

            assert(caught, 'expected a duplicate binding name to be rejected');
            assertMatches('duplicate binding name "ENV"', caught.message);
        });
    });

    describe('addModule()', ({ it }) => {
        it('base64 encodes string content and infers the module content type', () => {
            const version = new CloudflareWorkerVersion();

            version.addModule({ name: 'index.js', content: 'export default {};', main: true });

            const [ mod ] = version.toJSON().modules;

            assertEqual('index.js', mod.name);
            assertEqual('application/javascript+module', mod.content_type);
            assertEqual('export default {};', decodeBase64(mod.content_base64));
        });

        it('encodes Uint8Array content', () => {
            const version = new CloudflareWorkerVersion();
            const bytes = new TextEncoder().encode('export default {};');

            version.addModule({ name: 'index.js', content: bytes, main: true });

            assertEqual('export default {};', decodeBase64(version.toJSON().modules[0].content_base64));
        });

        it('encodes content larger than one conversion chunk', () => {
            const version = new CloudflareWorkerVersion();

            // Exceeds the 0x8000 chunk size used to avoid a call stack overflow.
            const content = 'x'.repeat((0x8000 * 3) + 17);

            version.addModule({ name: 'index.js', content, main: true });

            assertEqual(content, decodeBase64(version.toJSON().modules[0].content_base64));
        });

        it('round trips multi-byte content', () => {
            const version = new CloudflareWorkerVersion();
            const content = 'export const sign = "𝄞 ünïcødé";';

            version.addModule({ name: 'index.js', content, main: true });

            assertEqual(content, decodeBase64(version.toJSON().modules[0].content_base64));
        });

        it('infers text/plain for a non-JavaScript name', () => {
            const version = new CloudflareWorkerVersion();

            version.addModule({ name: 'index.js', content: 'x', main: true });
            version.addModule({ name: '_headers', content: '/* nosniff' });

            assertEqual('text/plain', version.toJSON().modules[1].content_type);
        });

        it('honors an explicit content type override', () => {
            const version = new CloudflareWorkerVersion();

            version.addModule({
                name: 'index.js',
                content: 'x',
                content_type: 'text/plain',
                main: true,
            });

            assertEqual('text/plain', version.toJSON().modules[0].content_type);
        });

        it('does not emit the main flag as a module field', () => {
            const version = new CloudflareWorkerVersion();

            version.addModule({ name: 'index.js', content: 'x', main: true });

            const [ mod ] = version.toJSON().modules;

            assertUndefined(mod.main);
            assertEqual(3, Object.keys(mod).length);
        });

        it('records the main module name as main_module', () => {
            const version = new CloudflareWorkerVersion();

            version.addModule({ name: 'utils.js', content: 'x' });
            version.addModule({ name: 'index.js', content: 'y', main: true });

            assertEqual('index.js', version.toJSON().main_module);
        });

        it('rejects a second main module', () => {
            const version = new CloudflareWorkerVersion();

            version.addModule({ name: 'index.js', content: 'x', main: true });

            const caught = catchError(() => {
                return version.addModule({ name: 'other.js', content: 'y', main: true });
            });

            assert(caught, 'expected a second main module to be rejected');
            assertMatches('main module already set to "index.js"', caught.message);
        });

        it('rejects a duplicate module name', () => {
            const version = new CloudflareWorkerVersion();

            version.addModule({ name: 'index.js', content: 'x', main: true });

            const caught = catchError(() => {
                return version.addModule({ name: 'index.js', content: 'y' });
            });

            assert(caught, 'expected a duplicate module name to be rejected');
            assertMatches('duplicate module name "index.js"', caught.message);
        });

        it('rejects invalid module arguments', () => {
            const calls = [
                [ undefined, 'requires a module' ],
                [ {}, 'requires a module.name' ],
                [ { name: 'index.js' }, 'content must be a string or Uint8Array' ],
                [ { name: 'index.js', content: 42 }, 'content must be a string or Uint8Array' ],
                [ { name: 'index.js', content: 'x', main: 'yes' }, 'main must be a boolean' ],
                [ { name: 'index.js', content: 'x', content_type: '' }, 'content_type must be a non-empty string' ],
            ];

            for (const [ mod, message ] of calls) {
                const caught = catchError(() => new CloudflareWorkerVersion().addModule(mod));

                assert(caught, `expected ${ JSON.stringify(mod) } to be rejected`);
                assertMatches(message, caught.message);
            }
        });
    });

    describe('migrations', ({ it }) => {
        it('omits the migrations key when no operation was recorded', () => {
            assertUndefined(makeVersion().toJSON().migrations);
        });

        it('emits every recorded operation with its tags', () => {
            const version = makeVersion();

            version.addNewSqliteClass('ChatRoom');
            version.addNewClass('LegacyCounter');
            version.deleteClass('Abandoned');
            version.renameClass('OldName', 'NewName');
            version.transferClass({ from: 'Counter', from_script: 'old-worker', to: 'Counter' });
            version.setMigrationTags('v3', 'v4');

            const { migrations } = version.toJSON();

            assertEqual('ChatRoom', migrations.new_sqlite_classes[0]);
            assertEqual('LegacyCounter', migrations.new_classes[0]);
            assertEqual('Abandoned', migrations.deleted_classes[0]);
            assertEqual('OldName', migrations.renamed_classes[0].from);
            assertEqual('NewName', migrations.renamed_classes[0].to);
            assertEqual('old-worker', migrations.transferred_classes[0].from_script);
            assertEqual('v3', migrations.old_tag);
            assertEqual('v4', migrations.new_tag);
        });

        it('omits old_tag when the Worker has no prior migration tag', () => {
            const version = makeVersion();

            version.addNewSqliteClass('ChatRoom');
            version.setMigrationTags(null, 'v1');

            const { migrations } = version.toJSON();

            assert(!Object.hasOwn(migrations, 'old_tag'), 'expected old_tag to be omitted');
            assertEqual('v1', migrations.new_tag);
        });

        it('rejects a migration with no tags set', () => {
            const version = makeVersion();

            version.addNewSqliteClass('ChatRoom');

            const caught = catchError(() => version.toJSON());

            assert(caught, 'expected an untagged migration to be rejected');
            assertMatches('requires migration tags', caught.message);
        });

        it('rejects an omitted oldTag but accepts an explicit null', () => {
            const version = makeVersion();

            const caught = catchError(() => version.setMigrationTags(undefined, 'v1'));

            assert(caught, 'expected an omitted oldTag to be rejected');
            assertMatches('requires an oldTag string or an explicit null', caught.message);

            version.setMigrationTags(null, 'v1');
        });

        it('rejects invalid migration arguments', () => {
            const calls = [
                [ (v) => v.addNewClass(), 'requires a className' ],
                [ (v) => v.addNewSqliteClass(''), 'requires a className' ],
                [ (v) => v.deleteClass(), 'requires a className' ],
                [ (v) => v.renameClass('Old'), 'requires a to class name' ],
                [ (v) => v.renameClass(undefined, 'New'), 'requires a from class name' ],
                [ (v) => v.transferClass(), 'requires a transfer' ],
                [ (v) => v.transferClass({ from: 'A', to: 'B' }), 'requires a transfer.from_script' ],
                [ (v) => v.setMigrationTags('v3'), 'requires a newTag' ],
                [ (v) => v.setMigrationTags('', 'v4'), 'must be a non-empty string or null' ],
            ];

            for (const [ call, message ] of calls) {
                const caught = catchError(() => call(makeVersion()));

                assert(caught, `expected rejection matching "${ message }"`);
                assertMatches(message, caught.message);
            }
        });
    });

    describe('toJSON()', ({ it }) => {
        it('requires a main module', () => {
            const version = new CloudflareWorkerVersion();

            version.addModule({ name: 'utils.js', content: 'x' });

            const caught = catchError(() => version.toJSON());

            assert(caught, 'expected a version without a main module to be rejected');
            assertMatches('requires a module added with main: true', caught.message);
        });

        it('returns a fresh copy that cannot mutate the instance', () => {
            const version = makeVersion();

            version.addBinding({ type: 'plain_text', name: 'ENV', text: 'production' });

            const first = version.toJSON();

            first.bindings.push({ type: 'plain_text', name: 'INJECTED' });
            first.bindings[0].text = 'mutated';
            first.modules[0].name = 'mutated.js';

            const second = version.toJSON();

            assertEqual(1, second.bindings.length);
            assertEqual('production', second.bindings[0].text);
            assertEqual('index.js', second.modules[0].name);
        });

        it('reflects changes made after an earlier call', () => {
            const version = makeVersion();

            assertUndefined(version.toJSON().bindings);

            version.addBinding({ type: 'plain_text', name: 'ENV', text: 'production' });

            assertEqual(1, version.toJSON().bindings.length);
        });

        it('survives a JSON round trip through the API client payload shape', () => {
            const version = makeVersion({ compatibility_date: '2025-01-01' });

            version.addBinding({ type: 'kv_namespace', name: 'CACHE', namespace_id: 'kv-id' });

            const payload = JSON.parse(JSON.stringify(version.toJSON()));

            assertEqual('index.js', payload.main_module);
            assertEqual('kv-id', payload.bindings[0].namespace_id);
            assertEqual('2025-01-01', payload.compatibility_date);
        });
    });
});


function makeVersion(options) {
    const version = new CloudflareWorkerVersion(options);

    version.addModule({ name: 'index.js', content: 'export default {};', main: true });

    return version;
}


function decodeBase64(encoded) {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }

    return new TextDecoder().decode(bytes);
}


function catchError(fn) {
    try {
        fn();
    } catch (error) {
        return error;
    }
    return null;
}

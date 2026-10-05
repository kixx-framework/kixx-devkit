import { describe } from 'kixx-test';
import { assert, assertEqual, isNonEmptyString } from '../../lib/vendor/kixx-assert/mod.js';
import denoManifest from '../../deno.json' with { type: 'json' };
import npmManifest from '../../package.json' with { type: 'json' };


// deno.json pins only development tools; the published CLI has no runtime
// package dependencies (third-party code is vendored under lib/vendor/).
const DEV_TOOL_IMPORTS = [ 'kixx-linting', 'kixx-test' ];


describe('package manifests', ({ it }) => {

    it('publish the same version to npm and JSR', () => {
        assert(isNonEmptyString(denoManifest.version), 'deno.json version');
        assertEqual(denoManifest.version, npmManifest.version, 'package.json version');
    });

    it('install the kixx executable from kixx.js on both registries', () => {
        assertEqual('./kixx.js', npmManifest.bin?.kixx, 'package.json bin.kixx');
        assertEqual('./kixx.js', denoManifest.exports?.['./kixx'], 'deno.json exports["./kixx"]');
    });

    it('declare no runtime dependencies', () => {
        assertEqual(undefined, npmManifest.dependencies, 'package.json dependencies');
        assertEqual(
            DEV_TOOL_IMPORTS.join(','),
            Object.keys(denoManifest.imports ?? {}).sort().join(','),
            'deno.json imports',
        );
    });
});

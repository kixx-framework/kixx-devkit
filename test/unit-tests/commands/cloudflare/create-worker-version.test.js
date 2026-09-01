import { describe } from 'kixx-test';
import { assert, assertEqual } from 'kixx-assert';
import {
    renderCreated,
    renderSkipped,
} from '../../../../commands/cloudflare/create-worker-version.js';

const PREVIOUS_STATE = {
    versionId: 'previous-version-id',
    buildId: '2026-08-29T16-00-00Z',
    modulesHash: 'aaaaaa11',
    bindingsHash: 'bbbbbb22',
    configHash: 'cccccc33',
};

const NEW_STATE = {
    modulesHash: 'dddddd44',
    bindingsHash: 'bbbbbb22',
    configHash: 'cccccc33',
};


describe('create-worker-version output', ({ describe }) => {

    describe('renderSkipped()', ({ it }) => {
        it('reports the recorded version and the --force escape hatch', () => {
            const text = renderSkipped(
                { environment: 'production', workerName: 'kixx-test-app' },
                PREVIOUS_STATE,
            );

            assert(text.includes('Nothing changed since version previous-version-id'), text);
            assert(text.includes('--force'), text);
            assert(!text.includes('Durable Objects'), 'expected no Durable Object noise');
        });
    });

    describe('renderCreated()', ({ it }) => {
        it('prints an unmissable line naming the classes and the reason for a forced deploy', () => {
            const text = render({
                deployed: true,
                forcedDeploymentClasses: [ 'ContentAddressableIndexStore', 'Counter' ],
            });

            assert(text.includes('DEPLOYED to 100% of traffic without --deploy.'), text);
            assert(text.includes('never been deployed'), text);
            assert(
                text.includes('Namespaces provisioned for: ContentAddressableIndexStore, Counter'),
                text,
            );
        });

        it('prints the plain deployed line for a requested deployment', () => {
            const text = render({ deployed: true, forcedDeploymentClasses: null });

            assertEqual(true, text.includes('Deployed to 100% of traffic'));
            assertEqual(false, text.includes('without --deploy'));
        });

        it('prints the undeployed line and no reconciliation section', () => {
            const text = render({ deployed: false, forcedDeploymentClasses: null, reconciliation: null });

            assert(text.includes('Created undeployed'), text);
            assert(!text.includes('Durable Objects'), 'expected no reconciliation section');
            assert(!text.toLowerCase().includes('reconciliation'), 'expected no warning about its absence');
        });

        it('prints only the non-empty reconciliation sections', () => {
            const text = render({
                deployed: true,
                reconciliation: {
                    created: [ { class_name: 'ContentAddressableIndexStore' } ],
                    updated: [],
                    deleted: [],
                    renamed: [],
                    transferred: [],
                    transfer_pending: [],
                    warnings: [],
                    info: [],
                    removable_entries: [],
                },
            });

            assert(text.includes('Durable Objects:'), text);
            assert(text.includes('  Created:'), text);
            assert(text.includes('    ContentAddressableIndexStore'), text);
            assert(!text.includes('Deleted:'), 'expected empty sections to be omitted');
            assert(!text.includes('Warnings:'), 'expected empty sections to be omitted');
            assert(!text.includes('safe to delete'), 'expected no removable entries section');
        });

        it('prints removable entries with the config key to edit', () => {
            const text = render({
                deployed: true,
                reconciliation: { removable_entries: [ { class_name: 'LegacyStore' } ] },
            });

            assert(text.includes('DURABLE_OBJECT_MIGRATIONS'), text);
            assert(text.includes('safe to delete'), text);
            assert(text.includes('LegacyStore'), text);
        });

        it('prints referencing scripts with their info entry', () => {
            const text = render({
                deployed: true,
                reconciliation: {
                    info: [
                        {
                            class_name: 'LegacyStore',
                            message: 'tombstone is stale',
                            referencing_scripts: [ 'other-worker', 'third-worker' ],
                        },
                    ],
                },
            });

            assert(text.includes('LegacyStore — tombstone is stale'), text);
            assert(text.includes('still referenced by: other-worker, third-worker'), text);
        });

        it('prints the class name for an { class, message } entry', () => {
            const text = render({
                deployed: true,
                reconciliation: {
                    warnings: [ { class: 'LegacyStore', message: 'tombstone is stale' } ],
                },
            });

            assert(text.includes('LegacyStore — tombstone is stale'), text);
        });

        it('falls back to the raw entry rather than dropping an unrecognized shape', () => {
            const text = render({
                deployed: true,
                reconciliation: { warnings: [ { unexpected: 'shape' } ] },
            });

            assert(text.includes('{"unexpected":"shape"}'), text);
        });

        it('prints an unmissable retarget line when retargetedFrom is set', () => {
            const text = render({
                workerName: 'kixx-test-app-2',
                retargetedFrom: 'kixx-test-app',
                changes: { modules: false, bindings: false, config: false },
            });

            assert(text.includes('RETARGETED from Worker "kixx-test-app"'), text);
        });

        it('prints no retarget line when retargetedFrom is null', () => {
            const text = render({ retargetedFrom: null });

            assert(!text.includes('RETARGETED'), text);
        });

        it('keeps the hash lines and the state file line unchanged', () => {
            const text = render({ deployed: false, forcedDeploymentClasses: null });

            assert(text.includes('  modules   changed    aaaaaa… -> dddddd…'), text);
            assert(text.includes('  bindings  unchanged'), text);
            assert(text.includes('  config    unchanged'), text);
            assert(text.endsWith('Wrote .kixx/cloudflare-state.production.json\n'), text);
        });
    });
});


function render(overrides) {
    const result = {
        environment: 'production',
        workerName: 'kixx-test-app',
        moduleCount: 3,
        changes: { modules: true, bindings: false, config: false },
        buildId: '2026-08-29T16-49-32Z',
        versionId: 'version-id',
        deployed: false,
        retargetedFrom: null,
        forcedDeploymentClasses: null,
        reconciliation: null,
        ...overrides,
    };

    return renderCreated(result, PREVIOUS_STATE, NEW_STATE, '.kixx/cloudflare-state.production.json');
}

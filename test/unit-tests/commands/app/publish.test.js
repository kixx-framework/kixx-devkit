import process from 'node:process';
import { assertEqual, assertMatches } from 'kixx-assert';
import { describe, MockTracker } from 'kixx-test';

import AppPublishCommand from '../../../../commands/app/publish.js';
import { UnsupportedServerError } from '../../../../lib/publishing/negotiate-capabilities.js';
import { BuildPointerConflictError } from '../../../../lib/publishing/publishing-api-error.js';

const ASSIGNMENT_ID = '4a2f7b2e-6d1c-4f0a-9b83-1c5d7e9a0f21';

describe('AppPublishCommand', ({ it }) => {
    it('creates and assigns a Release to discovery\'s running build', async () => {
        const tracker = new MockTracker();
        const stdout = tracker.method(process.stdout, 'write', () => true);
        const calls = [];
        const client = { discover: async () => ({ runningBuildId: 'running-build' }) };
        const command = makeCommand({ client, calls });

        await command.run({ environment: 'production' });

        assertEqual('scan,publish,assign', calls.join(','));
        assertEqual('running-build', calls.assignedBuildId);
        assertEqual('release-id', calls.assignedReleaseId);
        const output = stdout.mock.getCall(0).arguments[0];
        assertMatches('BUILD_ID:    running-build', output);
        assertMatches('Release: release-id', output);

        // The identity correlates this publish with an activation entry.
        assertMatches(`Assignment:  ${ ASSIGNMENT_ID }`, output);
        tracker.reset();
    });

    it('dry-run performs no assignment and prints no Release id', async () => {
        const tracker = new MockTracker();
        const stdout = tracker.method(process.stdout, 'write', () => true);
        const calls = [];
        const command = makeCommand({ calls, dryRunResult: true });

        await command.run({ environment: 'production', 'build-id': 'explicit', 'dry-run': true });

        assertEqual('scan,publish', calls.join(','));
        const output = stdout.mock.getCall(0).arguments[0];
        assertMatches('unvalidated preview', output);
        assertEqual(false, output.includes('Release:'));

        // Nothing was assigned, so there is no identity to report.
        assertEqual(false, output.includes('Assignment:'));
        tracker.reset();
    });

    it('reports the Release id and a recovery command when assignment fails', async () => {
        const tracker = new MockTracker();
        const stdout = tracker.method(process.stdout, 'write', () => true);
        const calls = [];
        const command = makeCommand({
            calls,
            assignRelease: async () => {
                calls.push('assign');
                throw new Error('network unreachable');
            },
        });

        try {
            const caught = await catchAsyncError(() => command.run({ environment: 'production' }));

            assertEqual('ReleaseAssignmentError', caught.name);
            assertMatches('release-id', caught.message);
            assertMatches('running-build', caught.message);
            assertMatches('network unreachable', caught.message);
            assertMatches('app assign-build', caught.message);
            assertMatches('--release-id release-id', caught.message);
            assertMatches('--build-id running-build', caught.message);
            assertEqual('release-id', caught.releaseId);
            assertEqual('running-build', caught.buildId);
            assertEqual(0, stdout.mock.callCount());
        } finally {
            tracker.reset();
        }
    });

    it('names the release id in a build pointer conflict during assignment', async () => {
        const tracker = new MockTracker();
        const stdout = tracker.method(process.stdout, 'write', () => true);
        const calls = [];
        const command = makeCommand({
            calls,
            assignRelease: async () => {
                calls.push('assign');
                throw new BuildPointerConflictError('conflict', {
                    status: 409, method: 'PUT', url: 'https://x', attempts: 1,
                });
            },
        });

        try {
            const caught = await catchAsyncError(() => command.run({ environment: 'production' }));

            assertEqual('ReleaseAssignmentError', caught.name);
            assertMatches('release-id', caught.message);
            assertMatches('app assign-build', caught.message);
            assertEqual(0, stdout.mock.callCount());
        } finally {
            tracker.reset();
        }
    });

    it('reports a refused server without claiming a stranded Release', async () => {
        const tracker = new MockTracker();
        const stdout = tracker.method(process.stdout, 'write', () => true);
        const calls = [];
        const command = makeCommand({
            calls,
            assignRelease: async () => {
                calls.push('assign');
                throw new UnsupportedServerError('server too old');
            },
        });

        try {
            const caught = await catchAsyncError(() => command.run({ environment: 'production' }));

            // Nothing was attempted against the pointer, so the recovery
            // command a ReleaseAssignmentError prints would be misleading.
            assertEqual('UnsupportedServerError', caught.name);
            assertEqual(0, stdout.mock.callCount());
        } finally {
            tracker.reset();
        }
    });

    it('fails a null discovered build before scanning or publishing', async () => {
        const calls = [];
        const client = { discover: async () => ({ runningBuildId: null }) };
        const command = makeCommand({ client, calls });

        const caught = await catchAsyncError(() => command.run({ environment: 'production' }));

        assertEqual('UsageError', caught.name);
        assertMatches('app assign-build', caught.message);
        assertEqual(0, calls.length);
    });
});

function makeCommand(args) {
    const {
        client = { discover: async () => ({ runningBuildId: 'running-build' }) },
        calls,
        dryRunResult = false,
        assignRelease = async (options) => {
            calls.push('assign');
            calls.assignedBuildId = options.buildId;
            calls.assignedReleaseId = options.releaseId;
            return {
                buildId: options.buildId,
                releaseId: options.releaseId,
                assignmentId: ASSIGNMENT_ID,
            };
        },
    } = args;

    return new AppPublishCommand({
        projectDirectory: '/app',
        config: { app: { environments: { production: { origin: 'https://app.example.com' } } } },
        secrets: { app: { environments: { production: { publishingToken: 'secret' } } } },
        createClient: () => client,
        scan: async () => {
            calls.push('scan');
            return { resources: [], unmatchedFiles: [] };
        },
        publishContent: async (options) => {
            calls.push('publish');
            return makeResult(options.dryRun || dryRunResult);
        },
        assignRelease,
    });
}

function makeResult(dryRun) {
    return {
        dryRun,
        matchedCount: 0,
        uploadedCount: 0,
        uploadedResources: [],
        unmatchedFiles: [],
        resources: [],
        releaseId: dryRun ? null : 'release-id',
        objectCount: dryRun ? null : 0,
        totalBytes: dryRun ? null : 0,
    };
}

async function catchAsyncError(fn) {
    try {
        await fn();
    } catch (error) {
        return error;
    }
    throw new Error('Expected an error');
}

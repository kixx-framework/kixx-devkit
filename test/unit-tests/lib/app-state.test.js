import { describe } from 'kixx-test';
import { assert, assertEqual, assertFalsy } from 'kixx-assert';
import {
    getAppStateFilepath,
    hasPublishedBuild,
    readAppState,
    recordLiveBuild,
    recordPublishedBuild,
    writeAppState,
} from '../../../lib/app-state.js';

const FILEPATH = '/app/.kixx/app-state.production.json';
const VALID_STATE = {
    liveBuildId: 'build-live',
    deployedAt: '2026-08-31T14:02:40.118Z',
    builds: {
        'build-live': {
            closureHash: 'closure-live',
            publishedAt: '2026-08-31T14:02:31.902Z',
        },
    },
};

describe('app-state', ({ it }) => {
    it('returns the documented filepath for an environment', () => {
        const filepath = getAppStateFilepath({ projectDirectory: '/app', environment: 'production' });

        assertEqual(FILEPATH, filepath);
    });

    it('resolves to null when the file is absent', async () => {
        const fileSystem = makeFileSystem({});

        const state = await readAppState({ projectDirectory: '/app', environment: 'production', fileSystem });

        assertEqual(null, state);
    });

    it('returns a valid state object', async () => {
        const fileSystem = makeFileSystem({ [FILEPATH]: JSON.stringify(VALID_STATE) });

        const state = await readAppState({ projectDirectory: '/app', environment: 'production', fileSystem });

        assertJsonEqual(VALID_STATE, state);
    });

    for (const [ label, source, field ] of [
        [ 'invalid JSON', '{not json', null ],
        [ 'a non-object root', '[]', null ],
        [ 'a wrong-typed root field', JSON.stringify({ liveBuildId: 42 }), 'liveBuildId' ],
        [ 'a wrong-typed builds field', JSON.stringify({ builds: [] }), 'builds' ],
        [ 'a wrong-typed build record', JSON.stringify({ builds: { one: null } }), 'one' ],
        [ 'a wrong-typed build field', JSON.stringify({ builds: { one: { closureHash: 42 } } }), 'closureHash' ],
    ]) {
        it(`throws a UsageError naming the file for ${ label }`, async () => {
            const fileSystem = makeFileSystem({ [FILEPATH]: source });

            const caught = await catchAsyncError(() => {
                return readAppState({ projectDirectory: '/app', environment: 'production', fileSystem });
            });

            assert(caught, 'expected an error to be thrown');
            assertEqual('UsageError', caught.name);
            assert(caught.message.includes(FILEPATH), 'expected the message to name the file');
            if (field) {
                assert(caught.message.includes(field), 'expected the message to name the field');
            }
        });
    }

    it('preserves unknown root and build fields through a round trip', async () => {
        const original = {
            ...VALID_STATE,
            futureRootField: 'root-value',
            builds: {
                'build-live': {
                    ...VALID_STATE.builds['build-live'],
                    futureBuildField: 'build-value',
                },
            },
        };
        const fileSystem = makeFileSystem({ [FILEPATH]: JSON.stringify(original) });

        const state = await readAppState({ projectDirectory: '/app', environment: 'production', fileSystem });
        await writeAppState({ projectDirectory: '/app', environment: 'production', state, fileSystem });

        assertJsonEqual(original, JSON.parse(fileSystem.written[FILEPATH]));
    });

    it('records a publish without changing the live deployment', async () => {
        const fileSystem = makeFileSystem({ [FILEPATH]: JSON.stringify(VALID_STATE) });

        const state = await recordPublishedBuild({
            projectDirectory: '/app',
            environment: 'production',
            buildId: 'build-next',
            closureHash: 'closure-next',
            publishedAt: '2026-08-31T15:00:00.000Z',
            fileSystem,
        });

        assertEqual('build-live', state.liveBuildId);
        assertEqual('2026-08-31T14:02:40.118Z', state.deployedAt);
        assertJsonEqual(VALID_STATE.builds['build-live'], state.builds['build-live']);
        assertJsonEqual({
            closureHash: 'closure-next',
            publishedAt: '2026-08-31T15:00:00.000Z',
        }, state.builds['build-next']);
    });

    it('records a first publish into a missing state file', async () => {
        const fileSystem = makeFileSystem({});

        const state = await recordPublishedBuild({
            projectDirectory: '/app',
            environment: 'production',
            buildId: 'build-first',
            closureHash: 'closure-first',
            publishedAt: '2026-08-31T15:00:00.000Z',
            fileSystem,
        });

        assertEqual('closure-first', state.builds['build-first'].closureHash);
        assertJsonEqual(state, JSON.parse(fileSystem.written[FILEPATH]));
    });

    it('updates a publish record while preserving its unknown fields', async () => {
        const original = {
            builds: {
                one: {
                    closureHash: 'old',
                    publishedAt: 'old-time',
                    futureField: 'kept',
                },
            },
        };
        const fileSystem = makeFileSystem({ [FILEPATH]: JSON.stringify(original) });

        const state = await recordPublishedBuild({
            projectDirectory: '/app',
            environment: 'production',
            buildId: 'one',
            closureHash: 'new',
            publishedAt: 'new-time',
            fileSystem,
        });

        assertEqual('kept', state.builds.one.futureField);
        assertEqual('new', state.builds.one.closureHash);
    });

    it('records a deployment without changing publish history', async () => {
        const fileSystem = makeFileSystem({ [FILEPATH]: JSON.stringify(VALID_STATE) });

        const state = await recordLiveBuild({
            projectDirectory: '/app',
            environment: 'production',
            buildId: 'build-next',
            deployedAt: '2026-08-31T16:00:00.000Z',
            fileSystem,
        });

        assertEqual('build-next', state.liveBuildId);
        assertEqual('2026-08-31T16:00:00.000Z', state.deployedAt);
        assertJsonEqual(VALID_STATE.builds, state.builds);
    });

    it('reports whether a build has published content', () => {
        assert(hasPublishedBuild(VALID_STATE, 'build-live'));
        assertFalsy(hasPublishedBuild(VALID_STATE, 'build-missing'));
        assertFalsy(hasPublishedBuild(null, 'build-live'));
    });

    it('writes four-space indented text ending with one newline', async () => {
        const fileSystem = makeFileSystem({});

        await writeAppState({
            projectDirectory: '/app',
            environment: 'production',
            state: VALID_STATE,
            fileSystem,
        });

        assertEqual(`${ JSON.stringify(VALID_STATE, null, 4) }\n`, fileSystem.written[FILEPATH]);
    });
});

function makeFileSystem(files) {
    const written = {};

    return {
        written,
        async isFile(filepath) {
            return Object.hasOwn(files, filepath);
        },
        async readFile(filepath) {
            return files[filepath];
        },
        async writeFile(filepath, contents) {
            written[filepath] = contents;
            files[filepath] = contents;
        },
    };
}

async function catchAsyncError(fn) {
    try {
        await fn();
    } catch (error) {
        return error;
    }
    return null;
}

function assertJsonEqual(expected, actual) {
    assertEqual(JSON.stringify(expected), JSON.stringify(actual));
}

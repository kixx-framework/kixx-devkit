import path from 'node:path';
import { isPlainObject, isString } from 'kixx-assert';
import UsageError from './usage-error.js';
import defaultFileSystem from './file-system.js';

const ROOT_STRING_FIELDS = [ 'liveBuildId', 'deployedAt' ];
const BUILD_STRING_FIELDS = [ 'closureHash', 'publishedAt' ];

/**
 * Durable publishing and deployment state for one application environment.
 * The state is target-neutral so publishing and deployment commands share one
 * record of content availability and the build currently serving traffic.
 * @module app-state
 */

/**
 * @typedef {Object} PublishedBuildState
 * @property {string} closureHash - Hash of the committed content closure.
 * @property {string} publishedAt - ISO timestamp of the successful publish.
 */

/**
 * @typedef {Object} AppState
 * @property {string} [liveBuildId] - Build currently serving the environment.
 * @property {string} [deployedAt] - ISO timestamp of the successful deployment.
 * @property {Object<string, PublishedBuildState>} [builds] - Builds with committed content closures.
 */

/**
 * @param {Object} args - Options.
 * @param {string} args.projectDirectory - Absolute path to the project root.
 * @param {string} args.environment - Environment name, such as `production`.
 * @returns {string} Absolute path to the application state file.
 */
export function getAppStateFilepath(args) {
    const { projectDirectory, environment } = args ?? {};

    return path.join(projectDirectory, '.kixx', `app-state.${ environment }.json`);
}

/**
 * @param {Object} args - Options.
 * @param {string} args.projectDirectory - Absolute path to the project root.
 * @param {string} args.environment - Environment name, such as `production`.
 * @param {import('./file-system.js').FileSystem} [args.fileSystem] - Filesystem adapter.
 * @returns {Promise<AppState|null>} Recorded state, or `null` when no state file exists.
 * @throws {UsageError} When the file contains invalid JSON or a known field has the wrong type.
 */
export async function readAppState(args) {
    const {
        projectDirectory,
        environment,
        fileSystem = defaultFileSystem,
    } = args ?? {};

    const filepath = getAppStateFilepath({ projectDirectory, environment });

    if (!(await fileSystem.isFile(filepath))) {
        return null;
    }

    const text = await fileSystem.readFile(filepath);

    let state;
    try {
        state = JSON.parse(text);
    } catch (cause) {
        throw new UsageError(`Invalid JSON in application state file: ${ filepath }`, { cause });
    }

    if (!isPlainObject(state)) {
        throw new UsageError(`Expected a JSON object in application state file: ${ filepath }`);
    }

    validateState(state, filepath);

    return state;
}

/**
 * @param {Object} args - Options.
 * @param {string} args.projectDirectory - Absolute path to the project root.
 * @param {string} args.environment - Environment name, such as `production`.
 * @param {AppState} args.state - Complete next state, written without merging.
 * @param {import('./file-system.js').FileSystem} [args.fileSystem] - Filesystem adapter.
 * @returns {Promise<void>}
 */
export async function writeAppState(args) {
    const {
        projectDirectory,
        environment,
        state,
        fileSystem = defaultFileSystem,
    } = args ?? {};

    const filepath = getAppStateFilepath({ projectDirectory, environment });

    await fileSystem.writeFile(filepath, `${ JSON.stringify(state, null, 4) }\n`);
}

/**
 * Records a committed content closure without changing the live deployment.
 * @param {Object} args - Options.
 * @param {string} args.projectDirectory - Absolute path to the project root.
 * @param {string} args.environment - Environment name, such as `production`.
 * @param {string} args.buildId - Build receiving the published closure.
 * @param {string} args.closureHash - Hash returned by the closure commit.
 * @param {string} args.publishedAt - ISO timestamp of the successful publish.
 * @param {import('./file-system.js').FileSystem} [args.fileSystem] - Filesystem adapter.
 * @returns {Promise<AppState>} The state written to disk.
 */
export async function recordPublishedBuild(args) {
    const {
        projectDirectory,
        environment,
        buildId,
        closureHash,
        publishedAt,
        fileSystem = defaultFileSystem,
    } = args ?? {};

    const previousState = await readAppState({ projectDirectory, environment, fileSystem });
    const state = previousState ?? {};
    const builds = state.builds ?? {};
    const previousBuild = builds[buildId] ?? {};
    const nextState = {
        ...state,
        builds: {
            ...builds,
            [buildId]: {
                ...previousBuild,
                closureHash,
                publishedAt,
            },
        },
    };

    await writeAppState({ projectDirectory, environment, state: nextState, fileSystem });

    return nextState;
}

/**
 * Records the build serving all traffic without changing publish history.
 * @param {Object} args - Options.
 * @param {string} args.projectDirectory - Absolute path to the project root.
 * @param {string} args.environment - Environment name, such as `production`.
 * @param {string} args.buildId - Build placed into service.
 * @param {string} args.deployedAt - ISO timestamp of the successful deployment.
 * @param {import('./file-system.js').FileSystem} [args.fileSystem] - Filesystem adapter.
 * @returns {Promise<AppState>} The state written to disk.
 */
export async function recordLiveBuild(args) {
    const {
        projectDirectory,
        environment,
        buildId,
        deployedAt,
        fileSystem = defaultFileSystem,
    } = args ?? {};

    const previousState = await readAppState({ projectDirectory, environment, fileSystem });
    const nextState = {
        ...(previousState ?? {}),
        liveBuildId: buildId,
        deployedAt,
    };

    await writeAppState({ projectDirectory, environment, state: nextState, fileSystem });

    return nextState;
}

/**
 * @param {AppState|null} state - Application state from {@link readAppState}.
 * @param {string} buildId - Build to look up.
 * @returns {boolean} Whether the build has a successful publish record.
 */
export function hasPublishedBuild(state, buildId) {
    return Boolean(state?.builds && Object.hasOwn(state.builds, buildId));
}

// Validate known fields without treating the format as a whitelist. This lets
// newer devkit versions add data that older versions preserve during updates.
function validateState(state, filepath) {
    for (const field of ROOT_STRING_FIELDS) {
        if (state[field] !== undefined && !isString(state[field])) {
            throwInvalidField(field, filepath);
        }
    }

    if (state.builds === undefined) {
        return;
    }

    if (!isPlainObject(state.builds)) {
        throw new UsageError(`Expected "builds" to be a JSON object in application state file: ${ filepath }`);
    }

    for (const [ buildId, build ] of Object.entries(state.builds)) {
        if (!isPlainObject(build)) {
            throw new UsageError(`Expected build "${ buildId }" to be a JSON object in application state file: ${ filepath }`);
        }

        for (const field of BUILD_STRING_FIELDS) {
            if (build[field] !== undefined && !isString(build[field])) {
                throwInvalidField(`builds.${ buildId }.${ field }`, filepath);
            }
        }
    }
}

function throwInvalidField(field, filepath) {
    throw new UsageError(`Expected "${ field }" to be a string in application state file: ${ filepath }`);
}

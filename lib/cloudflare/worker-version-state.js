import path from 'node:path';
import { isBoolean, isPlainObject, isString } from 'kixx-assert';
import UsageError from '../usage-error.js';
import defaultFileSystem from '../file-system.js';

const STRING_OR_NULL_FIELDS = [ 'modulesHash', 'bindingsHash', 'configHash', 'migrationTag' ];

/**
 * The durable record of the last created Worker version for one environment.
 * Owns the state file's path, shape, and validation, so a corrupt or
 * hand-mangled file fails naming the file rather than silently producing a
 * wrong idempotency decision.
 * @module worker-version-state
 */

/**
 * @typedef {Object} WorkerVersionState
 * @property {string} workerName - Worker name the state was recorded for.
 * @property {string} buildId - `BUILD_ID` of the last created version.
 * @property {string} versionId - Cloudflare version identifier.
 * @property {string} createdAt - ISO timestamp of the last created version.
 * @property {boolean} deployed - Whether the last created version was deployed.
 * @property {string} modulesHash - Canonical digest of the uploaded modules.
 * @property {string} bindingsHash - Canonical digest of the uploaded bindings.
 * @property {string} configHash - Canonical digest of the `WORKER_VERSION` block.
 * @property {string|null} migrationTag - Cloudflare Durable Object migration tag, or `null` if never migrated.
 * @property {string[]} durableObjectClasses - Durable Object classes recorded as present.
 */

/**
 * @param {Object} args - Options.
 * @param {string} args.projectDirectory - Absolute path to the project root.
 * @param {string} args.environment - Environment name, such as `production`.
 * @returns {string} Absolute path to the state file for this environment.
 */
export function getStateFilepath(args) {
    const { projectDirectory, environment } = args ?? {};

    return path.join(projectDirectory, '.kixx', `cloudflare-state.${ environment }.json`);
}

/**
 * @param {Object} args - Options.
 * @param {string} args.projectDirectory - Absolute path to the project root.
 * @param {string} args.environment - Environment name, such as `production`.
 * @param {import('../file-system.js').FileSystem} [args.fileSystem] - Filesystem adapter.
 * @returns {Promise<WorkerVersionState|null>} The recorded state, or `null` when no version has ever been created.
 * @throws {UsageError} When the file exists but is not valid JSON, is not a
 *     JSON object, or a known field has the wrong type.
 */
export async function readWorkerVersionState(args) {
    const {
        projectDirectory,
        environment,
        fileSystem = defaultFileSystem,
    } = args ?? {};

    const filepath = getStateFilepath({ projectDirectory, environment });

    if (!(await fileSystem.isFile(filepath))) {
        return null;
    }

    const text = await fileSystem.readFile(filepath);

    let state;
    try {
        state = JSON.parse(text);
    } catch (cause) {
        throw new UsageError(`Invalid JSON in state file: ${ filepath }`, { cause });
    }

    if (!isPlainObject(state)) {
        throw new UsageError(`Expected a JSON object in state file: ${ filepath }`);
    }

    validateState(state, filepath);

    return state;
}

/**
 * @param {Object} args - Options.
 * @param {string} args.projectDirectory - Absolute path to the project root.
 * @param {string} args.environment - Environment name, such as `production`.
 * @param {WorkerVersionState} args.state - Complete next state to write. Written verbatim, not merged with any existing file.
 * @param {import('../file-system.js').FileSystem} [args.fileSystem] - Filesystem adapter.
 * @returns {Promise<void>}
 */
export async function writeWorkerVersionState(args) {
    const {
        projectDirectory,
        environment,
        state,
        fileSystem = defaultFileSystem,
    } = args ?? {};

    const filepath = getStateFilepath({ projectDirectory, environment });

    await fileSystem.writeFile(filepath, `${ JSON.stringify(state, null, 4) }\n`);
}

function validateState(state, filepath) {
    for (const field of STRING_OR_NULL_FIELDS) {
        const value = state[field];
        if (value !== undefined && value !== null && !isString(value)) {
            throw new UsageError(`Expected "${ field }" to be a string or null in state file: ${ filepath }`);
        }
    }

    if (state.durableObjectClasses !== undefined && !isStringArray(state.durableObjectClasses)) {
        throw new UsageError(`Expected "durableObjectClasses" to be an array of strings in state file: ${ filepath }`);
    }

    if (state.deployed !== undefined && !isBoolean(state.deployed)) {
        throw new UsageError(`Expected "deployed" to be a boolean in state file: ${ filepath }`);
    }
}

function isStringArray(value) {
    return Array.isArray(value) && value.every(isString);
}

import path from 'node:path';
import UsageError from './usage-error.js';
import defaultFileSystem from './file-system.js';

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Reads dotenv values and the required Worker secret-name declaration.
 * Parsing is deliberately minimal: no inline comments, variable expansion,
 * or multi-line values.
 * @module env-file
 */

/**
 * @typedef {Object} EnvFiles
 * @property {Object<string, string>} envars - Values from `.env.<environment>`, which are not secret.
 * @property {Object<string, string>} secrets - Values from `.env.<environment>.secrets`.
 */

/**
 * @param {Object} args - Options.
 * @param {string} args.projectDirectory - Absolute path to the project root.
 * @param {string} args.environment - Environment name, such as `production`.
 * @param {import('./file-system.js').FileSystem} [args.fileSystem] - Filesystem adapter.
 * @returns {Promise<EnvFiles>} The parsed contents of both files.
 * @throws {UsageError} When either file is missing, or a line is malformed, has
 *     an invalid name, or duplicates a name already read from the same file.
 */
export async function readEnvFiles(args) {
    const {
        projectDirectory,
        environment,
        fileSystem = defaultFileSystem,
    } = args ?? {};

    const envarsFilepath = path.join(projectDirectory, `.env.${ environment }`);
    const secretsFilepath = `${ envarsFilepath }.secrets`;

    // Both files are required, even though the application treats each as
    // independently optional at startup. A deployment reaching Cloudflare
    // without one of them is far more likely to be a mistyped environment name
    // than an environment that genuinely has no secrets, and the failure it
    // produces — a Worker missing bindings it needs — surfaces long after the
    // command reports success.
    const [ envars, secrets ] = await Promise.all([
        readAndParse(envarsFilepath, fileSystem),
        readAndParse(secretsFilepath, fileSystem),
    ]);

    return { envars, secrets };
}

/**
 * Reads one dotenv file into a plain object of names to string values.
 * @param {Object} args - Options.
 * @param {string} args.filepath - Absolute pathname of the dotenv file.
 * @param {import('./file-system.js').FileSystem} [args.fileSystem] - Filesystem adapter.
 * @returns {Promise<Object<string, string>>} Parsed values, including empty strings.
 * @throws {UsageError} When the file is missing or contains an invalid assignment.
 */
export async function readEnvValues(args) {
    const {
        filepath,
        fileSystem = defaultFileSystem,
    } = args ?? {};

    return await readAndParse(filepath, fileSystem);
}

/**
 * Reads the required Worker secret names declared by active assignments in
 * `<project>/example.env.secrets`. Assignment values are never returned.
 * @param {Object} args - Options.
 * @param {string} args.projectDirectory - Absolute path to the project root.
 * @param {import('./file-system.js').FileSystem} [args.fileSystem] - Filesystem adapter.
 * @returns {Promise<string[]>} Unique names in lexical order.
 * @throws {UsageError} When the declaration is missing or contains an invalid assignment.
 */
export async function readDeclaredSecretNames(args) {
    const {
        projectDirectory,
        fileSystem = defaultFileSystem,
    } = args ?? {};
    const filepath = path.join(projectDirectory, 'example.env.secrets');
    let declarations;

    try {
        declarations = await readAndParse(filepath, fileSystem);
    } catch (error) {
        if (error.cause) {
            throw new UsageError(
                `Missing secret declaration file: ${ filepath }. ` +
                'example.env.secrets declares the Worker secret names required by every environment.',
                { cause: error.cause },
            );
        }

        throw error;
    }

    return Object.keys(declarations).sort();
}

async function readAndParse(filepath, fileSystem) {
    let text;

    try {
        text = await fileSystem.readFile(filepath);
    } catch (cause) {
        throw new UsageError(`Missing environment file: ${ filepath }`, { cause });
    }

    return parseEnvFile(text, filepath);
}

function parseEnvFile(text, filepath) {
    const values = Object.create(null);
    const lineNumbers = new Map();
    const lines = text.split(/\r\n|\n/);

    lines.forEach((line, index) => {
        const lineNumber = index + 1;
        const trimmed = line.trim();

        if (trimmed === '' || trimmed.startsWith('#')) {
            return;
        }

        const separatorIndex = line.indexOf('=');
        if (separatorIndex === -1) {
            throw new UsageError(`Malformed line ${ lineNumber } in ${ filepath }: expected NAME=value`);
        }

        const name = line.slice(0, separatorIndex).trim();
        const rawValue = line.slice(separatorIndex + 1).trim();

        if (!NAME_PATTERN.test(name)) {
            throw new UsageError(`Invalid name "${ name }" on line ${ lineNumber } in ${ filepath }`);
        }

        if (lineNumbers.has(name)) {
            throw new UsageError(
                `Duplicate name "${ name }" on lines ${ lineNumbers.get(name) } and ${ lineNumber } in ${ filepath }`,
            );
        }

        lineNumbers.set(name, lineNumber);
        values[name] = unquote(rawValue);
    });

    return values;
}

function unquote(value) {
    const isDoubleQuoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"');
    const isSingleQuoted = value.length >= 2 && value.startsWith('\'') && value.endsWith('\'');

    if (isDoubleQuoted || isSingleQuoted) {
        return value.slice(1, -1);
    }

    return value;
}

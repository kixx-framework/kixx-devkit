import path from 'node:path';
import UsageError from './usage-error.js';
import defaultFileSystem from './file-system.js';

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Reads and parses a `.env.<environment>` file into a plain object of name
 * to string value. Parsing is deliberately minimal: no inline comments, no
 * variable expansion, no multi-line values, so a secret always reads at
 * Cloudflare exactly as it reads in the file.
 * @module env-file
 */

/**
 * @param {Object} args - Options.
 * @param {string} args.projectDirectory - Absolute path to the project root.
 * @param {string} args.environment - Environment name, such as `production`.
 * @param {import('./file-system.js').FileSystem} [args.fileSystem] - Filesystem adapter.
 * @returns {Promise<Object<string, string>>} A null-prototype object of name to string value.
 * @throws {UsageError} When the file is missing, or a line is malformed, has
 *     an invalid name, or duplicates a name already read.
 */
export async function readEnvFile(args) {
    const {
        projectDirectory,
        environment,
        fileSystem = defaultFileSystem,
    } = args ?? {};

    const filepath = path.join(projectDirectory, `.env.${ environment }`);

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

import fsp from 'node:fs/promises';

/**
 * Filesystem operations required by the bundler. Implementations decode source
 * as UTF-8, resolve real paths, and treat absent or non-file paths as false.
 *
 * @typedef {Object} FileSystem
 * @property {(filepath: string) => Promise<string>} readFile - Reads UTF-8 source text.
 * @property {(filepath: string) => Promise<string>} realpath - Resolves symlinks and on-disk casing.
 * @property {(filepath: string) => Promise<boolean>} isFile - Reports whether filepath names a file.
 */

const fileSystem = Object.freeze({
    async readFile(filepath) {
        return fsp.readFile(filepath, 'utf8');
    },
    async realpath(filepath) {
        return fsp.realpath(filepath);
    },
    async isFile(filepath) {
        try {
            const stats = await fsp.stat(filepath);
            return stats.isFile();
        } catch (cause) {
            if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') {
                return false;
            }

            throw cause;
        }
    },
});

export default fileSystem;

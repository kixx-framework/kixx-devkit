import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Filesystem operations shared by the bundler and the Cloudflare worker
 * version pipeline. Implementations decode source as UTF-8, resolve real
 * paths, and treat absent or non-file paths as false.
 *
 * @typedef {Object} FileSystem
 * @property {(filepath: string) => Promise<string>} readFile - Reads UTF-8 source text.
 * @property {(filepath: string, contents: string) => Promise<void>} writeFile - Writes UTF-8 text, creating the parent directory.
 * @property {(filepath: string) => Promise<string>} realpath - Resolves symlinks and on-disk casing.
 * @property {(filepath: string) => Promise<boolean>} isFile - Reports whether filepath names a file.
 */

const fileSystem = Object.freeze({
    async readFile(filepath) {
        return fsp.readFile(filepath, 'utf8');
    },
    async writeFile(filepath, contents) {
        await fsp.mkdir(path.dirname(filepath), { recursive: true });
        await fsp.writeFile(filepath, contents, 'utf8');
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

import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AssertionError, isFunction } from 'kixx-assert';


export default class CommandRegistry {

    #commandsDirectory;

    constructor(commandsDirectory) {
        this.#commandsDirectory = commandsDirectory;
    }

    async commandExists(commandName) {
        const dirs = await this.#readCommandsDirectory();

        const entry = dirs.find((directory) => {
            return directory.name === commandName;
        });

        return Boolean(entry);
    }

    async listCommands() {
        const dirs = await this.#readCommandsDirectory();

        const results = [];
        for (const dir of dirs) {
            const mod = await this.#loadCommandModule(dir.name);
            results.push({ name: dir.name, description: mod.description || '' });
        }

        return results;
    }

    async listSubCommands(commandName) {
        const mod = await this.#loadCommandModule(commandName);

        if (!mod.subcommands) {
            return [];
        }

        return Object.entries(mod.subcommands).map(([ name, meta ]) => ({
            name,
            description: meta.description || '',
        }));
    }

    async resolveCommand(commandName, subCommandName) {
        const filepath = path.join(this.#commandsDirectory, commandName, `${ subCommandName }.js`);

        try {
            await fsp.access(filepath);
        } catch {
            return null;
        }

        let mod;
        try {
            mod = await import(pathToFileURL(filepath).href);
        } catch (cause) {
            throw new AssertionError(
                `Expected readable sub-command module at ${ filepath }`,
                { cause },
            );
        }

        if (!isFunction(mod.default)) {
            throw new AssertionError(
                `Expected sub-command module to export a default constructor (${ filepath })`,
            );
        }

        return mod.default;
    }

    async #readCommandsDirectory() {
        let entries;
        try {
            entries = await fsp.readdir(this.#commandsDirectory, { withFileTypes: true });
        } catch (cause) {
            throw new AssertionError(
                `Expected a readable commands directory at ${ this.#commandsDirectory }`,
                { cause },
            );
        }
        // Stable ordering keeps generated help predictable across filesystems.
        return entries
            .filter((entry) => entry.isDirectory())
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    async #loadCommandModule(dirname) {
        const indexPath = path.join(this.#commandsDirectory, dirname, 'index.js');
        try {
            return await import(pathToFileURL(indexPath).href);
        } catch (cause) {
            throw new AssertionError(
                `Expected a readable command index module at ${ indexPath }`,
                { cause },
            );
        }
    }
}

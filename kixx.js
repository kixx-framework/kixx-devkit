#!/usr/bin/env node

import process from 'node:process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import CommandRegistry from './lib/command-registry.js';
import UsageError from './lib/usage-error.js';
import {
    CLOUDFLARE_CONFIG_FILE_NAME,
    loadCloudflareConfig,
} from './lib/cloudflare-config-loader.js';
import {
    findMissingKeys,
    findMissingNonEmptyStringKeys,
    loadConfiguration,
} from './lib/config-loader.js';


const HELP_LINE_WIDTH = 80;


function wrapText(text, lineWidth) {
    const normalizedText = text.trim().replace(/\s+/g, ' ');
    if (!normalizedText) {
        return [];
    }

    const lines = [];
    const words = normalizedText.split(' ');
    let line = '';

    for (const word of words) {
        if (line && line.length + word.length + 1 <= lineWidth) {
            line += ` ${ word }`;
            continue;
        }

        if (line) {
            lines.push(line);
        }

        let remainingWord = word;
        while (remainingWord.length > lineWidth) {
            lines.push(remainingWord.slice(0, lineWidth));
            remainingWord = remainingWord.slice(lineWidth);
        }
        line = remainingWord;
    }

    if (line) {
        lines.push(line);
    }

    return lines;
}

function appendWrappedDescription(lines, description, initialPrefix) {
    let prefix = initialPrefix;

    // Keep space available for description text when an unusually long label
    // would otherwise consume the entire line width.
    if (prefix.length >= HELP_LINE_WIDTH) {
        lines.push(prefix.trimEnd());
        prefix = '    ';
    }

    const descriptionLines = wrapText(description, HELP_LINE_WIDTH - prefix.length);

    if (descriptionLines.length === 0) {
        lines.push(prefix.trimEnd());
        return;
    }

    lines.push(`${ prefix }${ descriptionLines[0] }`);

    const continuationPrefix = ' '.repeat(prefix.length);
    for (const line of descriptionLines.slice(1)) {
        lines.push(`${ continuationPrefix }${ line }`);
    }
}

function renderHelp(sections) {
    const {
        message,
        usage,
        description,
        positionals,
        options,
        commands,
        subCommands,
        requiredConfig,
        requiredSecrets,
        requiredCloudflareConfig,
    } = sections;

    const lines = [];

    if (message) {
        lines.push(message);
        lines.push('');
    }

    if (usage) {
        lines.push(`Usage: kixx.js ${ usage }`);
        lines.push('');
    }

    if (description) {
        appendWrappedDescription(lines, description, '  ');
        lines.push('');
    }

    if (positionals && positionals.length > 0) {
        lines.push('Arguments:');
        for (const positional of positionals) {
            appendWrappedDescription(lines, positional.description, `  ${ positional.name }  `);
        }
        lines.push('');
    }

    if (commands && commands.length > 0) {
        lines.push('');
        lines.push('Commands:');
        for (const cmd of commands) {
            appendWrappedDescription(lines, cmd.description, `  ${ cmd.name }  `);
        }
    }

    if (subCommands && subCommands.length > 0) {
        lines.push('');
        lines.push('Sub-commands:');
        for (const cmd of subCommands) {
            appendWrappedDescription(lines, cmd.description, `  ${ cmd.name }  `);
        }
    }

    if (options) {
        const globalOptions = {
            help: {
                type: 'boolean',
                description: 'Show this help',
            },
        };

        const opts = Object.assign({}, globalOptions, options);

        lines.push('');
        lines.push('Options:');

        for (const [ flagName, opt ] of Object.entries(opts)) {
            lines.push(`  --${ flagName }  ${ opt.type }  ${ opt.description || '' }`);
        }
    }

    appendRequiredSettings(lines, 'Required .kixx/config.json settings:', requiredConfig);
    appendRequiredSettings(lines, 'Required .kixx/secrets.json settings:', requiredSecrets);
    appendRequiredSettings(lines, 'Required cloudflare-config.js settings:', requiredCloudflareConfig);

    process.stdout.write(`${ lines.join('\n') }\n`);
}

function appendRequiredSettings(lines, heading, keyPaths) {
    if (!keyPaths || keyPaths.length === 0) {
        return;
    }

    lines.push('');
    lines.push(heading);

    for (const keyPath of keyPaths) {
        lines.push(`  ${ keyPath }`);
    }
}

function createCommandUsage(commandName, subCommandName, positionals = []) {
    const usageParts = [ commandName, subCommandName, '[options]' ];

    for (const positional of positionals) {
        const label = positional.required === false
            ? `[${ positional.name }]`
            : `<${ positional.name }>`;
        usageParts.push(label);
    }

    return usageParts.join(' ');
}

// Fails before the command is constructed so a command never runs partially
// configured, and so the message can name the files the value belongs in
// rather than surfacing as an assertion failure deep inside an API client.
function assertRequiredSettings(args) {
    const {
        commandLabel,
        settingsLabel,
        source,
        keyPaths,
        filepaths,
    } = args ?? {};

    const missing = findMissingKeys(source, keyPaths);

    if (missing.length === 0) {
        return;
    }

    const lines = [ `Missing required ${ settingsLabel } for "${ commandLabel }":` ];

    for (const keyPath of missing) {
        lines.push(`  ${ keyPath }`);
    }

    lines.push('');
    lines.push('Set them in one of these files:');

    for (const filepath of filepaths) {
        lines.push(`  ${ filepath }`);
    }

    throw new UsageError(lines.join('\n'));
}

function assertNonEmptyStringSettings(args) {
    const {
        commandLabel,
        settingsLabel,
        source,
        keyPaths,
        filepaths,
    } = args ?? {};
    const missing = findMissingNonEmptyStringKeys(source, keyPaths);

    assertRequiredSettings({
        commandLabel,
        settingsLabel,
        source: Object.fromEntries(missing.map((keyPath) => [ keyPath, undefined ])),
        keyPaths: missing,
        filepaths,
    });
}

async function main() {
    const args = parseArgs({
        strict: false,
        allowPositionals: true,
        allowNegative: false,
        options: {
            help: {
                type: 'boolean',
                short: 'h',
            },
        },
    });

    const devkitInstallDirectory = path.dirname(fileURLToPath(import.meta.url));

    const commandRegistry = new CommandRegistry(path.join(devkitInstallDirectory, 'commands'));

    const [ commandName, subCommandName ] = args.positionals;

    if (commandName) {
        const commandExists = await commandRegistry.commandExists(commandName);
        if (!commandExists) {
            const commands = await commandRegistry.listCommands();
            renderHelp({
                message: `The top level command "${ commandName }" does not exist.`,
                usage: '<command> <subcommand> [options] <...args>',
                commands,
            });
            return 1;
        }
    }

    let Command;

    if (commandName && subCommandName) {
        Command = await commandRegistry.resolveCommand(commandName, subCommandName);
        if (!Command) {
            const subCommands = await commandRegistry.listSubCommands(commandName);
            renderHelp({
                message: `The "${ commandName } ${ subCommandName }" sub command does not exist.`,
                usage: `${ commandName } <subcommand> [options] <...args>`,
                subCommands,
            });
            return 1;
        }
    }

    if (args.values.help) {
        if (Command) {
            renderHelp({
                usage: createCommandUsage(commandName, subCommandName, Command.positionals),
                description: Command.description,
                positionals: Command.positionals ?? [],
                options: Command.options ?? {},
                requiredConfig: Command.requiredConfig,
                requiredSecrets: Command.requiredSecrets,
                requiredCloudflareConfig: Command.requiredCloudflareConfig,
            });
            return 0;
        }
        if (!commandName) {
            const commands = await commandRegistry.listCommands();
            renderHelp({
                usage: '<command> <subcommand> [options] <...args>',
                commands,
            });
            return 0;
        }
        const subCommands = await commandRegistry.listSubCommands(commandName);
        renderHelp({
            usage: `${ commandName } <subcommand> [options] <...args>`,
            subCommands,
        });
        return 0;
    }

    if (!commandName) {
        const commands = await commandRegistry.listCommands();
        renderHelp({
            message: 'A top level command name is required as the first argument.',
            usage: '<command> <subcommand> [options] <...args>',
            commands,
        });
        return 1;
    }

    if (!subCommandName) {
        const subCommands = await commandRegistry.listSubCommands(commandName);
        renderHelp({
            message: 'A subcommand name is required as the second argument.',
            usage: `${ commandName } <subcommand> [options] <...args>`,
            subCommands,
        });
        return 1;
    }

    const commandArgs = parseArgs({
        // The command names select the module; only the remaining arguments
        // belong to the command implementation.
        args: process.argv.slice(4),
        allowPositionals: true,
        allowNegative: true,
        options: Command.options ?? {},
    });

    // Loaded here rather than at startup so help output and unresolved command
    // names still work in a directory holding a malformed config file.
    const configuration = await loadConfiguration();
    let cloudflareConfig;

    if (commandName === 'cloudflare') {
        cloudflareConfig = await loadCloudflareConfig(configuration.projectDirectory);

        assertNonEmptyStringSettings({
            commandLabel: `${ commandName } ${ subCommandName }`,
            settingsLabel: 'Cloudflare configuration settings',
            source: cloudflareConfig,
            keyPaths: Command.requiredCloudflareConfig,
            filepaths: [ path.join(configuration.projectDirectory, CLOUDFLARE_CONFIG_FILE_NAME) ],
        });
    }

    assertRequiredSettings({
        commandLabel: `${ commandName } ${ subCommandName }`,
        settingsLabel: 'configuration settings',
        source: configuration.config,
        keyPaths: Command.requiredConfig,
        filepaths: configuration.configFilepaths,
    });

    assertRequiredSettings({
        commandLabel: `${ commandName } ${ subCommandName }`,
        settingsLabel: 'secrets',
        source: configuration.secrets,
        keyPaths: Command.requiredSecrets,
        filepaths: configuration.secretsFilepaths,
    });

    const command = new Command({
        projectDirectory: configuration.projectDirectory,
        cloudflareConfig,
        config: configuration.config,
        secrets: configuration.secrets,
    });

    return await command.run(commandArgs.values, ...commandArgs.positionals);
}

main()
    .then((code) => {
        if (Number.isInteger(code)) {
            // Let Node flush any pending command output before exiting.
            process.exitCode = code;
        }
    })
    .catch((error) => {
        if (error.name === 'UsageError') {
            // eslint-disable-next-line no-console
            console.error(error.message);
        } else {
            // eslint-disable-next-line no-console
            console.error('Failed to run command:');
            // eslint-disable-next-line no-console
            console.error(error);
        }
        process.exitCode = 1;
    });

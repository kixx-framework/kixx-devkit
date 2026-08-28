#!/usr/bin/env node

import process from 'node:process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import CommandRegistry from './lib/command-registry.js';


const HELP_LINE_WIDTH = 80;


const config = {};
const secrets = {};


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
    } = sections;

    const lines = [];

    if (message) {
        lines.push(message);
        lines.push('');
    }

    if (usage) {
        lines.push(`Usage: kp.js ${ usage }`);
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

    process.stdout.write(`${ lines.join('\n') }\n`);
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

    const projectDirectory = path.dirname(fileURLToPath(import.meta.url));

    const commandRegistry = new CommandRegistry(path.join(projectDirectory, 'commands'));

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

    const command = new Command({
        projectDirectory: process.cwd(),
        config,
        secrets,
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

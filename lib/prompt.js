/**
 * Reads a value from the operator's terminal, or from an environment
 * variable when one is set.
 * @module prompt
 */

import readline from 'node:readline';
import process from 'node:process';
import { isNonEmptyString, isUndefined } from 'kixx-assert';

import UsageError from './usage-error.js';

/**
 * Resolves one value from an environment variable, or by prompting the
 * operator's terminal when the variable is absent.
 *
 * The environment variable is checked first and, when set to a non-empty
 * string, is returned without touching the input stream at all. Otherwise
 * the input stream must be a TTY; a non-interactive stream fails immediately
 * rather than blocking, naming the environment variable the caller can set
 * instead.
 * @param {Object} args - Prompt configuration
 * @param {string} args.envVar - Environment variable that bypasses the prompt
 * @param {string} args.label - Operator-facing prompt label, such as "Admin password"
 * @param {boolean} [args.mask=false] - Suppress echo of the typed value
 * @param {NodeJS.ReadableStream} [args.input=process.stdin] - Input stream to read from
 * @param {NodeJS.WritableStream} [args.output=process.stdout] - Output stream for the prompt and echo
 * @returns {Promise<string>} The resolved value, trimmed when read from the terminal
 * @throws {UsageError} When the environment variable is absent and the input stream is not a TTY, or the prompt is cancelled before a value is entered
 */
export async function promptForValue(args) {
    const {
        envVar,
        label,
        mask = false,
        input = process.stdin,
        output = process.stdout,
    } = args ?? {};

    const envValue = readEnvironmentValue(envVar);
    if (!isUndefined(envValue)) {
        return envValue;
    }

    if (!input.isTTY) {
        throw new UsageError(
            `${ label } is required. Set the ${ envVar } environment variable, or run this command from a terminal.`,
        );
    }

    return await readLineFromTerminal({ label, mask, input, output });
}

/**
 * Resolves one value by prompting twice and requiring both entries to match.
 *
 * Used for a new password, where a typo would otherwise create a credential
 * nobody can use. When the environment variable bypass applies, the value is
 * returned directly and the terminal is never touched.
 * @param {Object} args - Prompt configuration
 * @param {string} args.envVar - Environment variable that bypasses both prompts
 * @param {string} args.label - Operator-facing label for the first prompt
 * @param {string} [args.confirmLabel] - Operator-facing label for the second prompt, defaults to "Confirm <label>"
 * @param {boolean} [args.mask=true] - Suppress echo of the typed value
 * @param {NodeJS.ReadableStream} [args.input=process.stdin] - Input stream to read from
 * @param {NodeJS.WritableStream} [args.output=process.stdout] - Output stream for the prompt and echo
 * @returns {Promise<string>} The confirmed value
 * @throws {UsageError} When the two entries differ, or under the same conditions as {@link promptForValue}
 */
export async function promptForValueTwice(args) {
    const {
        envVar,
        label,
        confirmLabel = `Confirm ${ label }`,
        mask = true,
        input = process.stdin,
        output = process.stdout,
    } = args ?? {};

    const first = await promptForValue({ envVar, label, mask, input, output });
    const second = await promptForValue({ envVar, label: confirmLabel, mask, input, output });

    if (first !== second) {
        throw new UsageError(`${ label } entries did not match.`);
    }

    return first;
}

/**
 * Requires the operator to type an exact confirmation string before a
 * destructive action proceeds. Unlike {@link promptForValue}, this has no
 * environment variable bypass — callers offer their own flag (such as
 * `--yes`) for scripted use, and skip calling this at all when that flag is
 * set.
 * @param {Object} args - Confirmation configuration
 * @param {string} args.label - Operator-facing prompt label
 * @param {string} args.expected - Exact text the operator must type to proceed
 * @param {NodeJS.ReadableStream} [args.input=process.stdin] - Input stream to read from
 * @param {NodeJS.WritableStream} [args.output=process.stdout] - Output stream for the prompt
 * @returns {Promise<void>} Resolves when the typed value matches
 * @throws {UsageError} When stdin is not a TTY, or the typed value does not match
 */
export async function promptForConfirmation(args) {
    const {
        label,
        expected,
        input = process.stdin,
        output = process.stdout,
    } = args ?? {};

    if (!input.isTTY) {
        throw new UsageError(`${ label } requires a typed confirmation, but stdin is not a terminal.`);
    }

    const typed = await readLineFromTerminal({ label, mask: false, input, output });

    if (typed !== expected) {
        throw new UsageError('Confirmation did not match the expected value; aborting.');
    }
}

function readEnvironmentValue(envVar) {
    const value = process.env[envVar];

    if (isNonEmptyString(value) && value.trim().length > 0) {
        return value;
    }

    return undefined;
}

function readLineFromTerminal(args) {
    const { label, mask, input, output } = args;

    return new Promise((resolve, reject) => {
        const rl = readline.createInterface({ input, output, terminal: true });

        if (mask) {
            // readline has no public option for a silent prompt. Overriding
            // this internal hook is the standard workaround for suppressing
            // per-keystroke echo without hand-rolling raw mode handling.
            rl._writeToOutput = () => {};
        }

        output.write(`${ label }: `);

        rl.on('line', (line) => {
            if (mask) {
                output.write('\n');
            }
            // Resolve before closing: closing emits 'close', and the promise
            // must already be settled so that handler's rejection is a no-op.
            resolve(line.trim());
            rl.close();
        });

        // Fires on EOF (Ctrl-D) and on Ctrl-C, as well as after our own
        // rl.close() call above. The promise settles only once, so this is a
        // no-op when a line was already resolved.
        rl.on('close', () => {
            reject(new UsageError(`${ label } was not provided.`));
        });
    });
}

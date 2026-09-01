import { PassThrough } from 'node:stream';
import process from 'node:process';

import { describe } from 'kixx-test';
import { assert, assertEqual } from 'kixx-assert';

import { promptForValue, promptForValueTwice, promptForConfirmation } from '../../../lib/prompt.js';

const ENV_VAR = 'KIXX_TEST_PROMPT_VALUE';


describe('prompt', ({ it }) => {
    it('returns a set environment variable without reading the input stream', async () => {
        process.env[ENV_VAR] = 'from-env';
        const input = makeTerminal({ isTTY: true });

        try {
            const value = await promptForValue({
                envVar: ENV_VAR,
                label: 'Value',
                input,
                output: input.output,
            });

            assertEqual('from-env', value);
            assertEqual('', input.written());
        } finally {
            delete process.env[ENV_VAR];
        }
    });

    it('treats an empty or whitespace-only environment variable as absent', async () => {
        process.env[ENV_VAR] = '   ';
        const input = makeTerminal({ isTTY: true });

        const promise = promptForValue({
            envVar: ENV_VAR,
            label: 'Value',
            input,
            output: input.output,
        });

        input.write('typed-value\n');
        const value = await promise;

        delete process.env[ENV_VAR];
        assertEqual('typed-value', value);
    });

    it('reads a visible line from the input stream and returns it trimmed', async () => {
        const input = makeTerminal({ isTTY: true });

        const promise = promptForValue({
            envVar: ENV_VAR,
            label: 'Value',
            input,
            output: input.output,
        });

        input.write('  hello world  \n');
        const value = await promise;

        assertEqual('hello world', value);
    });

    it('reads a masked line without echoing the typed characters', async () => {
        const input = makeTerminal({ isTTY: true });

        const promise = promptForValue({
            envVar: ENV_VAR,
            label: 'Secret',
            mask: true,
            input,
            output: input.output,
        });

        input.write('super-secret\n');
        const value = await promise;

        assertEqual('super-secret', value);
        assert(
            !input.written().includes('super-secret'),
            'expected the output stream to never contain the typed secret',
        );
    });

    it('throws a UsageError naming the environment variable when stdin is not a TTY', async () => {
        const input = makeTerminal({ isTTY: false });

        const caught = await catchAsyncError(() => {
            return promptForValue({
                envVar: ENV_VAR,
                label: 'Value',
                input,
                output: input.output,
            });
        });

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes(ENV_VAR), 'expected the message to name the env var');
    });

    it('produces a UsageError instead of hanging on EOF', async () => {
        const input = makeTerminal({ isTTY: true });

        const promise = promptForValue({
            envVar: ENV_VAR,
            label: 'Value',
            input,
            output: input.output,
        });

        input.end();
        const caught = await catchAsyncError(() => promise);

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
    });

    it('prompts twice and succeeds when both entries match', async () => {
        const input = makeTerminal({ isTTY: true });

        const promise = promptForValueTwice({
            envVar: ENV_VAR,
            label: 'Password',
            input,
            output: input.output,
        });

        input.write('matching-value\n');
        input.write('matching-value\n');
        const value = await promise;

        assertEqual('matching-value', value);
    });

    it('throws a UsageError without revealing either value when entries differ', async () => {
        const input = makeTerminal({ isTTY: true });

        const promise = promptForValueTwice({
            envVar: ENV_VAR,
            label: 'Password',
            input,
            output: input.output,
        });

        input.write('first-value\n');
        input.write('second-value\n');
        const caught = await catchAsyncError(() => promise);

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(!caught.message.includes('first-value'));
        assert(!caught.message.includes('second-value'));
    });
    it('resolves when the typed confirmation matches exactly', async () => {
        const input = makeTerminal({ isTTY: true });

        const promise = promptForConfirmation({
            label: 'Type the migration id',
            expected: 'example-noop',
            input,
            output: input.output,
        });

        input.write('example-noop\n');
        await promise;
    });

    it('throws a UsageError when the typed confirmation does not match', async () => {
        const input = makeTerminal({ isTTY: true });

        const promise = promptForConfirmation({
            label: 'Type the migration id',
            expected: 'example-noop',
            input,
            output: input.output,
        });

        input.write('wrong\n');
        const caught = await catchAsyncError(() => promise);

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
    });

    it('throws a UsageError for a confirmation when stdin is not a TTY', async () => {
        const input = makeTerminal({ isTTY: false });

        const caught = await catchAsyncError(() => promptForConfirmation({
            label: 'Type the migration id',
            expected: 'example-noop',
            input,
            output: input.output,
        }));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
    });
});

function makeTerminal(options) {
    const { isTTY } = options ?? {};
    const input = new PassThrough();
    const output = new PassThrough();

    input.isTTY = isTTY;

    let buffer = '';
    output.on('data', (chunk) => {
        buffer += chunk.toString();
    });

    input.output = output;
    input.written = () => buffer;

    return input;
}

async function catchAsyncError(fn) {
    try {
        await fn();
    } catch (error) {
        return error;
    }
    return null;
}

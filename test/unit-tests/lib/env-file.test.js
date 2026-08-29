import { describe } from 'kixx-test';
import { assert, assertEqual } from 'kixx-assert';
import { readEnvFile } from '../../../lib/env-file.js';


describe('env-file', ({ it }) => {
    it('returns a plain object of name to string for a well-formed file', async () => {
        const fileSystem = makeFileSystem({
            '/app/.env.production': [
                'APP_NAME=widget-api',
                'PORT=3000',
            ].join('\n'),
        });

        const values = await readEnvFile({ projectDirectory: '/app', environment: 'production', fileSystem });

        assertEqual('widget-api', values.APP_NAME);
        assertEqual('3000', values.PORT);
    });

    it('throws a UsageError naming the expected path when the file is missing', async () => {
        const fileSystem = makeFileSystem({});

        const caught = await catchAsyncError(() => {
            return readEnvFile({ projectDirectory: '/app', environment: 'production', fileSystem });
        });

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('/app/.env.production'), 'expected the message to name the path');
    });

    it('skips blank lines and full-line comments', async () => {
        const fileSystem = makeFileSystem({
            '/app/.env.production': [
                '',
                '# a comment',
                '   # an indented comment',
                'NAME=value',
                '',
            ].join('\n'),
        });

        const values = await readEnvFile({ projectDirectory: '/app', environment: 'production', fileSystem });

        assertEqual(1, Object.keys(values).length);
        assertEqual('value', values.NAME);
    });

    it('preserves a hash character inside a value', async () => {
        const fileSystem = makeFileSystem({
            '/app/.env.production': 'TOKEN=abc#def',
        });

        const values = await readEnvFile({ projectDirectory: '/app', environment: 'production', fileSystem });

        assertEqual('abc#def', values.TOKEN);
    });

    it('strips one layer of matching quotes, leaving an inner quote of the other kind', async () => {
        const fileSystem = makeFileSystem({
            '/app/.env.production': [
                'DOUBLE="say \'hi\'"',
                'SINGLE=\'say "hi"\'',
            ].join('\n'),
        });

        const values = await readEnvFile({ projectDirectory: '/app', environment: 'production', fileSystem });

        assertEqual('say \'hi\'', values.DOUBLE);
        assertEqual('say "hi"', values.SINGLE);
    });

    it('yields an empty string for an empty value', async () => {
        const fileSystem = makeFileSystem({
            '/app/.env.production': 'EMPTY=',
        });

        const values = await readEnvFile({ projectDirectory: '/app', environment: 'production', fileSystem });

        assertEqual('', values.EMPTY);
    });

    it('throws a UsageError naming the line number for a malformed line', async () => {
        const fileSystem = makeFileSystem({
            '/app/.env.production': [ 'NAME=value', 'not-a-valid-line' ].join('\n'),
        });

        const caught = await catchAsyncError(() => {
            return readEnvFile({ projectDirectory: '/app', environment: 'production', fileSystem });
        });

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('line 2'), 'expected the message to name the line number');
    });

    it('throws a UsageError naming an invalid name', async () => {
        const fileSystem = makeFileSystem({
            '/app/.env.production': '1NAME=value',
        });

        const caught = await catchAsyncError(() => {
            return readEnvFile({ projectDirectory: '/app', environment: 'production', fileSystem });
        });

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('1NAME'), 'expected the message to name the key');
    });

    it('throws a UsageError naming both line numbers for a duplicate name', async () => {
        const fileSystem = makeFileSystem({
            '/app/.env.production': [ 'NAME=one', 'NAME=two' ].join('\n'),
        });

        const caught = await catchAsyncError(() => {
            return readEnvFile({ projectDirectory: '/app', environment: 'production', fileSystem });
        });

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('lines 1 and 2'), 'expected the message to name both lines');
    });

    it('does not let a __proto__ key pollute the returned object', async () => {
        const fileSystem = makeFileSystem({
            '/app/.env.production': '__proto__=value',
        });

        const values = await readEnvFile({ projectDirectory: '/app', environment: 'production', fileSystem });

        assertEqual('value', values.__proto__);
        assertEqual(Object.prototype, Object.getPrototypeOf({}));
        assertEqual(null, Object.getPrototypeOf(values));
    });

    it('parses \\r\\n line endings identically to \\n', async () => {
        const fileSystem = makeFileSystem({
            '/app/.env.production': [ 'ONE=1', 'TWO=2' ].join('\r\n'),
        });

        const values = await readEnvFile({ projectDirectory: '/app', environment: 'production', fileSystem });

        assertEqual('1', values.ONE);
        assertEqual('2', values.TWO);
    });

    it('parses a copy of the sample example.env content', async () => {
        const contents = [
            'APP_NAME=kixx_ref',
            'ENVIRONMENT=development',
            'LOG_LEVEL=info',
            '',
            '# Rotating DOCUMENT_STORE_CURSOR_SIGNING_SECRET invalidates every cursor',
            '# currently in flight — anyone mid-pagination gets a 400 on their next page.',
            'DOCUMENT_STORE_CURSOR_SIGNING_SECRET=secure-long-random-string',
            '',
            '# Rotating CSRF_TOKEN_SIGNING_SECRET invalidates every CSRF form currently',
            '# open — anyone mid-edit gets a rejection on submit.',
            'CSRF_TOKEN_SIGNING_SECRET=secure-long-random-string',
            '',
            '# Remove after bootstrapping with the first admin user.',
            'ADMIN_BOOTSTRAP_TOKEN=dev_admin_bootstrap_token_change_me',
        ].join('\n');

        const fileSystem = makeFileSystem({ '/app/.env.production': contents });

        const values = await readEnvFile({ projectDirectory: '/app', environment: 'production', fileSystem });

        assertEqual('kixx_ref', values.APP_NAME);
        assertEqual('development', values.ENVIRONMENT);
        assertEqual('info', values.LOG_LEVEL);
        assertEqual('secure-long-random-string', values.DOCUMENT_STORE_CURSOR_SIGNING_SECRET);
        assertEqual('secure-long-random-string', values.CSRF_TOKEN_SIGNING_SECRET);
        assertEqual('dev_admin_bootstrap_token_change_me', values.ADMIN_BOOTSTRAP_TOKEN);
    });
});

function makeFileSystem(files) {
    return {
        async readFile(filepath) {
            if (!Object.prototype.hasOwnProperty.call(files, filepath)) {
                throw new Error(`ENOENT: no such file, open '${ filepath }'`);
            }

            return files[filepath];
        },
    };
}

async function catchAsyncError(fn) {
    try {
        await fn();
    } catch (error) {
        return error;
    }
    return null;
}

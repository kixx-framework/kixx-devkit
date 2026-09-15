import { describe } from 'kixx-test';
import { assert, assertEqual } from 'kixx-assert';
import {
    readDeclaredSecretNames,
    readEnvFiles,
    readEnvValues,
} from '../../../lib/env-file.js';

const ENVARS_FILEPATH = '/app/.env.production';
const SECRETS_FILEPATH = '/app/.env.production.secrets';
const DECLARATIONS_FILEPATH = '/app/example.env.secrets';


describe('env-file', ({ it }) => {
    it('reads one dotenv value file without requiring an environment pair', async () => {
        const values = await readEnvValues({
            filepath: SECRETS_FILEPATH,
            fileSystem: makeFileSystem({
                [SECRETS_FILEPATH]: [ 'TOKEN="actual value"', 'EMPTY=' ].join('\n'),
            }),
        });

        assertEqual('actual value', values.TOKEN);
        assertEqual('', values.EMPTY);
    });

    it('returns sorted declared secret names without returning example values', async () => {
        const exampleValue = 'EXAMPLE_VALUE_MUST_NOT_ESCAPE';
        const names = await readDeclarations([
            '# COMMENTED_OUT=ignored',
            `ZETA=${ exampleValue }`,
            'EMPTY=',
            'ALPHA="another example"',
        ].join('\n'));

        assertEqual('ALPHA,EMPTY,ZETA', names.join(','));
        assert(!JSON.stringify(names).includes(exampleValue), 'expected example value to be absent');
        assert(!names.includes('COMMENTED_OUT'), 'expected comments not to declare names');
    });

    it('throws a focused UsageError when the declaration file is missing', async () => {
        const caught = await catchAsyncError(() => {
            return readDeclaredSecretNames({
                projectDirectory: '/app',
                fileSystem: makeFileSystem({}),
            });
        });

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes(DECLARATIONS_FILEPATH), 'expected the declaration path');
        assert(caught.message.includes('declares the Worker secret names'), 'expected the file role');
    });

    it('rejects malformed declarations without exposing their example values', async () => {
        const exampleValue = 'EXAMPLE_VALUE_MUST_NOT_ESCAPE';
        const caught = await catchAsyncError(() => {
            return readDeclarations(`malformed ${ exampleValue }`);
        });

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('line 1'), 'expected the line number');
        assert(!caught.message.includes(exampleValue), 'expected example value to be absent');
    });

    it('rejects invalid and duplicate declarations with focused locations', async () => {
        const invalid = await catchAsyncError(() => readDeclarations('1TOKEN=example'));
        const duplicate = await catchAsyncError(() => {
            return readDeclarations([ 'TOKEN=first', 'TOKEN=second' ].join('\n'));
        });

        assertEqual('UsageError', invalid.name);
        assert(invalid.message.includes('1TOKEN'), 'expected the invalid name');
        assert(invalid.message.includes('line 1'), 'expected the invalid-name line');
        assertEqual('UsageError', duplicate.name);
        assert(duplicate.message.includes('lines 1 and 2'), 'expected both duplicate lines');
        assert(!duplicate.message.includes('first'), 'expected first example value to be absent');
        assert(!duplicate.message.includes('second'), 'expected second example value to be absent');
    });

    it('returns both files as separate plain objects of name to string', async () => {
        const { envars, secrets } = await readBoth({
            [ENVARS_FILEPATH]: [ 'ENVIRONMENT=production', 'PORT=3000' ].join('\n'),
            [SECRETS_FILEPATH]: 'CSRF_TOKEN_SIGNING_SECRET=shh',
        });

        assertEqual('production', envars.ENVIRONMENT);
        assertEqual('3000', envars.PORT);
        assertEqual('shh', secrets.CSRF_TOKEN_SIGNING_SECRET);

        // The two halves stay separate: a deployment derives the binding type
        // from which object a value arrived in.
        assertEqual(undefined, envars.CSRF_TOKEN_SIGNING_SECRET);
        assertEqual(undefined, secrets.PORT);
    });

    it('throws a UsageError naming the expected path when the plain file is missing', async () => {
        const caught = await catchAsyncError(() => {
            return readExactly({ [SECRETS_FILEPATH]: 'TOKEN=shh' });
        });

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes(ENVARS_FILEPATH), 'expected the message to name the path');
    });

    it('throws a UsageError naming the expected path when the secrets file is missing', async () => {
        const caught = await catchAsyncError(() => {
            return readExactly({ [ENVARS_FILEPATH]: 'PORT=3000' });
        });

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes(SECRETS_FILEPATH), 'expected the message to name the secrets path');
    });

    it('returns empty objects for two empty files', async () => {
        const { envars, secrets } = await readBoth({
            [ENVARS_FILEPATH]: '',
            [SECRETS_FILEPATH]: '',
        });

        assertEqual(0, Object.keys(envars).length);
        assertEqual(0, Object.keys(secrets).length);
    });

    it('skips blank lines and full-line comments', async () => {
        const { envars } = await readBoth({
            [ENVARS_FILEPATH]: [
                '',
                '# a comment',
                '   # an indented comment',
                'NAME=value',
                '',
            ].join('\n'),
        });

        assertEqual(1, Object.keys(envars).length);
        assertEqual('value', envars.NAME);
    });

    it('preserves a hash character inside a value', async () => {
        const { secrets } = await readBoth({ [SECRETS_FILEPATH]: 'TOKEN=abc#def' });

        assertEqual('abc#def', secrets.TOKEN);
    });

    it('strips one layer of matching quotes, leaving an inner quote of the other kind', async () => {
        const { envars } = await readBoth({
            [ENVARS_FILEPATH]: [
                'DOUBLE="say \'hi\'"',
                'SINGLE=\'say "hi"\'',
            ].join('\n'),
        });

        assertEqual('say \'hi\'', envars.DOUBLE);
        assertEqual('say "hi"', envars.SINGLE);
    });

    it('yields an empty string for an empty value', async () => {
        const { envars } = await readBoth({ [ENVARS_FILEPATH]: 'EMPTY=' });

        assertEqual('', envars.EMPTY);
    });

    it('throws a UsageError naming the line number for a malformed line', async () => {
        const caught = await catchAsyncError(() => {
            return readBoth({ [ENVARS_FILEPATH]: [ 'NAME=value', 'not-a-valid-line' ].join('\n') });
        });

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('line 2'), 'expected the message to name the line number');
    });

    it('throws a UsageError naming the secrets file for a malformed line in it', async () => {
        const caught = await catchAsyncError(() => {
            return readBoth({ [SECRETS_FILEPATH]: 'not-a-valid-line' });
        });

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes(SECRETS_FILEPATH), 'expected the message to name the secrets path');
    });

    it('throws a UsageError naming an invalid name', async () => {
        const caught = await catchAsyncError(() => {
            return readBoth({ [ENVARS_FILEPATH]: '1NAME=value' });
        });

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('1NAME'), 'expected the message to name the key');
    });

    it('throws a UsageError naming both line numbers for a duplicate name', async () => {
        const caught = await catchAsyncError(() => {
            return readBoth({ [ENVARS_FILEPATH]: [ 'NAME=one', 'NAME=two' ].join('\n') });
        });

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('lines 1 and 2'), 'expected the message to name both lines');
    });

    // A name in both files is a deployment misconfiguration, but it is not this
    // module's to detect: it can only be recognized as one collision among
    // several kinds, alongside the config-block binding names.
    it('returns a name appearing in both files, leaving the collision to the caller', async () => {
        const { envars, secrets } = await readBoth({
            [ENVARS_FILEPATH]: 'TOKEN=plain',
            [SECRETS_FILEPATH]: 'TOKEN=secret',
        });

        assertEqual('plain', envars.TOKEN);
        assertEqual('secret', secrets.TOKEN);
    });

    it('does not let a __proto__ key pollute the returned objects', async () => {
        const { envars } = await readBoth({ [ENVARS_FILEPATH]: '__proto__=value' });

        assertEqual('value', envars.__proto__);
        assertEqual(Object.prototype, Object.getPrototypeOf({}));
        assertEqual(null, Object.getPrototypeOf(envars));
    });

    it('parses \\r\\n line endings identically to \\n', async () => {
        const { envars } = await readBoth({ [ENVARS_FILEPATH]: [ 'ONE=1', 'TWO=2' ].join('\r\n') });

        assertEqual('1', envars.ONE);
        assertEqual('2', envars.TWO);
    });

    it('parses a copy of the sample example.env and example.env.secrets content', async () => {
        const envarsContents = [
            '# Non-secret environment variables. This file is committed, and a deployment',
            '# binds every value in it as plain text.',
            '',
            'ENVIRONMENT=development',
            '',
            '# Trust the X-Forwarded-For header when resolving a request\'s client IP.',
            'TRUST_PROXY=false',
            '',
            '# Identifies a single deploy. Usually set by CI rather than written here.',
            '# BUILD_ID=',
            '',
            '# The Node.js server port. Defaults to 2026 and is overridable by --port.',
            '# PORT=2026',
        ].join('\n');

        const secretsContents = [
            '# Secrets only. This file is the template for .env.<environment>.secrets.',
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

        const { envars, secrets } = await readBoth({
            [ENVARS_FILEPATH]: envarsContents,
            [SECRETS_FILEPATH]: secretsContents,
        });

        assertEqual('development', envars.ENVIRONMENT);
        assertEqual('false', envars.TRUST_PROXY);
        assertEqual(2, Object.keys(envars).length);

        assertEqual('secure-long-random-string', secrets.DOCUMENT_STORE_CURSOR_SIGNING_SECRET);
        assertEqual('secure-long-random-string', secrets.CSRF_TOKEN_SIGNING_SECRET);
        assertEqual('dev_admin_bootstrap_token_change_me', secrets.ADMIN_BOOTSTRAP_TOKEN);
    });
});

// Both files are required, so a test naming only one of them gets an empty
// stand-in for the other rather than a missing-file error it did not intend.
function readBoth(files) {
    return readExactly({ [ENVARS_FILEPATH]: '', [SECRETS_FILEPATH]: '', ...files });
}

function readExactly(files) {
    return readEnvFiles({
        projectDirectory: '/app',
        environment: 'production',
        fileSystem: makeFileSystem(files),
    });
}

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

function readDeclarations(text) {
    return readDeclaredSecretNames({
        projectDirectory: '/app',
        fileSystem: makeFileSystem({ [DECLARATIONS_FILEPATH]: text }),
    });
}

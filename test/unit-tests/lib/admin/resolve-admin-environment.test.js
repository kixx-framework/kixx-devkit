import { describe } from 'kixx-test';
import { assert, assertEqual } from 'kixx-assert';

import resolveAdminEnvironment from '../../../../lib/admin/resolve-admin-environment.js';

describe('admin/resolve-admin-environment', ({ it }) => {
    it('resolves the origin and builds a client through the factory', () => {
        const config = { app: { environments: { production: { origin: 'https://admin.example.test' } } } };
        const clientOptions = [];
        const fakeClient = {};

        const result = resolveAdminEnvironment({
            environment: 'production',
            config,
            email: 'root@example.test',
            password: 'secret',
            createClient: (options) => {
                clientOptions.push(options);
                return fakeClient;
            },
        });

        assertEqual('production', result.environment);
        assertEqual('https://admin.example.test', result.origin);
        assertEqual(fakeClient, result.client);
        assertEqual(1, clientOptions.length);
        assertEqual('https://admin.example.test', clientOptions[0].origin);
        assertEqual('root@example.test', clientOptions[0].email);
        assertEqual('secret', clientOptions[0].password);
    });

    it('prefers an --origin override over the configured value', () => {
        const config = { app: { environments: { production: { origin: 'https://admin.example.test' } } } };

        const result = resolveAdminEnvironment({
            environment: 'production',
            config,
            origin: 'https://override.example.test',
            createClient: (options) => options,
        });

        assertEqual('https://override.example.test', result.origin);
    });

    it('throws a UsageError when the origin is not configured', () => {
        const caught = catchError(() => resolveAdminEnvironment({
            environment: 'staging',
            config: {},
        }));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('app.environments.staging.origin'));
    });

    it('throws a UsageError when --environment is missing', () => {
        const caught = catchError(() => resolveAdminEnvironment({ config: {} }));

        assert(caught, 'expected an error to be thrown');
        assertEqual('UsageError', caught.name);
        assert(caught.message.includes('--environment'));
    });
});

function catchError(fn) {
    try {
        fn();
    } catch (error) {
        return error;
    }
    return null;
}

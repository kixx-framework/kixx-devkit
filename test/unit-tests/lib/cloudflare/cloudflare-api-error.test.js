import { describe } from 'kixx-test';
import { assert, assertEqual, assertNotEqual } from 'kixx-assert';
import CloudflareApiError from '../../../../lib/cloudflare/cloudflare-api-error.js';


describe('CloudflareApiError', ({ it }) => {
    it('sets name and code as enumerable own properties', () => {
        const error = new CloudflareApiError('boom', {
            status: 404,
            method: 'GET',
            url: 'https://example.com',
        });

        assertEqual('CloudflareApiError', error.name);
        assertEqual('CloudflareApiError', error.code);
        assert(Object.prototype.propertyIsEnumerable.call(error, 'name'));
        assert(Object.prototype.propertyIsEnumerable.call(error, 'code'));
    });

    it('carries the HTTP status, method, and url', () => {
        const error = new CloudflareApiError('boom', {
            status: 404,
            method: 'GET',
            url: 'https://example.com/widgets',
        });

        assertEqual(404, error.status);
        assertEqual('GET', error.method);
        assertEqual('https://example.com/widgets', error.url);
    });

    it('defaults errors to an empty array', () => {
        const error = new CloudflareApiError('boom', {
            status: 200,
            method: 'GET',
            url: 'https://example.com',
        });

        assertEqual(0, error.errors.length);
    });

    it('copies the errors array rather than referencing it', () => {
        const errors = [ { code: 10007, message: 'not found' } ];
        const error = new CloudflareApiError('boom', {
            status: 200,
            errors,
            method: 'GET',
            url: 'https://example.com',
        });

        assertEqual(1, error.errors.length);
        assertEqual('not found', error.errors[0].message);
        assertNotEqual(errors, error.errors);
    });

    it('preserves the message text', () => {
        const error = new CloudflareApiError('Unexpected HTTP status 404 from GET https://example.com', {
            status: 404,
            method: 'GET',
            url: 'https://example.com',
        });

        assertEqual('Unexpected HTTP status 404 from GET https://example.com', error.message);
    });
});

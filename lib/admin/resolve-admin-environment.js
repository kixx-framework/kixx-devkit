import resolveEnvironmentOrigin from '../resolve-environment-origin.js';
import AdminAPIClient from './admin-api-client.js';

/**
 * Resolves one environment's Admin API connection settings.
 *
 * Admin credentials are not resolved here; the caller acquires them (through
 * `lib/prompt.js`) and passes them in, which keeps this function free of
 * terminal I/O and synchronous.
 * @param {Object} args - Environment inputs and dependencies
 * @param {string} args.environment - Environment name
 * @param {Object} args.config - Merged Kixx configuration
 * @param {string} [args.origin] - Explicit origin override
 * @param {string} [args.email] - Admin account email for HTTP Basic auth
 * @param {string} [args.password] - Admin account password for HTTP Basic auth
 * @param {Function} [args.createClient] - Admin client factory
 * @returns {{environment: string, origin: string, client: Object}} Resolved connection
 * @throws {UsageError} When the environment or origin is missing
 */
export default function resolveAdminEnvironment(args) {
    const {
        environment,
        config,
        origin: originOverride,
        email,
        password,
        createClient = (options) => new AdminAPIClient(options),
    } = args ?? {};

    const origin = resolveEnvironmentOrigin({
        environment,
        config,
        origin: originOverride,
    });

    return {
        environment,
        origin,
        client: createClient({ origin, email, password }),
    };
}

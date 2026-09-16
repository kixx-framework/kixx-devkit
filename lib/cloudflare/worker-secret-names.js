/**
 * Reads which secrets a remote Cloudflare Worker version holds and compares
 * them with the names declared in `example.env.secrets`. The remote version is
 * the only source of truth for secret presence; no local record is consulted.
 * @module worker-secret-names
 */

// A plain_text binding sharing a declared name must not count: inheriting it
// would carry a non-secret value into the new version under a secret's name.
const SECRET_BINDING_TYPES = new Set([ 'secret_text', 'secret_key' ]);

/**
 * @typedef {Object} SecretNameComparison
 * @property {string[]} missing - Declared names the version holds no secret binding for, sorted.
 * @property {string[]} undeclared - Secret binding names on the version that are not declared, sorted.
 */

/**
 * @param {Object} binding - Binding from a remote Worker version.
 * @returns {boolean} Whether the binding holds a secret value.
 */
export function isSecretBinding(binding) {
    return SECRET_BINDING_TYPES.has(binding?.type);
}

/**
 * @param {Object} version - Worker version returned by Cloudflare's get-version endpoint.
 * @returns {string[]} Sorted unique names of the version's secret bindings.
 * @throws {Error} When the version carries no bindings list, because treating
 *     that as "no secrets" or "all secrets" would both be guesses.
 */
export function readSecretBindingNames(version) {
    const bindings = version?.resources?.bindings ?? version?.bindings;
    if (!Array.isArray(bindings)) {
        throw new Error(`Cloudflare returned Worker version ${ version?.id ?? '(unknown)' } without a bindings list`);
    }

    const names = bindings
        .filter(isSecretBinding)
        .map((binding) => binding.name);

    return Array.from(new Set(names)).sort();
}

/**
 * @param {Object} args - Names to compare.
 * @param {string[]} args.declaredNames - Names declared in `example.env.secrets`.
 * @param {string[]} args.remoteNames - Secret binding names present on a remote version.
 * @returns {SecretNameComparison} Declared names missing remotely and remote names not declared.
 */
export function compareSecretNames(args) {
    const { declaredNames, remoteNames } = args ?? {};
    const declared = new Set(declaredNames);
    const remote = new Set(remoteNames);

    return {
        missing: declaredNames.filter((name) => !remote.has(name)).sort(),
        undeclared: remoteNames.filter((name) => !declared.has(name)).sort(),
    };
}

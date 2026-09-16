export const description = 'Tools for working directly with Cloudflare';

export const subcommands = {
    'recover-secret-version': {
        description: 'Verify an explicit secret-only Worker version and recover its local state',
    },
    'create-worker': {
        description: 'Create a new Worker from scratch',
    },
    'create-worker-version': {
        description: 'Bundle, hash, and idempotently upload a Cloudflare Worker version',
    },
    'deploy-version': {
        description: 'Route all traffic to an existing Cloudflare Worker version',
    },
    'set-secret': {
        description: 'Create an undeployed Worker version with one added or replaced secret',
    },
    'delete-secret': {
        description: 'Create an undeployed Worker version with one removed secret',
    },
    'set-secrets': {
        description: 'Create an undeployed Worker version with additive secrets from a dotenv file',
    },
    release: {
        description: 'Create, publish, and deploy a Worker release in safe order',
    },
};

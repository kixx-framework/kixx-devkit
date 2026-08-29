export const description = 'Tools for working directly with Cloudflare';

export const subcommands = {
    'create-worker': {
        description: 'Create a new Worker from scratch',
    },
    'create-worker-version': {
        description: 'Bundle, hash, and idempotently upload a Cloudflare Worker version',
    },
};

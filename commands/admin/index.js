export const description = 'Application administration tools';

export const subcommands = {
    'gen-secure-token': {
        description: `
            Generate a 256-bit secure token encoded as lowercase hexadecimal
            text, suitable for things like the ADMIN_BOOTSTRAP_TOKEN
        `,
    },
    'accept-invite': {
        description: `
            Redeem a one-time admin invite or bootstrap token and create the
            admin account it grants
        `,
    },
    'create-publishing-token': {
        description: `
            Mint a bearer token for the Publishing API, authenticating as an
            existing admin
        `,
    },
    'list-migrations': {
        description: `
            List every registered migration with its durable status
        `,
    },
    'run-migration': {
        description: `
            Run one bounded batch of a migration, in dry-run or real mode
        `,
    },
};

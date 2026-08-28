export const description = 'Application administration tools';

export const subcommands = {
    'gen-secure-token': {
        description: `
            Generate a 256-bit secure token encoded as lowercase hexadecimal
            text, suitable for things like the ADMIN_BOOTSTRAP_TOKEN
        `,
    },
};

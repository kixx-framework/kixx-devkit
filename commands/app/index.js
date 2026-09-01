export const description = 'Publish application content';

export const subcommands = {
    'assign-build': {
        description: 'Assign an existing Release to a build under a pointer precondition',
    },
    'create-release': {
        description: 'Create an immutable content Release without assigning a build',
    },
    publish: {
        description: 'Create a content Release and assign it to the running or named build',
    },
    rollback: {
        description: 'List build history or assign an earlier Release to a build',
    },
};

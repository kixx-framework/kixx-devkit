import process from 'node:process';
import { subcommands } from './index.js';
import { generateSecretToken } from '../../lib/crypto.js';

export default class GenSecretTokenCommand {

    static description = subcommands['gen-secure-token'].description;

    static options = {
        prefix: {
            type: 'string',
            short: 'p',
            description: 'Optional literal prefix prepended to the random token body',
        },
    };

    run(options) {
        const token = generateSecretToken(options.prefix);
        process.stdout.write(`${ token }\n`);
        return 0;
    }
}

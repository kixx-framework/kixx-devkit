import { parse } from '../vendor/acorn/index.js';

/**
 * Removes JavaScript comments while preserving syntax-bearing comment-like text.
 * @param {string} source - JavaScript source
 * @returns {string} Source with comments removed outright
 * @throws {SyntaxError} When source is not valid JavaScript
 */
export function stripJavaScriptComments(source) {
    const comments = [];

    parse(source, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        allowHashBang: true,
        onComment: comments,
    });

    const retainedComments = comments.filter((comment) => {
        return !source.slice(comment.start, comment.end).startsWith('#!');
    });

    return removeRanges(source, retainedComments);
}

/**
 * Removes CSS block comments outside strings and `url()` values.
 * @param {string} source - CSS source
 * @returns {string} Source with comments removed outright
 */
export function stripCssComments(source) {
    let output = '';
    let position = 0;

    while (position < source.length) {
        const character = source[position];

        if (character === '"' || character === "'") {
            const end = findQuotedEnd(source, position, character);
            output += source.slice(position, end);
            position = end;
            continue;
        }

        if (isUrlFunctionAt(source, position)) {
            const end = findUrlEnd(source, position);
            output += source.slice(position, end);
            position = end;
            continue;
        }

        if (source.startsWith('/*', position)) {
            const end = source.indexOf('*/', position + 2);
            position = end === -1 ? source.length : end + 2;
            continue;
        }

        output += character;
        position += 1;
    }

    return output;
}

function removeRanges(source, ranges) {
    let output = '';
    let position = 0;

    for (const range of ranges) {
        output += source.slice(position, range.start);
        position = range.end;
    }

    return output + source.slice(position);
}

function findQuotedEnd(source, start, quote) {
    let position = start + 1;

    while (position < source.length) {
        if (source[position] === '\\') {
            position += 2;
            continue;
        }
        if (source[position] === quote) {
            return position + 1;
        }
        position += 1;
    }

    return source.length;
}

function isUrlFunctionAt(source, position) {
    if (source.slice(position, position + 4).toLowerCase() !== 'url(') {
        return false;
    }

    const previous = source[position - 1];
    return !previous || !/[a-z0-9_-]/i.test(previous);
}

function findUrlEnd(source, start) {
    let position = start + 4;

    while (position < source.length) {
        const character = source[position];

        if (character === '\\') {
            position += 2;
            continue;
        }
        if (character === '"' || character === "'") {
            position = findQuotedEnd(source, position, character);
            continue;
        }
        if (character === ')') {
            return position + 1;
        }
        position += 1;
    }

    return source.length;
}

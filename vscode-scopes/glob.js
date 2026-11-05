'use strict';

// Minimal segment-based glob matcher: supports **, *, ?, [abc], [!abc], {a,b} (within one segment).
// Kept dependency-free so the extension needs no build or npm install.

function segmentToRegExp(seg) {
    let re = '';
    for (let i = 0; i < seg.length; i++) {
        const c = seg[i];
        if (c === '*') {
            re += '[^/]*';
        } else if (c === '?') {
            re += '[^/]';
        } else if (c === '[') {
            const end = seg.indexOf(']', i + 1);
            if (end === -1) {
                re += '\\[';
            } else {
                let body = seg.slice(i + 1, end);
                if (body.startsWith('!')) {
                    body = '^' + body.slice(1);
                }
                re += '[' + body.replace(/\\/g, '\\\\') + ']';
                i = end;
            }
        } else if (c === '{') {
            const end = seg.indexOf('}', i + 1);
            if (end === -1) {
                re += '\\{';
            } else {
                const alts = seg.slice(i + 1, end).split(',').map(a => segmentToRegExp(a).source.slice(1, -1));
                re += '(?:' + alts.join('|') + ')';
                i = end;
            }
        } else {
            re += c.replace(/[.+^$()|\\]/g, '\\$&');
        }
    }
    return new RegExp('^' + re + '$');
}

/** Compile a glob into a list of segments: the string '**' or a RegExp per segment. */
function compile(pattern) {
    const clean = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
    return clean.split('/').filter(Boolean).map(s => (s === '**' ? '**' : segmentToRegExp(s)));
}

/** True if the path (array of segments) matches the compiled pattern exactly. */
function matches(pat, segs, i = 0, j = 0) {
    while (i < pat.length) {
        if (pat[i] === '**') {
            for (let k = j; k <= segs.length; k++) {
                if (matches(pat, segs, i + 1, k)) {
                    return true;
                }
            }
            return false;
        }
        if (j >= segs.length || !pat[i].test(segs[j])) {
            return false;
        }
        i++;
        j++;
    }
    return j === segs.length;
}

/** True if some path strictly below the given folder could match the pattern. */
function couldContain(pat, segs) {
    for (let i = 0; i < pat.length; i++) {
        if (pat[i] === '**' || i >= segs.length) {
            return true;
        }
        if (!pat[i].test(segs[i])) {
            return false;
        }
    }
    return false;
}

module.exports = { compile, matches, couldContain };

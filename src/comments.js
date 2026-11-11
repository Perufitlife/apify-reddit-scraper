/**
 * Comments of a thread as Reddit's own page renders them: every comment carries its
 * votes, its depth in the conversation and the comment it replies to.
 *
 * The page arrives in pieces. The first piece holds the top of the thread; each
 * "more comments" control at the end of a piece leads to the next one.
 */

const decode = (s = '') => s
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');

const attr = (tag, name) => {
    const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
    return m ? decode(m[1]) : '';
};

/** Text of a comment: paragraphs kept as line breaks, markup dropped. */
function bodyText(html) {
    return decode(
        html
            .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
            .replace(/<\/(p|li|blockquote|pre|h[1-6])>/gi, '\n')
            .replace(/<br\s*\/?>/gi, '\n')
            // Links and emphasis sit inside a sentence: dropping them must not add spaces.
            .replace(/<\/?(a|strong|em|b|i|span|del|sup|sub|code|u)\b[^>]*>/gi, '')
            .replace(/<[^>]*>/g, ' '),
    )
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('\n');
}

const OPEN = '<shreddit-comment ';

/**
 * @param {string} html one piece of a thread
 * @returns {{ comments: object[], next: { path: string, cursor: string } | null }}
 * `next` is the control that continues the list of top-level comments, when there is one.
 */
export function parseThreadPiece(html) {
    const comments = [];
    let at = html.indexOf(OPEN);

    while (at !== -1) {
        // The tag ends at the first ">" that is not inside a quoted attribute value.
        const whole = html.slice(at, at + 20000).match(/^<shreddit-comment\s(?:[^>"]|"[^"]*")*>/);
        if (!whole) break;
        const tag = whole[0];
        const tagEnd = at + tag.length - 1;
        const nextAt = html.indexOf(OPEN, tagEnd);
        // A comment's own text sits before any reply nested inside it.
        const own = html.slice(tagEnd + 1, nextAt === -1 ? html.length : nextAt);

        const id = attr(tag, 'thingId');
        if (id) {
            let body = '';
            const start = own.indexOf(`id="${id}-post-rtjson-content"`);
            if (start !== -1) {
                const from = own.indexOf('>', start) + 1;
                // The buttons under a comment mark where its text ends. Searched as a tag,
                // so the same words typed inside a comment (escaped there) never match.
                const rest = own.slice(from);
                const to = rest.search(/<div data-hl=|<faceplate-loader|<script|<shreddit-comment-action-row/);
                body = bodyText(to === -1 ? rest : rest.slice(0, to));
            }

            const score = attr(tag, 'score');
            const permalink = attr(tag, 'permalink');
            const created = attr(tag, 'created');
            const createdDate = created ? new Date(created) : null;

            comments.push({
                id,
                author: attr(tag, 'author') || '[deleted]',
                body,
                score: /^-?\d+$/.test(score) ? Number(score) : null,
                createdUtc: createdDate && !Number.isNaN(createdDate.getTime()) ? createdDate.toISOString() : '',
                depth: Number(attr(tag, 'depth')) || 0,
                parentId: attr(tag, 'parentId'),
                url: permalink ? `https://www.reddit.com${permalink}` : '',
            });
        }
        at = nextAt;
    }

    let next = null;
    const control = html.match(/<faceplate-partial\b[^>]*\bsrc="(\/svc\/shreddit\/more-comments\/[^"]*top-level=1[^"]*)"[^>]*>/);
    if (control) {
        const after = html.slice(control.index + control[0].length, control.index + control[0].length + 2000);
        const cursor = after.match(/<input[^>]*\bname="cursor"[^>]*\bvalue="([^"]+)"/);
        if (cursor) next = { path: decode(control[1]), cursor: decode(cursor[1]) };
    }

    return { comments, next };
}

/** "/r/technology/comments/abc123/title" -> { subreddit, postId } or null (user-profile posts have no subreddit). */
export function threadKey(path) {
    const m = String(path ?? '').match(/\/r\/([^/]+)\/comments\/([A-Za-z0-9]+)/);
    return m ? { subreddit: m[1], postId: m[2] } : null;
}

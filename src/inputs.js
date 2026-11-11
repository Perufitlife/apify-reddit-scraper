/**
 * Reading what people actually paste into the input.
 *
 * A subreddit arrives as "technology", "r/technology", "/r/technology/" or a whole
 * link copied from the address bar. A post arrives as a link with tracking
 * parameters, a link to one comment, or an old.reddit link.
 */

const isLink = (text) => /:\/\//.test(text) || /reddit\.com\//i.test(text);

/**
 * @returns {string} the subreddit name, or '' when the text is not one.
 * Names are passed through as written ("a+b", "u_name", "all"): Reddit decides
 * whether they exist, this only refuses what cannot be a name at all.
 */
export function subredditName(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return '';

    if (isLink(raw)) {
        const noQuery = raw.split(/[?#]/)[0];
        // A link to a post is not a subreddit: it belongs in "Post URLs".
        if (/\/comments\//.test(noQuery)) return '';
        const linked = noQuery.match(/\/r\/([^/\s]+)(?:\/|$)/);
        return linked ? linked[1] : '';
    }

    // "technology", "r/technology", "/r/technology/top/"
    const prefixed = /^\/?r\//.test(raw);
    const rest = raw.replace(/^\/?r\//, '').replace(/^\/+|\/+$/g, '');
    const name = prefixed ? rest.split('/')[0] : rest;
    if (!name || /[\s/]/.test(name)) return '';
    return name;
}

/**
 * @returns {{ path: string, subreddit: string } | null} the path of a post as Reddit
 * serves it, without host, query string or trailing slash, or null when the text is
 * not a post link. Up to two segments after the id are kept: the title slug and, on a
 * link to a single comment, that comment's id.
 */
export function postPath(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return null;

    const noQuery = raw.split(/[?#]/)[0];
    const m = noQuery.match(/(?:^|\/)((?:(?:r|user|u)\/[^/\s]+\/)?comments\/[A-Za-z0-9]{2,12}(?:\/[^/\s]+){0,2})(?:\/|$)/);
    if (!m) return null;

    const sub = m[1].match(/^r\/([^/]+)\//);
    return { path: `/${m[1]}`, subreddit: sub ? sub[1] : '' };
}

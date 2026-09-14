/**
 * Reddit access layer.
 *
 * Reddit killed anonymous access to the legacy `*.json` endpoints — every
 * variant (www, old, oauth) now answers 403 with an HTML block page, from
 * datacenter AND residential IPs alike. Two public surfaces still answer with
 * real data when requested through a residential IP:
 *
 *   1. /svc/shreddit/community-more-posts/{sort}/  -> subreddit listings, full
 *      metadata (score, upvote ratio, comment count, author, timestamps).
 *   2. *.rss feeds (search.rss, <permalink>.rss)   -> search results and
 *      comment trees. Atom feeds carry no vote data (Reddit does not publish
 *      it there), so score/upvoteRatio are null for those two sources.
 *
 * Datacenter proxies are refused outright, so RESIDENTIAL is mandatory.
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Reddit answers blocked requests with a small JS interstitial; real pages are far larger. */
const CHALLENGE_MAX_BYTES = 20000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RedditClient {
    /**
     * @param {{ newUrl: (session?: string) => Promise<string> }} proxyConfiguration
     */
    // Eight attempts, not four. Every attempt draws a NEW residential session, so a
    // retry is a fresh roll of the dice rather than the same one repeated. A full run
    // takes ~55s and Apify's automated QA allows 300s, so there were four unused
    // minutes while a transient block was sinking the whole run.
    constructor(proxyConfiguration, { maxAttempts = 8, requestTimeoutMs = 45000, deadlineMs = 240000 } = {}) {
        this.proxyConfiguration = proxyConfiguration;
        this.maxAttempts = maxAttempts;
        // Hard ceiling: however many attempts remain, never overrun the QA budget.
        // Returning what we have beats dying on a timeout.
        this.deadline = Date.now() + deadlineMs;
        this.requestTimeoutMs = requestTimeoutMs;
        this.blockedResponses = 0;
        this.requests = 0;
    }

    /**
     * GET a URL through a fresh residential session, retrying past blocks.
     * @param {string} url
     * @param {string} marker substring that proves we got a real page
     */
    async get(url, marker, { maxAttempts = this.maxAttempts } = {}) {
        let lastReason = 'unknown';

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const session = `s${Math.random().toString(36).slice(2, 10)}`;
            let agent;

            try {
                // No proxy configuration at all (free plan, no residential group): go direct
                // rather than crash. Fewer endpoints will answer, but the run still returns
                // whatever Reddit serves — usually the RSS feeds.
                if (this.proxyConfiguration) {
                    agent = new ProxyAgent({
                        uri: await this.proxyConfiguration.newUrl(session),
                        connectTimeout: 20000,
                        headersTimeout: this.requestTimeoutMs,
                        bodyTimeout: this.requestTimeoutMs,
                    });
                }

                this.requests++;
                const res = await undiciFetch(url, {
                    ...(agent ? { dispatcher: agent } : {}),
                    headers: {
                        'User-Agent': UA,
                        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9',
                    },
                });
                const body = await res.text();

                if (res.status === 200 && (!marker || body.includes(marker))) return body;

                // A 200 that is short and lacks the marker is Reddit's bot interstitial.
                const blocked = res.status === 403 || res.status === 429
                    || (res.status === 200 && body.length < CHALLENGE_MAX_BYTES);
                if (blocked) this.blockedResponses++;

                if (res.status === 404) return null; // genuinely absent, no point retrying
                lastReason = `HTTP ${res.status}${blocked ? ' (blocked/interstitial)' : ''}, ${body.length} bytes`;
            } catch (err) {
                lastReason = err.message;
            } finally {
                if (agent) agent.close().catch(() => {});
            }

            if (Date.now() > this.deadline) {
                lastReason += ' (time budget exhausted, no further retries)';
                break;
            }
            // Growing backoff with a cap: 1.5s, 3s, 4.5s, then a flat 6s.
            if (attempt < maxAttempts) await sleep(Math.min(1500 * attempt, 6000));
        }

        throw new Error(`Reddit request failed after ${maxAttempts} attempts (${url}) — last: ${lastReason}`);
    }
}

/* ------------------------------------------------------------------ *
 * shreddit listing parsing
 * ------------------------------------------------------------------ */

const decodeEntities = (s = '') => s
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');

const stripTags = (s = '') => decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * Feed content arrives double-escaped (`&lt;div&gt;`), so entities must be
 * decoded BEFORE tags are stripped or the markup survives as literal text.
 *
 * Reddit wraps genuine user-written text in `<!-- SC_OFF -->…<!-- SC_ON -->`.
 * Anything outside that is the feed's own "submitted by /u/x [link] [comments]"
 * chrome — a link post has no body, and echoing that boilerplate as `body`
 * would be worse than an empty string.
 */
function feedContentToText(raw = '') {
    const html = decodeEntities(raw);
    const selfText = (html.match(/<!-- SC_OFF -->([\s\S]*?)<!-- SC_ON -->/) || [])[1];
    return selfText ? stripTags(selfText) : '';
}

/** Pull the attributes out of one `<shreddit-post ...>` opening tag. */
function attrs(tag) {
    const out = {};
    for (const m of tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) out[m[1]] = decodeEntities(m[2]);
    return out;
}

/**
 * `<shreddit-post-overflow-menu` also starts with `<shreddit-post`, so the
 * boundary (`\s`) in the pattern matters — without it every post is parsed twice
 * and half the records come out empty.
 */
const POST_TAG = /<shreddit-post\s[^>]*>/g;

export function parseListing(html) {
    const posts = [];

    for (const m of html.matchAll(POST_TAG)) {
        const a = attrs(m[0]);
        if (!a.permalink || !a['post-title']) continue;

        // For self posts the teaser body sits in the slot right after the tag.
        const after = html.slice(m.index, m.index + 6000);
        const bodyMatch = after.match(/slot="text-body"[^>]*>([\s\S]*?)<\/(?:a|div)>/);

        posts.push({
            id: a.id || '',
            title: a['post-title'],
            author: a.author || a['author-name'] || '[deleted]',
            subreddit: (a['subreddit-prefixed-name'] || '').replace(/^r\//, '') || a['subreddit-name'] || '',
            score: a.score != null ? Number(a.score) : null,
            upvoteRatio: a['upvote-ratio'] != null ? Number(a['upvote-ratio']) : null,
            commentCount: a['comment-count'] != null ? Number(a['comment-count']) : 0,
            body: bodyMatch ? stripTags(bodyMatch[1]) : '',
            postUrl: a['content-href'] || '',
            commentsUrl: `https://www.reddit.com${a.permalink}`,
            permalink: a.permalink,
            createdUtc: a['created-timestamp'] ? new Date(a['created-timestamp']).toISOString() : '',
            flair: a['flair-text'] || '',
            postType: a['post-type'] || '',
            domain: a.domain || '',
            isStickied: false,
        });
    }

    return posts;
}

/** Reddit's own cursor is just base64 of the last post's fullname. */
export const cursorFor = (postId) => (postId ? Buffer.from(postId).toString('base64') : null);

/* ------------------------------------------------------------------ *
 * Atom (RSS) parsing — used for search results and comment trees
 * ------------------------------------------------------------------ */

export function parseFeed(xml) {
    const entries = [];

    for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
        const e = m[1];
        const pick = (re) => (e.match(re) || [])[1] || '';
        entries.push({
            id: pick(/<id>([^<]*)<\/id>/),
            author: pick(/<name>([^<]*)<\/name>/).replace(/^\/u\//, ''),
            title: decodeEntities(pick(/<title>([\s\S]*?)<\/title>/)),
            link: pick(/<link href="([^"]*)"/),
            updated: pick(/<updated>([^<]*)<\/updated>/),
            subreddit: pick(/<category term="([^"]*)"/),
            content: feedContentToText(pick(/<content type="html">([\s\S]*?)<\/content>/)),
        });
    }

    return entries;
}

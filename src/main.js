import { Actor } from 'apify';
import { RedditClient, parseListing, parseFeed, cursorFor } from './reddit.js';
import { extractPost, extractComment } from './extractor.js';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    subreddits = [],
    searchQueries = [],
    postUrls = [],
    maxPostsPerSubreddit = 100,
    includeComments = false,
    maxCommentsPerPost = 100,
    sortBy = 'hot',
    timeFilter = 'week',
    includeVoteData = true,
} = input;

if (!subreddits.length && !searchQueries.length && !postUrls.length) {
    throw new Error('Provide at least one subreddit, search query, or post URL.');
}

// Reddit is hostile to datacenter IPs, so residential is the best pool by far — but it
// must not be a hard requirement. Apify's free plan has no residential access, and
// throwing here meant every free user hit an exception instead of a result: 327 people
// tried this Actor and 4 stayed. A user who gets partial data comes back; one who gets a
// stack trace does not. So: try residential, fall back, and say so in the log.
let proxyConfiguration;
let proxyTier = 'residential';
try {
    proxyConfiguration = await Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'] });
} catch {
    proxyConfiguration = null;
}
if (!proxyConfiguration) {
    proxyTier = 'datacenter';
    proxyConfiguration = await Actor.createProxyConfiguration().catch(() => null);
}
if (!proxyConfiguration) proxyTier = 'none';

if (proxyTier !== 'residential') {
    console.warn(
        `No residential proxy available on this account — falling back to ${proxyTier}. `
        + 'Reddit blocks datacenter IPs on some endpoints, so expect fewer results and more '
        + 'retries. RSS feeds usually still work. Upgrade the plan for full coverage.',
    );
}

const client = new RedditClient(proxyConfiguration);

let pushedPosts = 0;
let pushedComments = 0;
const failures = [];

const cap = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const postLimit = cap(Number(maxPostsPerSubreddit) || 100, 1, 500);
const commentLimit = cap(Number(maxCommentsPerPost) || 100, 1, 500);

console.log(
    `Starting Reddit scraper: ${subreddits.length} subreddit(s), ${searchQueries.length} search(es), `
    + `${postUrls.length} post URL(s). Up to ${postLimit} posts each, comments: ${includeComments}.`,
);

/* ------------------------------------------------------------------ *
 * Subreddit listings — full metadata (score, upvote ratio, comments)
 * ------------------------------------------------------------------ */

/**
 * The listing itself comes from the Atom feed: it returns 100 posts per request
 * in ~100 KB and paginates cleanly with `after`. The shreddit endpoint is the
 * only source of vote data but costs ~25x the bandwidth for 24 posts a page, so
 * it is used purely to enrich, and only when the user wants vote data.
 */
async function scrapeSubreddit(subreddit, limit) {
    const sort = ['hot', 'new', 'top', 'rising'].includes(sortBy) ? sortBy : 'hot';
    const t = String(timeFilter || 'week').toLowerCase();

    const posts = [];
    const seen = new Set();
    let after = null;

    while (posts.length < limit) {
        const params = new URLSearchParams({ limit: String(Math.min(limit - posts.length, 100)) });
        if (sort === 'top') params.set('t', t);
        if (after) { params.set('after', after); params.set('count', String(posts.length)); }

        console.log(`Fetching r/${subreddit} [${sort}] — ${posts.length}/${limit} so far...`);
        const xml = await client.get(`https://www.reddit.com/r/${subreddit}/${sort}/.rss?${params}`, '<entry>');
        if (!xml) break;

        const page = parseFeed(xml).filter((e) => e.id.startsWith('t3_') && !seen.has(e.id));
        if (!page.length) { console.log(`r/${subreddit}: feed exhausted.`); break; }

        for (const e of page) {
            if (posts.length >= limit) break;
            seen.add(e.id);
            posts.push({
                id: e.id,
                title: e.title,
                author: e.author,
                subreddit: e.subreddit || subreddit,
                score: null,
                upvoteRatio: null,
                commentCount: null,
                body: e.content,
                postUrl: e.link,
                commentsUrl: e.link,
                permalink: e.link.replace(/^https?:\/\/[^/]+/, ''),
                createdUtc: e.updated ? new Date(e.updated).toISOString() : '',
                flair: '',
                postType: '',
                domain: '',
                isStickied: false,
            });
        }

        after = page[page.length - 1].id;
    }

    if (includeVoteData && posts.length) await enrichVotes(subreddit, sort, t, posts);

    for (const post of posts) {
        await Actor.pushData(extractPost(post));
        pushedPosts++;
        if (includeComments) await scrapeComments(post.permalink, post.title, post.subreddit, commentLimit);
    }

    console.log(`Done r/${subreddit}: ${posts.length} posts.`);
    if (!posts.length) failures.push(`r/${subreddit} returned no posts`);
}

/** Fill score / upvoteRatio / commentCount from the shreddit feed, matched by post id. */
async function enrichVotes(subreddit, sort, t, posts) {
    const wanted = new Map(posts.map((p) => [p.id, p]));
    const maxPages = Math.min(14, Math.ceil(posts.length / 20) + 2);
    let after = null;
    let filled = 0;

    for (let page = 0; page < maxPages && filled < posts.length; page++) {
        const params = new URLSearchParams({ name: subreddit, feedLength: '100' });
        if (sort === 'top') params.set('t', t.toUpperCase());
        if (after) params.set('after', after);

        let html;
        try {
            html = await client.get(`https://www.reddit.com/svc/shreddit/community-more-posts/${sort}/?${params}`, '<shreddit-post');
        } catch (err) {
            // Vote data is a bonus; never let it sink a run that already has posts.
            console.log(`  Vote enrichment stopped: ${err.message}`);
            break;
        }
        if (!html) break;

        const listing = parseListing(html);
        if (!listing.length) break;

        for (const l of listing) {
            const p = wanted.get(l.id);
            if (p && p.score === null) {
                p.score = l.score;
                p.upvoteRatio = l.upvoteRatio;
                p.commentCount = l.commentCount;
                p.flair = l.flair || p.flair;
                p.postType = l.postType;
                p.domain = l.domain;
                if (l.postUrl) p.postUrl = l.postUrl;
                filled++;
            }
        }

        const next = cursorFor(listing[listing.length - 1].id);
        if (!next || next === after) break;
        after = next;
    }

    console.log(`  Vote data filled for ${filled}/${posts.length} posts.`);
}

/* ------------------------------------------------------------------ *
 * Search — Atom feed. Reddit does not publish vote counts in feeds, so
 * score/upvoteRatio come back null for search hits.
 * ------------------------------------------------------------------ */

async function scrapeSearch(query, limit) {
    const params = new URLSearchParams({
        q: query,
        sort: 'relevance',
        t: String(timeFilter || 'week').toLowerCase(),
        limit: String(Math.min(limit, 100)),
    });

    console.log(`Searching "${query}"...`);
    const xml = await client.get(`https://www.reddit.com/search.rss?${params}`, '<entry>');
    if (!xml) { failures.push(`search "${query}" returned nothing`); return; }

    // Feeds mix in subreddit hits (t5_) alongside posts (t3_).
    const hits = parseFeed(xml).filter((e) => e.id.startsWith('t3_')).slice(0, limit);

    for (const e of hits) {
        await Actor.pushData(extractPost({
            id: e.id,
            title: e.title,
            author: e.author,
            subreddit: e.subreddit,
            score: null,
            upvoteRatio: null,
            commentCount: 0,
            body: e.content,
            postUrl: e.link,
            commentsUrl: e.link,
            permalink: e.link.replace(/^https?:\/\/[^/]+/, ''),
            createdUtc: e.updated ? new Date(e.updated).toISOString() : '',
            flair: '',
            postType: '',
            domain: '',
            isStickied: false,
        }));
        pushedPosts++;

        if (includeComments) {
            await scrapeComments(e.link.replace(/^https?:\/\/[^/]+/, ''), e.title, e.subreddit, commentLimit);
        }
    }

    console.log(`Done search "${query}": ${hits.length} posts.`);
    if (!hits.length) failures.push(`search "${query}" returned no posts`);
}

/* ------------------------------------------------------------------ *
 * Comments — Atom feed of a post's thread.
 * ------------------------------------------------------------------ */

async function scrapeComments(permalink, postTitle, subreddit, limit) {
    const clean = `/${permalink.replace(/^https?:\/\/[^/]+/, '').replace(/^\/+|\/+$/g, '')}`;
    const url = `https://www.reddit.com${clean}/.rss?limit=${Math.min(limit, 100)}&sort=top`;

    let xml;
    try {
        xml = await client.get(url, '<entry>');
    } catch (err) {
        console.log(`  Comments unavailable for ${clean}: ${err.message}`);
        return;
    }
    if (!xml) return;

    const postUrl = `https://www.reddit.com${clean}`;
    const comments = parseFeed(xml).filter((e) => e.id.startsWith('t1_')).slice(0, limit);

    for (const c of comments) {
        await Actor.pushData(extractComment({
            id: c.id,
            author: c.author,
            body: c.content,
            score: null,
            createdUtc: c.updated ? new Date(c.updated).toISOString() : '',
            depth: 0,
            parentId: '',
            subreddit,
        }, postTitle, postUrl));
        pushedComments++;
    }

    console.log(`  ${comments.length} comments from ${clean}`);
}

/* ------------------------------------------------------------------ */

for (const sub of subreddits) {
    const name = String(sub).trim().replace(/^\/?r\//, '').replace(/\/$/, '');
    if (!name) continue;
    try {
        await scrapeSubreddit(name, postLimit);
    } catch (err) {
        console.error(`r/${name} failed: ${err.message}`);
        failures.push(`r/${name}: ${err.message}`);
    }
}

for (const q of searchQueries) {
    const query = String(q).trim();
    if (!query) continue;
    try {
        await scrapeSearch(query, postLimit);
    } catch (err) {
        console.error(`Search "${query}" failed: ${err.message}`);
        failures.push(`search "${query}": ${err.message}`);
    }
}

for (const url of postUrls) {
    const raw = String(url).trim();
    if (!raw) continue;
    try {
        await scrapeComments(raw, '', '', commentLimit);
    } catch (err) {
        console.error(`Post ${raw} failed: ${err.message}`);
        failures.push(`post ${raw}: ${err.message}`);
    }
}

const total = pushedPosts + pushedComments;
console.log(`Reddit scraper finished: ${pushedPosts} posts, ${pushedComments} comments (${total} results). `
    + `${client.requests} HTTP requests, ${client.blockedResponses} blocked responses retried.`);

// Never exit "successfully" with an empty dataset — that is what let this Actor
// charge users for nothing. A run that produced no data must fail loudly.
if (total === 0) {
    throw new Error(
        `No results were extracted. ${failures.length ? `Details: ${failures.join('; ')}. ` : ''}`
        + 'Check that the subreddits exist and are public, and that residential proxies are available on your account.',
    );
}

await Actor.exit();

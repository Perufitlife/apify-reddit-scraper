import { Actor } from 'apify';
import { RedditClient, parseListing, parseFeed, cursorFor } from './reddit.js';
import { extractPost, extractComment } from './extractor.js';
import { subredditName, postPath, keywordMatcher } from './inputs.js';
import { parseThreadPiece, threadKey } from './comments.js';

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
    keywords = [],
} = input;

// Optional: keep only the subreddit posts that mention one of these words or phrases.
const matchKeywords = keywordMatcher(keywords);
let scannedPosts = 0;
if (matchKeywords && !subreddits.length) {
    console.warn('"keywords" filters subreddit posts, and no subreddit was given: the filter is not applied to search queries or post URLs.');
}

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
        let xml;
        try {
            // The feed gets a short leash: if Reddit is blocking it right now, the
            // shreddit listing below is a second door that usually stays open.
            xml = await client.get(`https://www.reddit.com/r/${subreddit}/${sort}/.rss?${params}`, '<entry>', { maxAttempts: 3 });
        } catch (err) {
            console.log(`r/${subreddit}: feed blocked (${err.message.split(' — ')[0]}) — switching to the listing endpoint.`);
            await listingFallback(subreddit, sort, t, limit, posts, seen);
            break;
        }
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

    // With a keyword filter, every post read is checked and only the matches are kept.
    const read = posts.length;
    scannedPosts += read;
    let kept = posts;
    if (matchKeywords) {
        kept = [];
        for (const [index, post] of posts.entries()) {
            post.listPosition = index;
            // Checked against the text as it is saved, so a row always contains what it matched.
            const found = matchKeywords(`${post.title} ${String(post.body ?? '').replace(/\s+/g, ' ').trim().substring(0, 5000)}`);
            if (found.length) { post.matchedKeywords = found; kept.push(post); }
        }
        console.log(`r/${subreddit}: ${kept.length} of ${read} posts mention the keywords.`);
    }

    // Posts that came through the listing endpoint already carry their votes.
    if (includeVoteData && kept.some((p) => p.score === null)) await enrichVotes(subreddit, sort, t, kept, matchKeywords && kept.length ? kept[kept.length - 1].listPosition + 1 : 0);

    for (const post of kept) {
        const row = extractPost(post);
        if (matchKeywords) row.matchedKeywords = post.matchedKeywords;
        await Actor.pushData(row);
        pushedPosts++;
        if (includeComments) await scrapeComments(post.permalink, post.title, post.subreddit, commentLimit);
    }

    console.log(`Done r/${subreddit}: ${kept.length} posts.`);
    if (!read) failures.push(`r/${subreddit} returned no posts`);
}

/**
 * Second door for subreddit listings. On 13-sep Apify's QA run got the full 190 KB
 * block page on every feed request (15 of 16) and the Actor was flagged, while the
 * same feed answered normally from other IPs minutes later — blocks come in bursts
 * and per endpoint. This listing is heavier per post but already carries score,
 * upvote ratio and comment count, so posts that arrive this way need no enrichment.
 */
async function listingFallback(subreddit, sort, t, limit, posts, seen) {
    let after = posts.length ? cursorFor(posts[posts.length - 1].id) : null;
    const maxPages = Math.min(40, Math.ceil((limit - posts.length) / 20) + 3);

    for (let page = 0; page < maxPages && posts.length < limit; page++) {
        const params = new URLSearchParams({ name: subreddit, feedLength: '100' });
        if (sort === 'top') params.set('t', t.toUpperCase());
        if (after) params.set('after', after);

        let html;
        try {
            html = await client.get(`https://www.reddit.com/svc/shreddit/community-more-posts/${sort}/?${params}`, '<shreddit-post');
        } catch (err) {
            console.log(`r/${subreddit}: listing endpoint also blocked (${err.message.split(' — ')[0]}).`);
            if (!posts.length) failures.push(`r/${subreddit}: ${err.message}`);
            return;
        }
        if (!html) return;

        const listing = parseListing(html).filter((l) => l.id && !seen.has(l.id));
        if (!listing.length) return;
        for (const l of listing) {
            if (posts.length >= limit) break;
            seen.add(l.id);
            posts.push(l);
        }

        const next = cursorFor(listing[listing.length - 1].id);
        if (!next || next === after) return;
        after = next;
    }
    console.log(`r/${subreddit}: ${posts.length} posts via the listing endpoint (with vote data).`);
}

/** Fill score / upvoteRatio / commentCount from the shreddit feed, matched by post id. */
async function enrichVotes(subreddit, sort, t, posts, listDepth = 0) {
    // The listing endpoint answers for one community at a time, never for "a+b".
    if (subreddit.includes('+')) {
        console.log('  Vote data is not available for combined subreddits (a+b); scrape them separately to get it.');
        return;
    }
    const missing = posts.filter((p) => p.score === null);
    const wanted = new Map(missing.map((p) => [p.id, p]));
    // With a keyword filter the kept posts are spread through the listing: read as deep as the last one.
    const maxPages = Math.min(14, Math.ceil(Math.max(missing.length, listDepth) / 20) + 2);
    let after = null;
    let filled = 0;

    for (let page = 0; page < maxPages && filled < missing.length; page++) {
        const params = new URLSearchParams({ name: subreddit, feedLength: '100' });
        if (sort === 'top') params.set('t', t.toUpperCase());
        if (after) params.set('after', after);

        let html;
        try {
            html = await client.get(`https://www.reddit.com/svc/shreddit/community-more-posts/${sort}/?${params}`, '<shreddit-post', { maxAttempts: 3 });
        } catch (err) {
            // Three attempts, not eight: when Reddit refuses this page it refuses every attempt,
            // and the posts are already collected. Waiting longer only makes the run slower.
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
    let xml;
    try {
        // Three attempts, not eight: when Reddit refuses search it refuses every attempt, and
        // the other inputs of the run should not wait a minute for an answer that will not come.
        xml = await client.get(`https://www.reddit.com/search.rss?${params}`, '<entry>', { maxAttempts: 3 });
    } catch (err) {
        if (!/HTTP 403/.test(err.message)) throw err;
        const why = 'Reddit refused the search request (HTTP 403). Its public search feed has been asking for sign-in lately; subreddit and post URL inputs are not affected. To follow a topic meanwhile, list the subreddits where it is discussed and add "keywords"';
        console.warn(`Search "${query}": ${why}.`);
        failures.push(`search "${query}": ${why}`);
        return;
    }
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
 * Comments — the thread as Reddit's page renders it (votes, depth, parent),
 * with the thread's Atom feed as the fallback.
 * ------------------------------------------------------------------ */

/** The thread's feed: up to 100 top-level comments, no votes. Also names the thread. */
async function readFeed(clean, limit) {
    const url = `https://www.reddit.com${clean}/.rss?limit=${Math.min(limit, 100)}&sort=top`;
    let xml;
    try {
        xml = await client.get(url, '<entry>');
    } catch (err) {
        return { found: false, reason: err.message };
    }
    if (!xml) return { found: false, reason: 'Reddit answered "not found" — the post may be deleted, private or mistyped' };

    const entries = parseFeed(xml);
    const thread = entries.find((e) => e.id.startsWith('t3_'));
    return {
        found: true,
        title: thread?.title || '',
        subreddit: thread?.subreddit || '',
        comments: entries.filter((e) => e.id.startsWith('t1_')).map((c) => ({
            id: c.id,
            author: c.author,
            body: c.content,
            score: null,
            createdUtc: c.updated ? new Date(c.updated).toISOString() : '',
            depth: 0,
            parentId: '',
        })),
    };
}

/**
 * The thread page, piece by piece, until `limit` comments are collected or the
 * thread runs out. A piece that fails ends the walk; what was read is kept.
 * @returns {Promise<object[] | null>} null when the page could not be read at all.
 */
async function readThread(key, limit) {
    const first = `https://www.reddit.com/svc/shreddit/comments/r/${key.subreddit}/t3_${key.postId}?render-mode=partial&sort=top`;
    let html;
    try {
        html = await client.get(first, '<shreddit-comment-tree', { maxAttempts: 4 });
    } catch (err) {
        console.log(`  Thread page unavailable (${err.message.slice(0, 120)}) — using the feed.`);
        return null;
    }
    if (!html) return null;

    const seen = new Set();
    const comments = [];
    const take = (piece) => {
        let added = 0;
        for (const c of piece.comments) {
            if (seen.has(c.id)) continue;
            seen.add(c.id);
            comments.push(c);
            added++;
        }
        return added;
    };

    let piece = parseThreadPiece(html);
    take(piece);

    // Each further piece brings about ten comments.
    const maxPieces = Math.ceil(limit / 5) + 2;
    for (let n = 0; n < maxPieces && comments.length < limit && piece.next; n++) {
        let more;
        try {
            more = await client.get(`https://www.reddit.com${piece.next.path}`, '', {
                maxAttempts: 3,
                form: { cursor: piece.next.cursor },
            });
        } catch (err) {
            console.log(`  Stopped at ${comments.length} comments: the next part of the thread did not load.`);
            break;
        }
        if (!more) break;
        piece = parseThreadPiece(more);
        if (!take(piece)) break;
    }

    return comments.slice(0, limit);
}

async function scrapeComments(permalink, postTitle, subreddit, limit, subredditFromLink = '') {
    const clean = `/${permalink.replace(/^https?:\/\/[^/]+/, '').replace(/^\/+|\/+$/g, '')}`;
    const postUrl = `https://www.reddit.com${clean}`;
    const key = threadKey(clean);

    // A bare post link carries no title: the feed names the thread (and tells a missing post apart).
    let feed = null;
    let feedFailure = null;
    if (!postTitle || !key) {
        feed = await readFeed(clean, limit);
        if (!feed.found) {
            // "Not found" is final. Any other failure of the feed still leaves the thread page to try.
            if (!key || /not found/.test(feed.reason)) {
                console.log(`  Comments unavailable for ${clean}: ${feed.reason}`);
                return feed;
            }
            feedFailure = feed;
            feed = null;
        } else {
            postTitle = postTitle || feed.title;
            subreddit = subreddit || feed.subreddit;
        }
    }
    subreddit = subreddit || subredditFromLink || key?.subreddit || '';

    // A link to one comment is a request for that conversation, which only the feed serves.
    const singleComment = /\/comments\/[A-Za-z0-9]+\/[^/]+\/[A-Za-z0-9]+$/.test(clean);

    let comments = key && !singleComment ? await readThread(key, limit) : null;
    let source = 'thread page';
    // Nothing from the thread page (unreadable, or read as empty): the feed decides.
    if (!comments || !comments.length) {
        feed = feed ?? feedFailure ?? await readFeed(clean, limit);
        if (!feed.found) {
            if (!comments) {
                console.log(`  Comments unavailable for ${clean}: ${feed.reason}`);
                return feed;
            }
        } else if (feed.comments.length || !comments) {
            comments = feed.comments.slice(0, limit);
            source = 'feed, without votes';
        }
    } else if (comments.length < limit) {
        console.log(`  ${clean}: the thread shows ${comments.length} comments; replies folded behind "more replies" are not opened.`);
    }

    for (const c of comments) {
        await Actor.pushData(extractComment({ ...c, subreddit }, postTitle, postUrl));
        pushedComments++;
    }

    console.log(`  ${comments.length} comments from ${clean} (${source})`);
    return { found: true, comments: comments.length };
}

/* ------------------------------------------------------------------ */

const subredditNames = [];
for (const sub of subreddits) {
    const raw = String(sub ?? '').trim();
    if (!raw) continue;
    const name = subredditName(raw);
    if (!name) {
        console.warn(`"${raw}" is not a subreddit name or subreddit link — skipped. Use a name such as "technology".`);
        failures.push(`"${raw}" is not a subreddit`);
        continue;
    }
    if (!subredditNames.some((n) => n.toLowerCase() === name.toLowerCase())) subredditNames.push(name);
}

for (const name of subredditNames) {
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
    const post = postPath(raw);
    if (!post) {
        console.warn(`"${raw}" is not a link to a Reddit post — skipped. Expected something like https://www.reddit.com/r/technology/comments/abc123/title/`);
        failures.push(`"${raw}" is not a post link`);
        continue;
    }
    try {
        const result = await scrapeComments(post.path, '', '', commentLimit, post.subreddit);
        if (!result.found) failures.push(`post ${raw}: ${result.reason}`);
        else if (!result.comments) console.log(`Post ${raw} has no comments.`);
    } catch (err) {
        console.error(`Post ${raw} failed: ${err.message}`);
        failures.push(`post ${raw}: ${err.message}`);
    }
}

const total = pushedPosts + pushedComments;
console.log(`Reddit scraper finished: ${pushedPosts} posts, ${pushedComments} comments (${total} results). `
    + `${client.requests} HTTP requests, ${client.blockedResponses} blocked responses retried.`);

// A keyword filter that matched nothing is an answer, not a failure: the posts were
// read and none of them mention the keywords. No result is charged for it.
if (total === 0 && matchKeywords && scannedPosts > 0) {
    const note = `0 results: read ${scannedPosts} posts and none mention the keywords. `
        + 'Try more subreddits, a higher "Max posts per subreddit", or sort by "new".'
        + (failures.length ? ` Also: ${failures.join('; ')}` : '');
    console.warn(note);
    await Actor.exit(note.slice(0, 900));
}

// Never exit "successfully" with an empty dataset — that is what let this Actor
// charge users for nothing. A run that produced no data must fail loudly.
if (total === 0) {
    throw new Error(
        `No results were extracted. ${failures.length ? `Details: ${failures.join('; ')}. ` : ''}`
        + 'Check that the subreddits exist and are public, and that residential proxies are available on your account.',
    );
}

// Some inputs worked and some did not: a green run must still say which ones gave nothing.
if (failures.length) {
    const note = `${total} results. ${failures.length} issue(s): ${failures.join('; ')}`.slice(0, 900);
    console.warn(note);
    await Actor.exit(note);
}

await Actor.exit();

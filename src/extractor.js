/**
 * Normalizes posts and comments into the flat dataset shape.
 *
 * `score` and `upvoteRatio` are deliberately left as `null` (not coerced to 0)
 * when the source feed does not publish them, so consumers can tell "no votes"
 * apart from "not available from this source".
 */

const clean = (text) => (text ? String(text).replace(/\s+/g, ' ').trim() : '');
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

export function extractPost(rawPost) {
    return {
        dataType: 'post',
        redditId: rawPost.id || '',
        postTitle: clean(rawPost.title),
        author: rawPost.author || '[deleted]',
        subreddit: rawPost.subreddit || '',
        score: num(rawPost.score),
        upvoteRatio: num(rawPost.upvoteRatio),
        commentCount: rawPost.commentCount ?? 0,
        body: clean(rawPost.body).substring(0, 5000),
        url: rawPost.postUrl || rawPost.commentsUrl || '',
        postUrl: rawPost.commentsUrl || rawPost.postUrl || '',
        createdUtc: rawPost.createdUtc || '',
        flair: rawPost.flair || '',
        postType: rawPost.postType || '',
        domain: rawPost.domain || '',
        isStickied: rawPost.isStickied || false,
        parentId: '',
        depth: 0,
        scrapedAt: new Date().toISOString(),
    };
}

export function extractComment(rawComment, postTitle, postUrl) {
    return {
        dataType: 'comment',
        redditId: rawComment.id || '',
        postTitle: clean(postTitle),
        author: rawComment.author || '[deleted]',
        subreddit: rawComment.subreddit || '',
        score: num(rawComment.score),
        upvoteRatio: null,
        commentCount: 0,
        body: clean(rawComment.body).substring(0, 5000),
        url: '',
        postUrl: postUrl || '',
        createdUtc: rawComment.createdUtc || '',
        flair: '',
        postType: 'comment',
        domain: '',
        isStickied: false,
        parentId: rawComment.parentId || '',
        depth: rawComment.depth || 0,
        scrapedAt: new Date().toISOString(),
    };
}

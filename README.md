# Reddit Sentiment Scraper - Posts, Comments & Sentiment Data

## Reddit sentiment scraper: extract posts, comments and community insights from any subreddit

Turn Reddit into a structured dataset. This scraper collects posts and comments from subreddits, search results, and individual threads -- delivering titles, authors, upvote scores, comment text, timestamps, and flair data in a clean, export-ready format.

Reddit is one of the richest sources of authentic consumer opinion on the internet. Whether you are running market research, building a sentiment analysis pipeline, scouting content ideas, or monitoring brand mentions, this actor gives you programmatic access to the conversations that matter -- without API key management. Runs through Apify residential proxies, which Reddit requires.

## What data can you extract?

> **Field availability, stated up front.** Reddit publishes vote data on subreddit
> listings but not in its public search or comment feeds. So `score`, `upvoteRatio`
> and `commentCount` are populated for **subreddit posts**, and are `null` for
> **search results** and **comments** — `null` means "Reddit does not publish it",
> not "zero". Post `body` is filled for self/text posts; link posts have no body by
> definition. This Actor requires Apify **residential proxies**: Reddit refuses
> datacenter IPs on every public endpoint.

### Post data

| Field | Type | Description |
|-------|------|-------------|
| `dataType` | string | Record type identifier (`post`) |
| `redditId` | string | Reddit fullname, e.g. `t3_1vrszc5` |
| `postTitle` | string | Title of the Reddit post |
| `author` | string | Username of the post author |
| `subreddit` | string | Subreddit where the post was published |
| `score` | integer \| null | Net upvote score. `null` for search results (Reddit's search feed omits it) |
| `upvoteRatio` | number \| null | Share of votes that are upvotes, 0-1. `null` for search results |
| `commentCount` | integer \| null | Total comments on the post. `null` for search results |
| `body` | string | Self-text of the post. Empty for link posts, which have none |
| `url` | string | Link URL (external link posts) or post permalink |
| `postUrl` | string | Direct Reddit permalink to the post |
| `createdUtc` | string | UTC timestamp of when the post was created |
| `flair` | string | Post flair or tag |
| `postType` | string | `text`, `link`, `image`, `video`, ... |
| `domain` | string | Domain of the linked article, for link posts |
| `isStickied` | boolean | Whether the post is pinned by moderators |
| `scrapedAt` | string | ISO 8601 timestamp of when the data was collected |

### Comment data

| Field | Type | Description |
|-------|------|-------------|
| `dataType` | string | Record type identifier (`comment`) |
| `redditId` | string | Reddit fullname, e.g. `t1_p4fu45x` |
| `author` | string | Username of the comment author |
| `body` | string | Full text of the comment |
| `score` | integer \| null | Always `null` — Reddit does not publish comment scores in its public comment feed |
| `depth` | integer | Nesting level (0 = top-level reply, 1 = reply to a reply, etc.) |
| `createdUtc` | string | UTC timestamp of when the comment was posted |
| `postTitle` | string | Title of the parent post |
| `postUrl` | string | Permalink to the parent post |
| `scrapedAt` | string | ISO 8601 timestamp of when the data was collected |

## Use cases

- **Market research** -- Understand what real users say about your product, your competitors, or your industry by mining relevant subreddits and search queries.
- **Sentiment analysis** -- Feed Reddit post and comment data into NLP pipelines to measure community sentiment around brands, product launches, or events.
- **Content ideation** -- Discover what questions people ask, what problems they face, and what topics generate the most engagement in your niche.
- **Competitive intelligence** -- Monitor competitor mentions across Reddit to track public perception and identify strengths or weaknesses in their offering.
- **Academic research** -- Collect structured datasets of online discussions for social science, linguistics, or communication studies.

## Scraping a subreddit without the Reddit API

No API key, no app registration, no OAuth flow and no rate quota to budget around. You pass subreddit names and the Actor reads what a browser sees.

That matters beyond the setup time. Reddit's API applies per-app rate limits and requires an approved application, which is a real obstacle for a one-off market study or a client project you will run twice. Here the only limits are the ones you set: `maxPostsPerSubreddit`, and `sortBy` / `timeFilter` to choose the window.

`sortBy: "top"` with `timeFilter: "year"` gives you the community's greatest hits — the reference threads people link back to. `sortBy: "new"` gives you what is happening right now. Different questions, one run each.

## Exporting posts and comments to CSV

Every row is flat, so the dataset opens straight in Excel, Sheets or a pandas dataframe with no unnesting.

`includeComments: false` returns one row per post — the shape you want for a spreadsheet. Turn it on and each comment becomes its own row alongside the posts, with `dataType` telling you which is which and `depth` showing how deep in the thread a comment sits. Filter on `dataType` after export and one run gives you both tables.

Fields that fill on essentially every post: `postTitle`, `subreddit`, `author`, `body`, `url`, `commentCount` and `createdUtc`. `score` and `upvoteRatio` come back for the large majority; Reddit hides them on a small share of threads, and the Actor leaves them null rather than guessing.

## Finding customer pain points for market research

The research move is not reading a subreddit — it is sorting it. Two columns do most of the work.

`commentCount` finds the arguments. A post with a modest `score` and a high `commentCount` is a topic people disagree about, and disagreement is where the unmet needs are. A high score with few comments is usually applause: pleasant, not informative.

`upvoteRatio` finds the tension. A ratio near 1.0 is consensus. A ratio around 0.6 means the community is split, which is exactly where a product opportunity or a positioning risk lives.

Sort by `commentCount` descending, read the top twenty `body` fields, and you have the vocabulary your customers actually use — which is worth more to a landing page than any keyword tool.

## Monitoring a subreddit for product feedback

Pass `searchQueries` with your brand, your competitors, or the problem you solve, and schedule the run.

Because `createdUtc` and `redditId` come back on every row, deduplicating against your last run is a one-line join: anything with an id you have not seen is new. That turns a scheduled run into a feedback stream rather than a repeated dump.

For a monitoring setup, `sortBy: "new"` with a short `timeFilter` keeps runs small and cheap. Watch `commentCount` on rows that mention you — a mention gathering replies needs a human answer today, not in next week's report.

## Input parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `subreddits` | array | No | `[]` | Subreddit names to scrape (without `r/`), e.g., "technology", "programming" |
| `searchQueries` | array | No | `[]` | Keywords to search across all of Reddit |
| `postUrls` | array | No | `[]` | Direct Reddit post URLs to scrape comments from |
| `maxPostsPerSubreddit` | integer | No | `100` | Maximum posts to extract per subreddit or search query (1--500) |
| `includeComments` | boolean | No | `false` | Whether to extract comments from each post |
| `maxCommentsPerPost` | integer | No | `100` | Maximum comments to extract per post (1--500) |
| `includeVoteData` | boolean | No | `true` | Fetch score, upvote ratio and comment count for subreddit posts. Costs extra residential bandwidth; turn off for cheaper, faster runs when you only need titles, authors, dates and text |
| `sortBy` | string | No | `"hot"` | How to sort posts: `hot`, `new`, `top`, or `rising` |
| `timeFilter` | string | No | `"week"` | Time period when sorting by top: `hour`, `day`, `week`, `month`, `year`, `all` |
| `maxConcurrency` | integer | No | `3` | Number of browser pages to run in parallel (1--10) |

At least one subreddit, search query, or post URL must be provided.

## Example output

```json
{
    "dataType": "post",
    "postTitle": "What's the best programming language to learn in 2026?",
    "author": "dev_user123",
    "subreddit": "programming",
    "score": 1547,
    "commentCount": 342,
    "body": "I've been thinking about switching careers into software development. I have some experience with Python from college, but I'm wondering what the job market actually wants right now. Any advice?",
    "url": "https://old.reddit.com/r/programming/comments/abc123/whats_the_best_programming_language/",
    "postUrl": "https://old.reddit.com/r/programming/comments/abc123/whats_the_best_programming_language/",
    "createdUtc": "2026-02-28T15:30:00Z",
    "flair": "Discussion",
    "isStickied": false,
    "scrapedAt": "2026-03-01T12:00:00.000Z"
}
```

```json
{
    "dataType": "comment",
    "author": "senior_eng_42",
    "body": "Honestly, it depends on what you want to do. For web development, JavaScript/TypeScript is still king. For data science and ML, Python is non-negotiable. For enterprise backend work, Java and Go are in very high demand.",
    "score": 892,
    "depth": 0,
    "createdUtc": "2026-02-28T16:15:00Z",
    "postTitle": "What's the best programming language to learn in 2026?",
    "postUrl": "https://old.reddit.com/r/programming/comments/abc123/whats_the_best_programming_language/",
    "scrapedAt": "2026-03-01T12:00:00.000Z"
}
```

## How much does it cost?

This actor uses a pay-per-result pricing model. You are charged for each data record (post or comment) that is successfully extracted.

- **$0.002 per result** -- that is $2.00 per 1,000 records.
- Scraping 100 posts from a subreddit (without comments) costs approximately **$0.20**.
- Scraping 1,000 posts (without comments) costs approximately **$2.00**.
- Scraping 100 posts with 20 comments each (2,100 results) costs approximately **$4.20**.

There are no monthly subscriptions or minimum commitments. You only pay for the data you extract.

## Tips and tricks

- **Use search queries for broad research.** Subreddit scraping is best for focused communities. If you want to find every mention of a brand or topic across all of Reddit, use the `searchQueries` input instead.
- **Enable comments selectively.** Comments multiply the number of results quickly. If you only need post-level data (titles, scores, dates), leave `includeComments` set to `false` to keep costs low and runs fast.
- **Sort by "top" for high-signal data.** When researching popular opinions or frequently recommended products, sort by `top` with a time filter of `month` or `year` to surface the most upvoted content.
- **NSFW subreddits are supported.** The scraper handles Reddit's age verification prompts automatically, so you can scrape any publicly accessible subreddit.

## FAQ

**How do I scrape Reddit posts and comments from a subreddit?**
Enter one or more subreddit names (without `r/`), choose a sort order (`hot`, `new`, `top`, or `rising`), set how many posts you want, and optionally enable comments. The scraper returns titles, authors, upvote scores, body text, timestamps, and flair as a clean dataset you can export to JSON, CSV, or Excel.

**Do I need an API key or Reddit account to use this Reddit scraper?**
No. There is no Reddit API key, OAuth app, or login to manage. You just provide subreddits, search queries, or post URLs and the actor returns the public data directly.

**Why use this instead of the official Reddit API?**
The official Reddit API now has strict rate limits, paid access tiers, and approval requirements that make large-scale or commercial scraping painful. This actor needs no API credentials, has no per-app rate-limit ceiling to manage, and lets you scrape posts plus full comment trees across many subreddits in one run.

**What is a good Reddit API alternative for sentiment analysis?**
This actor is a practical Reddit API alternative for sentiment and market research: it pulls posts and comment text (with upvote scores and depth) ready to feed straight into NLP or LLM pipelines, without the cost and quota headaches of the official API.

**Can I use this for sentiment analysis and brand monitoring?**
Yes. Use `searchQueries` to find every mention of a brand, product, or topic across all of Reddit, enable comments, and feed the post and comment text into your sentiment model. Sort by `top` with a `month` or `year` time filter to surface the highest-signal opinions.

**Is scraping public Reddit data legal?**
This tool collects only publicly accessible posts and comments. You are responsible for complying with Reddit's terms, applicable laws such as GDPR and CCPA, and using the data ethically. Avoid collecting personal data without a lawful basis.

## Automate it

Add this Reddit scraper to an Apify **Schedule** to monitor a subreddit, search query, or brand mention automatically every day or week — ideal for ongoing sentiment tracking and competitive intelligence. Connect the output to **Make, n8n, Zapier, Google Sheets, Slack, or a webhook** through Apify integrations so new posts and comments flow straight into your dashboards, alerts, or NLP pipeline. Recurring runs keep your sentiment dataset continuously fresh.

## Related actors

- [YouTube Channel & Video Scraper](https://apify.com/renzomacar/youtube-scraper) -- Extract YouTube channel statistics and video metadata to combine with Reddit community insights for a complete content research workflow.
- [TikTok Profile & Post Scraper](https://apify.com/renzomacar/tiktok-scraper) -- Collect TikTok creator profiles and video data to complement Reddit sentiment analysis with social media performance metrics.
- [Instagram Scraper](https://apify.com/renzomacar/instagram-scraper) -- Add Instagram profile and post data to your social listening so brand sentiment spans Reddit and Instagram.
- [Telegram Channel Scraper](https://apify.com/renzomacar/telegram-channel-scraper) -- Capture public Telegram channel messages and views to widen your sentiment and OSINT coverage beyond Reddit.
- [Trustpilot Reviews Scraper](https://apify.com/renzomacar/trustpilot-reviews) -- Combine Reddit opinions with structured Trustpilot reviews for a fuller picture of customer sentiment.

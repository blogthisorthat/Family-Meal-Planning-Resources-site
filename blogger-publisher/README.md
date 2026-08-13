# Blogger Publisher Queue

This directory is the source of truth for The Man That Cooks Sometimes Blogger publishing workflow. The Cloudflare Worker reads `queue/current.json` from GitHub and publishes the HTML to Blogger.

## Required recipe workflow

Recipe posts are prepared in this order:

1. Create the recipe and assign a unique `queueId`.
2. Create the recipe image before enabling the queue item.
3. Store the image under `blogger-publisher/images/<queueId>.<ext>` in this public repository.
4. Use the public raw GitHub URL as `imageUrl`.
5. Embed that exact `imageUrl` in an `<img>` tag near the top of `contentHtml`.
6. Set `imageRequired` to `true` and `imageStatus` to `ready`.
7. Set `enabled` to `true` only after the image URL is live and embedded.

A recipe queue item must never be enabled while `imageStatus` is `missing`, while `imageUrl` is null, or while the image is absent from `contentHtml`.

## Queue contract

```json
{
  "enabled": false,
  "queueId": "recipe-YYYY-MM-DD-slug",
  "blog": "cooking",
  "title": "Recipe title",
  "imageRequired": true,
  "imageStatus": "missing",
  "imageUrl": null,
  "contentHtml": "...",
  "labels": []
}
```

When ready, `imageStatus` becomes `ready`, `imageUrl` contains the public image URL, the same URL is embedded in `contentHtml`, and `enabled` becomes `true` in the final queue commit.

## Worker source

`worker.js` is the canonical Worker source. It preserves the protected manual `/run` endpoint, Google OAuth refresh, Blogger duplicate protection, scheduled publishing, and a fail-closed recipe image check for the next Worker deployment.

Do not store passwords, OAuth tokens, API keys, refresh tokens, or other secrets in this repository.

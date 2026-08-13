# Blogger Publisher Queue

This directory is the source of truth for The Man That Cooks Sometimes Blogger publishing workflow. The Cloudflare Worker reads `queue/current.json` from GitHub and publishes the HTML to Blogger.

## Recipe image quality standard

Every recipe hero image must be a realistic food photograph or a highly photorealistic raster image that accurately matches the finished recipe.

- Use only JPG/JPEG, PNG, or WEBP for published recipe images.
- Do not use SVG images for Blogger posts.
- Do not use illustrations, cartoons, diagrams, UI screenshots, screenshot composites, or mock blog layouts as recipe images.
- The visible food must match the recipe's main protein, vegetables, sauce, pasta, toppings, and cooking style closely enough that a reader would reasonably believe the photo shows that recipe.
- Favor appetizing natural food photography: realistic texture, believable portions, normal cookware, good lighting, and no text over the food.
- The image URL must be publicly reachable before the queue is enabled.

## Required recipe workflow

Recipe posts are prepared in this order:

1. Create the recipe and assign a unique `queueId`.
2. Select or create a realistic raster food image that matches the finished recipe.
3. Verify the JPG/JPEG, PNG, or WEBP image URL is publicly reachable.
4. Put that URL in `imageUrl` and record its MIME type in `imageType` when known.
5. Embed that exact `imageUrl` in an `<img>` tag near the top of `contentHtml`.
6. Set `imageRequired` to `true` and `imageStatus` to `ready`.
7. Set `enabled` to `true` only after the image URL is live and embedded.

A recipe queue item must never be enabled while `imageStatus` is `missing`, while `imageUrl` is null, while the image is absent from `contentHtml`, or while the image uses SVG.

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
  "imageType": null,
  "contentHtml": "...",
  "labels": []
}
```

When ready, `imageStatus` becomes `ready`, `imageUrl` contains the public raster image URL, the same URL is embedded in `contentHtml`, and `enabled` becomes `true` in the final queue commit.

## Worker source

`worker.js` is the canonical Worker source. It preserves the protected manual `/run` endpoint, Google OAuth refresh, Blogger duplicate protection, scheduled publishing, and a fail-closed recipe image check for the next Worker deployment.

Do not store passwords, OAuth tokens, API keys, refresh tokens, or other secrets in this repository.

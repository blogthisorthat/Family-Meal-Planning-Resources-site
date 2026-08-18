# Daily Recipe Automation Prompt — The Man That Cooks Sometimes

Run exactly one daily recipe publication job for the Blogger blog **The Man That Cooks Sometimes**.

## Audience and evergreen focus

Write for dads, husbands, busy men, beginner cooks, and anyone who wants satisfying food without complicated cooking. Optimize naturally for evergreen Google Search intent. Rotate among easy weeknight dinners, grilling, slow-cooker meals, one-pan meals, air-fryer recipes, game-day food, family dinners, hearty breakfasts, simple desserts, budget meals, high-protein meals, and impressive-but-easy meals.

## Mandatory preflight guard

Before creating anything:

1. Read `blogger-publisher/queue/current.json`.
2. Read `blogger-publisher/state/last-publish.json` when it exists.
3. Do not overwrite an enabled queue item unless `last-publish.json` confirms the same `queueId` completed successfully and includes a Blogger `postUrl`.
4. Check whether this automation already published a recipe today in `America/New_York`. If it did, stop without creating a second daily post.
5. Search prior posts on The Man That Cooks Sometimes when accessible and avoid duplicate or substantially similar recipes, titles, and primary search targets.
6. Use a unique stable `queueId` that has never appeared in the queue, publishing state, image directory, or prior posts.

## Original recipe requirement

Develop an original recipe whenever practical. Do not copy another creator's prose, headnote, instructions, photograph, or distinctive presentation. If the recipe is materially adapted from a specific published creator, credit and link to the source in the article text while still using a newly generated original image.

## Mandatory original image

Generate at least one new photorealistic landscape image showing the exact finished dish.

The image may show only food, cookware, ingredients, or a neutral kitchen or dining setting. It must not contain text, captions, logos, watermarks, names, email addresses, usernames, user interfaces, screenshots, profile photos, people, hands, personal information, branded packaging, or unrelated food.

Visually inspect the generated image before publishing. Confirm that the visible protein, vegetables, starch, sauce, toppings, and cooking style match the recipe. Discard and replace any image containing readable text, identifying information, visual defects, or a recipe mismatch.

Do not use Wikimedia, stock-photo sites, recipe-blog images, search-result images, or any third-party image source.

## Required GitHub image path

Store the generated image in:

`blogger-publisher/images/<queueId>.jpg`

Use the connected repository:

`blogthisorthat/Family-Meal-Planning-Resources-site`

Prefer this reliable binary-write procedure:

1. Convert or compress the generated image to a valid JPEG when needed.
2. Calculate its SHA-256 digest.
3. Base64-encode the JPEG.
4. Create a Git blob with `encoding=base64`.
5. Read the current `main` commit and tree.
6. Create a tree entry for `blogger-publisher/images/<queueId>.jpg` based on the current `main` tree.
7. Create a commit and fast-forward `refs/heads/main` to it.
8. Confirm the exact image file exists on `main`, is nonempty, has JPEG bytes, and is publicly reachable before enabling the queue.

The canonical public image URL is:

`https://raw.githubusercontent.com/blogthisorthat/Family-Meal-Planning-Resources-site/main/blogger-publisher/images/<queueId>.jpg`

Do not require R2. GitHub raw hosting is the canonical image source for this automation.

If image generation, visual inspection, JPEG conversion, GitHub upload, checksum validation, or public image verification fails, do not enable or publish a queue item. Retry with a replacement image or stop and report the failure. Never substitute a third-party image.

## Article requirements

Create complete semantic HTML suitable for Blogger. Include:

- Recipe name and concise description
- Prep time, cook time, total time, and servings or yield
- Equipment
- Exact ingredient quantities
- Numbered instructions
- Useful doneness cues and safe cooking temperatures when relevant
- Two to four genuinely useful cooking tips
- Substitutions
- Storage and reheating guidance
- A concise FAQ only when helpful
- Estimated nutrition only when reasonably calculable, clearly labeled as an estimate
- A natural descriptive link to Family Meal Planning Tools and the recipe scaler when useful

Use short paragraphs, `h2` and `h3` headings, `ul` and `ol` lists, `strong` tags, and safe descriptive links. Do not include scripts, JSON-LD, forms, tracking code, unsafe HTML, image credits, or attribution sections for generated imagery.

Embed the verified image near the top with descriptive alt text naming the dish, for example:

`<img src="<verified raw GitHub URL>" alt="Easy one-pan honey garlic chicken and rice in a skillet" style="max-width:100%;height:auto;border-radius:10px;">`

## Queue contract

After the generated JPEG is committed and verified on `main`, read `blogger-publisher/queue/current.json` again to avoid a race. Replace it with exactly one ready item using this contract:

```json
{
  "enabled": true,
  "queueId": "<unique stable id>",
  "blog": "cooking",
  "title": "<SEO title>",
  "primarySeoTarget": "<primary evergreen query>",
  "contentHtml": "<complete Blogger-ready HTML containing the exact image URL>",
  "labels": ["<relevant Blogger labels>"],
  "imageRequired": true,
  "imageStatus": "ready",
  "imageUrl": "<exact raw GitHub JPEG URL>",
  "imageType": "image/jpeg",
  "imageAlt": "<descriptive finished-dish alt text>",
  "imageStorage": "github-raw",
  "publishRequestedAt": "<current UTC timestamp>"
}
```

Do not put secrets, email addresses, usernames, personal names, API keys, OAuth tokens, Cloudflare credentials, or other private data in the queue, image path, article, or GitHub commits.

The Cloudflare Worker publishes directly to Blogger through the Blogger API. Never use Blogger email-to-post.

## Post-publish verification

After updating the queue:

1. Wait for `blogger-publisher/state/last-publish.json` to update.
2. Confirm it contains the same `queueId`, `ok=true`, `workflowOutcome=success`, a nonempty `postUrl`, the expected `imageUrl`, and `imageStatus=ready`.
3. Treat `publishAction=published` as a new publication and `publishAction=none` with a valid `postUrl` as a successful duplicate-protection result.
4. If the state does not confirm success, inspect the GitHub Actions run and correct the failure without replacing the image with third-party content.

After success, notify the user with the title, primary SEO search target, `queueId`, image path, image URL, Blogger post URL, and confirmation that direct Blogger API publishing completed.

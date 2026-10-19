# Sending images to a Harbor session

Images are part of a single request, not of the session. They work with `create`, `start`, `resume` and `send`, for both Claude Code and Codex.

```sh
"$HARBOR_NODE" "$HARBOR_CLI" send <session-id> --actor grok --request-id visual-review-001 \
  --text "Compare these two screenshots and list what changed." \
  --image "/absolute/path/before.png" \
  --image "/absolute/path/after.png"
```

## Limits

- Up to **8 images**, **10 MiB each**, **32 MiB in total**.
- PNG, JPEG or WebP, detected from the file header.
- Absolute paths to regular local files. URLs, directories, symbolic links and paths with control characters are rejected.
- An image-only request (no `--text`) gets a short neutral "describe" prompt.

## Identity and retries

Harbor copies each file into private storage and includes its hash, path and order in the request's identity. Retrying with the same request ID requires the same text **and** the same image bytes, paths and order; anything else is `REQUEST_ID_CONFLICT`. Keep the source files unchanged until the request is accepted. Reading `result` later does not need them. `request.images` lists hashes and metadata, never image data.

## Long prompts or awkward paths

Write a private JSON file and pass it alone with `--request-file`. The session ID goes inside the file:

```json
{
  "id": "7c1e2f2a-5b1d-4f54-9a43-0d2a4f6b8e11",
  "actor": "grok",
  "requestId": "visual-review-001",
  "text": "Describe the attached screenshot.",
  "images": ["/absolute/path/screenshot.png"]
}
```

```sh
"$HARBOR_NODE" "$HARBOR_CLI" send --request-file /absolute/private/request.json
```

`--request-file` also works with `create`, `start` and `resume`, and cannot be combined with other options.

## When attachment fails

`IMAGE_COMPOSER_NOT_READY` or `IMAGE_ATTACH_UNCONFIRMED` means Harbor could not confirm the attachment in the CLI and submitted nothing. A draft may remain in the terminal: tell the human, and never resend the task under a new request ID.

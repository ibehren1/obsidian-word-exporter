# Project Rules

## Version bump on every commit

Every commit MUST bump the patch version (`z` in `x.y.z`). No exceptions — this applies to all commits regardless of size or type (docs, chores, fixes, features, reverts).

Before each commit:

1. Run `npm version patch --no-git-tag-version`. This bumps `package.json` (and `package-lock.json`), then runs `version-bump.mjs` to sync `manifest.json` and `versions.json`.
2. Stage the bumped files in the same commit: `package.json`, `package-lock.json` (if present), `manifest.json`, `versions.json`.
3. Confirm `package.json` and `manifest.json` versions match before committing.

Never commit without the bump, and never bump `x` or `y` unless the user explicitly asks.

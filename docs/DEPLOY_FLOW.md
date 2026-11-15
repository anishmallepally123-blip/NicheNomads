# Deploy flow (staying under Vercel's 100 deploys a day)

Vercel's free plan allows 100 deployments a day, and every push to a PR
branch used to count as one. `vercel.json` now has an `ignoreCommand` that
skips the build for every branch except `main` (and `preview/*`, see below).
So normally only merges into `main` deploy.

## Day to day

1. Branch off `staging` and open your PR **against `staging`**, not `main`.
2. Merge as many PRs into `staging` as you like. None of them deploy.
3. When a batch is ready, open one PR from `staging` into `main` and merge it.
   That is one production deploy for the whole batch.
4. After that merge, bring `staging` up to date with `main` before the next batch.

## Previewing a branch on demand

Branches whose name starts with `preview/` still build, so to get a preview
link push your work to one, for example:

    git push origin my-branch:preview/my-branch

Each push to a `preview/` branch counts as one deployment, so use them
sparingly and delete the branch when done.

## Vercel project settings this relies on

- Production branch must be `main`.
- Root Directory stays as the repo root, because `vercel.json` lives there
  and its build commands already `cd frontend`.
- Environment variables (for example `NICHE_SERVER_URL`) are set per project,
  so add them again on the new project.

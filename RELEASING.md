# Releasing @stablecoin.xyz/x402

## Every release (normal flow)

```bash
# 1. Make your changes, commit them normally

# 2. Describe what changed
pnpm changeset
# → choose: patch (bug fix) / minor (new feature) / major (breaking change)
# → write a one-line summary
# → commits a file to .changeset/

# 3. Push
git add .changeset/
git commit -m "chore: changeset"
git push
```

CI automatically opens a **"chore: release" PR** that bumps the version and writes CHANGELOG.md.

**Merge that PR** → CI publishes to npm via OIDC. Done.

---

## How CI works

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `ci.yml` | Every push / PR | typecheck → build → test |
| `release.yml` | Push to main | If changesets pending: open Release PR. If Release PR merged: publish to npm |

Publishing uses **OIDC trusted publisher** — no npm token stored anywhere.

---

## Version bump guide

| Change type | Example | Version bump |
|-------------|---------|--------------|
| Bug fix | Fix crypto error in signing | `patch` → 0.1.1 |
| New feature | Add EIP-3009 support | `minor` → 0.2.0 |
| Breaking change | Rename middleware import | `major` → 1.0.0 |

---

## If you need to publish manually (emergency)

```bash
# Ensure you're logged in to npm
npm whoami

# Build, test, publish
pnpm release
```

---

## Setup (already done — for reference)

- npm trusted publisher configured at `npmjs.com/package/@stablecoin.xyz/x402/access`
- Changesets configured in `.changeset/config.json` (access: public)
- GitHub Actions: `.github/workflows/ci.yml` + `.github/workflows/release.yml`

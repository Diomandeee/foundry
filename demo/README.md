# demo/ — rehearsal notes

The video plan that lived here (a seeded 3-agent project with conflicting tasks)
was superseded. The delivered demo shows the real system instead: the local
fork-to-verdict loop, then live refusals and merges on staging, then the three
agents that really built a dispatcher in three forks.

Rebuild the rehearsal and watch it yourself first:

```bash
npx tsx tools/graphvc-demo.ts --root /tmp/foundry-demo
```

That creates base + fork + ticket locally, pushes a file, prints the verdict,
and shows base advance. Nothing leaves the machine, and no Cloudflare account is
needed.

This directory holds no code. See `VIDEO-SCRIPT.md` for the delivered demo's
beat-by-beat narration.

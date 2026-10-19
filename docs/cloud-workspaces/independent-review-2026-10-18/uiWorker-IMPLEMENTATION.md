Implemented within the four-file scope:

- [build-submission.ts](/Users/mohameddiomande/Developer/foundry-integration/source/tools/foundry-pilot/build-submission.ts:48): bounded 64-intent listing, exact-identity recovery, and gated acknowledgement.
- [operator-server.ts](/Users/mohameddiomande/Developer/foundry-integration/source/tools/foundry-pilot/operator-server.ts:84): authenticated listing/recovery routes using existing session and CSRF protections.
- [builds.js](/Users/mohameddiomande/Developer/foundry-integration/source/tools/foundry-pilot/operator/builds.js:14): reload recovery, acknowledgement, and lost-ack receipt retrieval independent of placement eligibility.
- [index.html](/Users/mohameddiomande/Developer/foundry-integration/source/tools/foundry-pilot/operator/index.html:31): dedicated recovery panel.

Recovery preserves stored requestId/jobId/key/body/epoch, rejects missing or mismatched intents, and only replays the identical pending command. It allocates no intent, alias, or attempt. Profile and credential gates remain enforced.

Evidence: reviewed UI → handlers → journal → authority deduplication end-to-end, including failure paths. Existing preimages preserved; no other files written or others’ changes reverted.

RTD structure, source integration, content, and journey reviewed. Compilation, execution, and deployment remain pending; no tests authored or run.

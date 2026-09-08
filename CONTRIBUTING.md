# Working on LearnWithNoura

Use Node 24, `npm ci`, and the fixture configuration in `.env.example`. Start with `AGENTS.md` and `docs/architecture/INDEX.md` for the current contracts. Keep the scope of a change explicit: scene geometry, playback truth, lesson scheduling and persistence have different owners.

For behavior changes, add a regression that fails first. Preserve visible tutor work, learner draft ownership, deterministic validation, and released-only replay. Update a prompt, tool schema and its validator together. Keep historical evidence unchanged; a new experiment needs a new result with its real date and conditions.

Run `npm run gate:quick` and the checks relevant to the changed boundary. Before a release, use `docs/verification.md`. Browser tests must use fixture compilation and synthetic learners. Do not run paid/provider evaluation or deployment as part of a routine test command.

Commit related changes together with a subject that explains their purpose. Preserve contributor attribution and state whether evidence is from a new run, a retained historical result, or a deterministic fixture.

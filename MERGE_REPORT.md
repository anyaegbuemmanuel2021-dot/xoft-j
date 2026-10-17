# XOFT & Jarvis — merge report

## What was integrated

- Source repository: [anyaegbuemmanuel2021-dot/xoft-Ai-core](https://github.com/anyaegbuemmanuel2021-dot/xoft-Ai-core), source release/version `0.11.1`, source commit `c4dbc7ecf938f685b6ff4fdf25bb37a847aca05b`.
- Transferred the source tree into this new repository, including the Node.js backend, provider adapters, orchestration and tools, memory systems, mission/workflow engines, approvals, security and emergency-stop modules, WhatsApp service/inbox modules, PC-agent runtime, web dashboard, mobile and desktop app sources, deployment files, documentation, and test suite.
- All 402 tracked files from the source tree were transferred, including the binary `public/favicon.ico` asset.
- The source root package, lockfile, server entry point, dashboard, and deployment configuration supersede the earlier starter-MVP versions in this repository. The unused prototype-only `public/app.js` and `public/styles.css` were removed.

## How the older `xoft` repository was handled

The older [xoft](https://github.com/anyaegbuemmanuel2021-dot/xoft) repository is version `0.9.0` and shares most of its meaningful application files with the newer `xoft-Ai-core` tree. The newer core adds the larger engine/runtime, integrations, command center, PC agent, and test coverage. The few older-only files are legacy/placeholder artifacts, so they were not allowed to overwrite the newer implementations. The old repository was not modified.

## External open-source research

The architecture was also reviewed against these projects:

- [Khoj](https://github.com/khoj-ai/khoj) — multi-provider personal knowledge, retrieval, agents, and integrations. Its AGPL-3.0 license makes wholesale code import a separate licensing decision.
- [Leon](https://github.com/leon-ai/leon) — modular personal-assistant skills; MIT-licensed.
- [Open Interpreter](https://github.com/openinterpreter/openinterpreter) — tool execution and computer-use patterns with sandboxing and approval boundaries.

No source code from those third-party projects was copied into this repository. The integrated application is based on the user's own XOFT source repositories, with these external projects used as architectural references.

## Verification status

- Source transfer commits are on this repository's `main` branch.
- A CI workflow and the upstream test suite are present.
- **The full CI/test suite has not yet been confirmed passing on the new repository.** Verify the GitHub Actions run before deployment.
- Real integrations still depend on credentials and provider/platform configuration. A source module existing does not mean its external account is connected.
- Keep `xoft` and `xoft-Ai-core` as untouched source repositories; all integration changes belong here.

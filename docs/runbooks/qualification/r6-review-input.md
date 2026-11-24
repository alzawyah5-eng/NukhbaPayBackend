# R6 successor review input

**Review pending. Execution authorization pending.**

The reconciliation compared all 486 current pins with the archival R6 release and verified all 475 snapshot pins. Four TypeScript builds emitted into a separate evidence directory. The active candidate and the archived snapshot remain preserved.

| Drifting pins | Finding |
| --- | --- |
| 9 source files | Documented development changes. The manifest records each path, original/current digest and purpose. |
| 18 generated files | Reproduced from current source. Source-map source paths were resolved before comparison because the output directory changes their relative paths. |
| 2 generated files | Stale published catalogue JavaScript and its source map. The JavaScript lacks the signed token expiry check after binding lookup. Both staged outputs were rebuilt from the current corrected source. |

The review manifest is `.local/r6-reconciliation-1795100333937237100/manifest.json` with SHA-256 `ab706d1ddcf18efceec238d7043c809b789434191b5803a12744af371f03542b`. The original candidate remains `846289ea59e2af23aa7aec8a7def1f33d48597d9fe65d1ff983a2bf2c7f4ca96`.

An independent reviewer should inspect all drift entries, check the generated artifact-to-source correspondence and test evidence, and record a decision bound to the exact new manifest. The staged outputs and their source paths need reviewed packaging for the target execution environment. The existing signer and target provenance gates apply before activation. The scope covers the original R6 SQL and source; qualifications for subsequent application work and migration 012 require a separate decision.

To recreate the review input, run `python scripts/reconcile-r6-offline.py` from the main repository. The command writes a new evidence directory, validates archived hashes, and checks that the original worktree pins stayed stable while it compiled. A newly generated digest needs its own review.

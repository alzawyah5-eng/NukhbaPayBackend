# Brick 3 and Brick 4 source candidate

The candidate captures the current main worktree as source bytes over its recorded Git base. It includes each tracked and untracked source path, its Git status, byte length and SHA-256. The ZIP is reproducible from the same source bytes. The manifest records generated build and Python-cache paths separately. Environment files, runtime credentials, databases, dependency trees and ignored evidence stay in their existing locations.

From the repository root, run `python scripts/brick34-source-candidate.py --compare-worktrees`. Keep the resulting `source.zip` and `manifest.json` together under the printed `.local/brick34-source-*` directory. Supply `--evidence <file>` for each existing verification receipt to include its hash in the manifest. Evidence file contents stay outside the source archive.

Verify the candidate with `python scripts/brick34-source-candidate.py --verify <manifest-path>`. This checks the Git base, inventory, source bytes, archive bytes and any evidence hashes. Archive validation does not execute application code. A sibling worktree marked UNVERIFIED needs an owner-confirmed Git identity before its working changes can be compared. Worktree ancestry still identifies commits already contained in the main base.

## Integrate the accepted baseline

1. Verify the candidate and preserve the original R6 archives and the frozen migration manifest. Review candidate changes by package, separately from generated builds and local run receipts.
2. Review each divergent or sibling-only source path with its owner. Select the intended implementation and recapture the candidate if that review changes its contents.
3. Apply the reviewed source to a new integration branch and workspace based on the recorded Git commit. Stage the manifest paths explicitly. Check the staged diff for local bootstrap tooling, secrets, generated files and unintended permission or migration changes.
4. After the integration commit is accepted, verify its clean checkout with `python scripts/brick34-source-candidate.py --verify <manifest-path> --integrated` and the original manifest and archived ZIP available. Provide the referenced evidence under the same repository-relative paths. Verification uses byte equality, so resolve checkout line-ending differences before proceeding.
5. Run the documented offline suite and affected disposable fixtures on the integration checkout. Verify the frozen sources with `pnpm.cmd db:verify:sources`. For R6, retain the historic decision and mismatch report and prepare a fresh successor against the accepted source, using `scripts/reconcile-r6-offline.py` and the R6 qualification runbook.
6. Record the resulting commit and evidence hashes. Evaluate the Auth0, database, provider and client acceptance gates for that commit before any operational rollout.

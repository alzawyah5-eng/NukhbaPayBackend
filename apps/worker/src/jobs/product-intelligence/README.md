# Product intelligence jobs

Run advisory jobs through the existing worker and return structured evidence
to the platform.

- **Inputs** — versioned internal job envelope, scoped catalogue or outcome
  references, and a deadline.
- **Outputs** — matching or intelligence results with source references,
  bounded failure status and model or rule versions.
- **Dependencies** — [worker boundary](boundary.ts), [Python bridge](python-engine.ts),
  [application job admission](../../../../../packages/application/src/catalog/ai-jobs.ts)
  and [AI service](../../../../ai-service/README.md).

The existing worker invokes the local Python engine. A separate FastAPI service
or Celery with Redis can be considered if Python needs its own runtime or queue.
Provider and financial commands stay in the trusted platform worker paths.

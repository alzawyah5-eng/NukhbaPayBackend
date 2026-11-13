# Repositories

Catalogue and IAM repositories are implemented through narrow application ports and restricted pools. The IAM principal projection now includes the existing tokens_valid_after column, enforced against verifier-registered issuance in the application boundary (ADR 0023). Contact fields and privileged mutations remain inaccessible. Avoid exposing a generic unrestricted SQL client to modules; no repository result or database credential establishes human authorization.


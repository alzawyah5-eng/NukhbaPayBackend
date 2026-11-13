# Local infrastructure

Current project name: **Nukhbapay**. The existing Compose project/storage locator is deliberately preserved; see [naming compatibility](../../docs/naming-standardization.md) before operating any existing container or volume.

PostgreSQL catalogue and local synthetic IAM/workflow foundations are tested on disposable targets. The existing development database retains its legacy name and migration history 001 through 003; migrations 004/005 must not be run there. Container operation is separate from the existing local PostgreSQL acceptance cluster. Do not start another server against an occupied port or initialize existing storage as a naming operation.

The reviewed `.env.example` uses canonical `NUKHBAPAY_*` host inputs. An authorized operator must supply separate credentials in their local secret store, never chat or source control. Compose explicitly maps two canonical host password inputs to the legacy container variables required by preserved bootstrap SQL. `DB_*` URL keys and restricted workload role values remain unchanged. No private environment file is modified by this increment.

For a separately approved fresh local container setup only:

```bash
docker compose --env-file .env -f infra/local/compose.yaml up -d postgres
```

Redis remains optional, enabled only through the `cache` profile. Both ports bind to loopback. Existing Compose project/volume names must not change without inventory, backup/restore and an explicit storage transition. No Compose command was run for this naming task.

Major-version image tags remain a development limitation; production needs reviewed pinned images, isolated credentials/networking, TLS, backup/recovery and explicit security approval. AI receives no core database credentials. See the database package documentation and verification record for actual restricted-role/migration acceptance.

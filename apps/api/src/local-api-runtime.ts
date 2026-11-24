import { Module, type LoggerService, type Type } from "@nestjs/common";
import { createIdentityRuntime, parseIdentityRuntimeConfiguration } from "@nukhbapay/database/identity-runtime";
import { createApiApplication } from "./http-application.js";
import { AppModule } from "./app.module.js";
import { parseApiConfig } from "./api.config.js";
import { parseIdentityConfiguration } from "./modules/identity/identity.config.js";
import { OidcAccessTokenVerifier } from "./modules/identity/oidc-access-token.verifier.js";
import type { JwksFetch } from "./modules/identity/trusted-jwks.js";
import type { IdentityBoundaryDependencies } from "./modules/identity/identity-boundary.js";
import { createStaffAdministration, type AdministrationReaders, type StaffAuthorizationRepository, type SecurityAuditWriter } from "@nukhbapay/application";

type Environment = Readonly<Record<string, string | undefined>>;
interface IamRuntime {
  readonly repository: StaffAuthorizationRepository;
  readonly auditWriter: SecurityAuditWriter;
  checkReadiness(): Promise<boolean>;
  close(): Promise<void>;
}
export class LocalRuntimeUnavailableError extends Error {
  constructor() { super("Local API runtime unavailable"); }
}

/** Programmatic local synthetic composition. No HTTP/env-selected transport or module. */
export async function createLocalApiRuntime(env: Environment, dependencies: {
  readonly fetchKeys?: JwksFetch;
  readonly now?: () => Date;
  readonly rootModule?: Type<unknown>;
  readonly logger?: LoggerService | false;
  readonly administrationReaders?: AdministrationReaders;
  readonly createIam?: (env: Environment) => Promise<IamRuntime>;
} = {}) {
  let iam: IamRuntime | undefined;
  let verifier: OidcAccessTokenVerifier | undefined;
  let stopping = false; let closed = false;
  let resourcesClosing: Promise<void> | undefined;
  const closeResources = (): Promise<void> => resourcesClosing ??= (async () => {
    stopping = true; verifier?.close();
    try { await iam?.close(); } catch { throw new LocalRuntimeUnavailableError(); }
    finally { closed = true; }
  })();
  try {
    const listener = parseApiConfig(env);
    const mode = env["API_STAFF_AUTH_MODE"] ?? "disabled";
    if (mode !== "disabled" && mode !== "local-synthetic") throw new LocalRuntimeUnavailableError();
    if (mode === "local-synthetic") {
      if (!["127.0.0.1", "::1"].includes(listener.host)) throw new LocalRuntimeUnavailableError();
      const config = parseIdentityConfiguration(env);
      parseIdentityRuntimeConfiguration(env);
      if (!new URL(config.issuer).hostname.endsWith(".invalid") || dependencies.fetchKeys === undefined) throw new LocalRuntimeUnavailableError();
      verifier = new OidcAccessTokenVerifier(env, { fetchKeys: dependencies.fetchKeys, ...(dependencies.now === undefined ? {} : { now: dependencies.now }) });
      // Snapshot only IAM fields; ordinary runtime never receives migration/import credentials.
      const iamEnv: Record<string, string | undefined> = {};
      for (const key of ["DB_IDENTITY_READER_URL", "DB_IDENTITY_WRITER_URL", "DB_IDENTITY_READER_ROLE", "DB_IDENTITY_WRITER_ROLE",
        "DB_IDENTITY_POOL_MAX", "DB_IDENTITY_CONNECTION_TIMEOUT_MS", "DB_IDENTITY_QUERY_TIMEOUT_MS", "DB_IDENTITY_STATEMENT_TIMEOUT_MS"]) iamEnv[key] = env[key];
      iam = await (dependencies.createIam ?? createIdentityRuntime)(Object.freeze(iamEnv));
    } else if (Object.keys(env).some((key) => (key.startsWith("IDENTITY_") || key.startsWith("DB_IDENTITY_")) && env[key] !== undefined)) {
      throw new LocalRuntimeUnavailableError();
    }
    let checking: Promise<Readonly<{ ready: boolean }>> | undefined;
    const checkReadiness = (): Promise<Readonly<{ ready: boolean }>> => {
      if (stopping || closed) return Promise.resolve(Object.freeze({ ready: false }));
      return checking ??= (async () => {
        try {
          const results = await Promise.all([verifier?.checkReadiness() ?? true, iam?.checkReadiness() ?? true]);
          return Object.freeze({ ready: !stopping && results.every((value) => value) });
        } catch { return Object.freeze({ ready: false }); }
      })().finally(() => { checking = undefined; });
    };
    if (!(await checkReadiness()).ready) throw new LocalRuntimeUnavailableError();
    const identity: IdentityBoundaryDependencies = mode === "disabled" ? {} : {
      verifier: { verify: async (token) => {
        if (stopping || verifier === undefined) throw new LocalRuntimeUnavailableError();
        return verifier.verify(token);
      } }, repository: iam!.repository, auditWriter: iam!.auditWriter,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    };
    const lifecycle = {
      beforeApplicationShutdown: () => { stopping = true; verifier?.close(); },
      onApplicationShutdown: closeResources,
    };
    @Module({ imports: [dependencies.rootModule ?? AppModule], providers: [{ provide: "LOCAL_API_LIFECYCLE", useValue: lifecycle }] })
    class LocalRuntimeModule {}
    const administration = iam && dependencies.administrationReaders
      ? createStaffAdministration({ repository: iam.repository, auditWriter: iam.auditWriter,
        readers: dependencies.administrationReaders, now: dependencies.now ?? (() => new Date()) })
      : undefined;
    const app = await createApiApplication({ rootModule: LocalRuntimeModule, identity,
      ...(administration?.staffAdministration && { staffAdministration: administration.staffAdministration }),
      ...(administration?.staffCatalogue && { staffCatalogue: administration.staffCatalogue }),
      ...(dependencies.logger === undefined ? {} : { logger: dependencies.logger }) });
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => closing ??= (async () => {
      stopping = true; verifier?.close();
      try { await app.close(); } catch { throw new LocalRuntimeUnavailableError(); }
      finally { await closeResources(); }
    })();
    try { await app.init(); } catch { await close(); throw new LocalRuntimeUnavailableError(); }
    return Object.freeze({ app, checkReadiness, close });
  } catch {
    await closeResources().catch(() => undefined);
    throw new LocalRuntimeUnavailableError();
  }
}

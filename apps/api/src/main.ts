import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createLocalApiRuntime, LocalRuntimeUnavailableError } from "./local-api-runtime.js";
import { parseApiConfig } from "./api.config.js";

export async function bootstrap(
  env: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: Parameters<typeof createLocalApiRuntime>[1] = {},
): Promise<NestExpressApplication> {
  const config = parseApiConfig(env);
  const runtime = await createLocalApiRuntime(env, dependencies);
  try {
    runtime.app.enableShutdownHooks(["SIGINT", "SIGTERM"]);
    await runtime.app.listen(config.port, config.host);
    return runtime.app;
  } catch {
    await runtime.close();
    throw new LocalRuntimeUnavailableError();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void bootstrap().catch(() => {
    console.error("API startup failed");
    process.exitCode = 1;
  });
}

import { PublishedCatalogueHttpBoundary, isPublishedCatalogueHandler, type CatalogueHttpDependencies } from "./modules/catalog/published-catalogue-http.js";
import { Logger, type LoggerService, type Type } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { ExpressAdapter, type NestExpressApplication } from "@nestjs/platform-express";
import express, { type ErrorRequestHandler } from "express";
import { AppModule } from "./app.module.js";
import { SafeExceptionFilter } from "./safe-exception.filter.js";
import { AuthenticationGuard } from "./modules/identity/authentication.guard.js";
import { AuthorizationGuard } from "./modules/identity/authorization.guard.js";
import type { IdentityBoundaryDependencies } from "./modules/identity/identity-boundary.js";

export const MAX_REQUEST_BODY_BYTES = 16 * 1024;
const logger = new Logger("RequestBodyParser");

function requestBodyStatus(error: unknown): 400 | 413 | 415 | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }
  return error.status === 400 || error.status === 413 || error.status === 415
    ? error.status
    : undefined;
}

const requestBodyErrorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  const status = requestBodyStatus(error) ?? 500;
  if (status === 500) {
    logger.error("Unhandled request body parser exception");
  }

  response.status(status).json({
    statusCode: status,
    message: status === 413
      ? "Request body exceeds the allowed size"
      : status === 415
        ? "Unsupported request encoding"
        : status === 400
          ? "Invalid request body"
          : "Internal server error",
  });
};

export interface ApiApplicationOptions {
  /** Trusted test bootstrap/composition only; not selectable through env or HTTP. */
  readonly rootModule?: Type<unknown>;
  readonly identity?: IdentityBoundaryDependencies;
  readonly logger?: LoggerService | false;
  readonly catalogue?: CatalogueHttpDependencies;
}

export async function createApiApplication(options: ApiApplicationOptions = {}): Promise<NestExpressApplication> {
  // Express freezes these router settings when the adapter first installs middleware.
  const serverApplication = express();
  serverApplication.set("case sensitive routing", true);
  serverApplication.set("strict routing", true);
  const app = await NestFactory.create<NestExpressApplication>(options.rootModule ?? AppModule, new ExpressAdapter(serverApplication), {
    bodyParser: false, abortOnError: false, ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  app.use((_request:express.Request,response:express.Response,next:express.NextFunction)=>{response.setHeader("Cache-Control","no-store");next();});
  app.use(express.json({ limit: MAX_REQUEST_BODY_BYTES, strict: true, inflate: false }));
  app.use(requestBodyErrorHandler);
  // No browser/CORS flow is in scope. Suppress Express's implicit OPTIONS allow response.
  app.use((request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (request.method === "OPTIONS") {
      response.setHeader("Cache-Control", "no-store");
      response.status(404).json({ statusCode: 404, message: "Request could not be completed" });
      return;
    }
    next();
  });
  const reflector = app.get(Reflector);
  const dependencies = Object.freeze({ ...options.identity });
  const authentication=new AuthenticationGuard(reflector,dependencies),authorization=new AuthorizationGuard(reflector,dependencies);
  const catalogue=new PublishedCatalogueHttpBoundary(options.catalogue);
  app.useGlobalGuards({canActivate:context=>isPublishedCatalogueHandler(context)?catalogue.authenticate(context):authentication.canActivate(context)},
    {canActivate:context=>isPublishedCatalogueHandler(context)?catalogue.authorize(context):authorization.canActivate(context)});
  app.useGlobalFilters(new SafeExceptionFilter());

  const server = app.getHttpServer();
  server.maxHeadersCount = 100;
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  return app;
}

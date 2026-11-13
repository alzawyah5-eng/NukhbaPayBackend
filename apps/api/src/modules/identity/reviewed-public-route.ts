import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { HealthController } from "../../health.controller.js";
import { PUBLIC_ROUTE } from "./route-security.js";

export function isReviewedPublicRoute(context: ExecutionContext, reflector: Reflector): boolean {
  if (context.getType() !== "http") return false;
  const request = context.switchToHttp().getRequest<Request>();
  return reflector.get<unknown>(PUBLIC_ROUTE, context.getHandler()) === true &&
    context.getClass() === HealthController && context.getHandler() === HealthController.prototype.getLive &&
    request.method === "GET" && typeof request.originalUrl === "string" &&
    request.originalUrl.split("?", 1)[0] === "/health/live";
}

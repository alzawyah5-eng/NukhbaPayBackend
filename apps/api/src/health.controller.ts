import { Controller, Get, Header, Inject, Optional, Res } from "@nestjs/common";
import type { Response } from "express";
import { PublicRoute } from "./modules/identity/route-security.js";

export const STAFF_STORAGE_HEALTH = Symbol("STAFF_STORAGE_HEALTH");

@Controller()
export class HealthController {
  constructor(
    @Optional() @Inject(STAFF_STORAGE_HEALTH) private readonly staffStorageReady?: () => Promise<boolean>,
  ) {}

  @Get("/health/live")
  @PublicRoute()
  @Header("Cache-Control", "no-store")
  async getLive(@Res({ passthrough: true }) response: Response): Promise<{
    readonly status: "ok" | "unavailable";
    readonly database?: "connected" | "unavailable";
  }> {
    if (!this.staffStorageReady) return { status: "ok" };
    if (await this.staffStorageReady().catch(() => false)) {
      return { status: "ok", database: "connected" };
    }
    response.status(503);
    return { status: "unavailable", database: "unavailable" };
  }
}

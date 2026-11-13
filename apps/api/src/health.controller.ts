import { Controller, Get, Header } from "@nestjs/common";
import { PublicRoute } from "./modules/identity/route-security.js";

@Controller()
export class HealthController {
  @Get("/health/live")
  @PublicRoute()
  @Header("Cache-Control", "no-store")
  getLive(): { readonly status: "ok" } {
    return { status: "ok" };
  }
}

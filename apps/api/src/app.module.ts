import { PublishedCatalogueController } from "./modules/catalog/published-catalogue-http.js";
import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";

@Module({
  controllers: [HealthController, PublishedCatalogueController],
})
export class AppModule {}

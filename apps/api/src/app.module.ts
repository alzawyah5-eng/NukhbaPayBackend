import { PublishedCatalogueController } from "./modules/catalog/published-catalogue-http.js";
import {StaffAdministrationController} from './modules/admin/staff-admin-http.js';
import {StaffCatalogueController} from './modules/admin/staff-catalogue-http.js';
import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";

@Module({
  controllers: [HealthController, PublishedCatalogueController, StaffAdministrationController, StaffCatalogueController],
})
export class AppModule {}

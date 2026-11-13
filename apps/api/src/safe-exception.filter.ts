import { Catch, HttpException, Logger } from "@nestjs/common";
import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";

@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(SafeExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const requestedStatus = exception instanceof HttpException ? exception.getStatus() : 500;
    const status = requestedStatus >= 400 && requestedStatus <= 599 ? requestedStatus : 500;
    response.setHeader("Cache-Control", "no-store");
    if (status === 401) response.setHeader("WWW-Authenticate", "Bearer");

    if (status >= 500) {
      this.logger.error("Unhandled HTTP exception");
    }

    response.status(status).json({
      statusCode: status,
      message: status === 503 ? "Service unavailable" : status >= 500 ? "Internal server error" : "Request could not be completed",
    });
  }
}

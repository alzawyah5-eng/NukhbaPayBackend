import { isIP } from "node:net";

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;

export function parseApiConfig(env: Readonly<Record<string, string | undefined>>): ApiConfig {
  const host = env["API_HOST"] ?? DEFAULT_HOST;
  if (isIP(host) === 0) {
    throw new TypeError("API_HOST must be an IPv4 or IPv6 address literal");
  }

  const portInput = env["API_PORT"] ?? String(DEFAULT_PORT);
  if (!/^[1-9]\d{0,4}$/.test(portInput)) {
    throw new TypeError("API_PORT must be an integer from 1 through 65535");
  }

  const port = Number(portInput);
  if (port > 65_535) {
    throw new TypeError("API_PORT must be an integer from 1 through 65535");
  }

  return Object.freeze({ host, port });
}

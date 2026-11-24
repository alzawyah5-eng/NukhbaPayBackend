import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request } from "node:https";
import { checkServerIdentity } from "node:tls";

const certificatePath = new URL("../../../.local/staff-workspace-localhost.cer", import.meta.url);
const fingerprint = "67:ED:04:C0:14:4A:0B:0D:A7:24:3E:C3:4D:75:B2:77:C4:BE:4D:95:9C:DB:E7:D8:2F:72:A5:78:96:03:4D:61";

/** The staff portal verifies PostgreSQL and its restricted roles on this route. */
export async function probeWindowsStaffStorage(): Promise<boolean> {
  try {
    const ca = new X509Certificate(await readFile(certificatePath));
    if (ca.fingerprint256 !== fingerprint) return false;

    return await new Promise<boolean>((resolve) => {
      const probe = request({
        hostname: "127.0.0.1",
        port: 3001,
        servername: "localhost",
        headers: { host: "localhost:3001" },
        method: "HEAD",
        path: "/health/staff-storage",
        ca: ca.toString(),
        rejectUnauthorized: true,
        signal: AbortSignal.timeout(8_000),
        checkServerIdentity: (_name, certificate) =>
          checkServerIdentity("localhost", certificate) ??
          (certificate.fingerprint256 === fingerprint ? undefined : new Error("Unexpected local staff certificate")),
      }, (response) => {
        response.resume();
        resolve(response.statusCode === 204 && response.headers["x-nukhbapay-storage"] === "windows-postgresql-staff");
      });
      probe.once("error", () => resolve(false));
      probe.end();
    });
  } catch {
    return false;
  }
}

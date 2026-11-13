import { timingSafeEqual } from "node:crypto";

export const STAFF_COOKIE_OPTIONS = Object.freeze({ name: "__Host-nukhbapay_staff", secure: true, httpOnly: true, sameSite: "strict" as const, path: "/" });
const deny = () => Object.freeze({ transportValid: false, execution: "NOT_AUTHORIZED" as const });

/** Brick 3C local transport foundation only: never authenticates or creates a session. */
export function checkStaffBrowserTransport(input: {
  readonly expectedOrigin: string; readonly method: string; readonly rawHeaders: readonly string[];
  readonly expectedCsrf: string;
}) {
  try {
    const origin = new URL(input.expectedOrigin);
    if (origin.protocol !== "https:" || origin.origin !== input.expectedOrigin || !origin.hostname.endsWith(".invalid")) return deny();
    if (!Array.isArray(input.rawHeaders) || input.rawHeaders.length > 200 || input.rawHeaders.length % 2 !== 0) return deny();
    const headers = new Map<string,string>();
    for(let i=0;i<input.rawHeaders.length;i+=2){
      const name=input.rawHeaders[i]!.toLowerCase(), value=input.rawHeaders[i+1]!;
      if(typeof value!=="string" || value.length>8192) return deny();
      if(["origin","x-csrf-token","content-type","sec-fetch-site"].includes(name)){
        if(headers.has(name)) return deny(); headers.set(name,value);
      }
    }
    if(headers.get("sec-fetch-site")!==undefined && headers.get("sec-fetch-site")!=="same-origin") return deny();
    if(!["GET","HEAD","POST","PUT","PATCH","DELETE"].includes(input.method)) return deny();
    if(!["GET","HEAD"].includes(input.method)){
      if(headers.get("origin")!==input.expectedOrigin || headers.get("content-type")?.split(";")[0]?.trim()!=="application/json") return deny();
      const token=headers.get("x-csrf-token");
      if(!token || !/^[A-Za-z0-9_-]{32,128}$/.test(token) || !/^[A-Za-z0-9_-]{32,128}$/.test(input.expectedCsrf)) return deny();
      const actual=Buffer.from(token), expected=Buffer.from(input.expectedCsrf);
      if(actual.length!==expected.length || !timingSafeEqual(actual,expected)) return deny();
    } else if(headers.has("origin") && headers.get("origin")!==input.expectedOrigin) return deny();
    return Object.freeze({transportValid:true,execution:"NOT_AUTHORIZED" as const});
  }catch{return deny();}
}

/** Trusted server-side metadata only; an acceptable lifetime grants no identity/permission. */
export function staffSessionLifetimeUsable(record: {createdAtMs:number;lastSeenAtMs:number;revoked:boolean}, nowMs:number):boolean {
  return [record.createdAtMs,record.lastSeenAtMs,nowMs].every(n=>Number.isSafeInteger(n)&&n>=0) && !record.revoked &&
    record.createdAtMs<=record.lastSeenAtMs && record.lastSeenAtMs<=nowMs && nowMs-record.createdAtMs<8*60*60*1000 && nowMs-record.lastSeenAtMs<15*60*1000;
}

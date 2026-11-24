import { spawn } from "node:child_process";
import path from "node:path";
import { AiJobError, validateAiEngineResult, type AiEngine, type AiEngineInput } from "@nukhbapay/application";

/** Trusted local executable/repository configuration, never taken from a job. */
export class MockPythonAiEngine implements AiEngine {
  constructor(private readonly config: { repositoryRoot: string; pythonExecutable: string; mockScenario?: "normal" | "primary_failure" | "primary_timeout" | "invalid_primary_output" | "all_failure" | "first_two_failure" | "worker_timeout" | "worker_crash" | "malicious_output" | "publish_output" }) {
    if (!path.isAbsolute(config.repositoryRoot) || !path.isAbsolute(config.pythonExecutable) ||
      config.mockScenario !== undefined && !["normal", "primary_failure", "primary_timeout", "invalid_primary_output", "all_failure", "first_two_failure", "worker_timeout", "worker_crash", "malicious_output", "publish_output"].includes(config.mockScenario)) throw new AiJobError(503);
  }
  async run(input: AiEngineInput, signal: AbortSignal) {
    if (signal.aborted) throw new AiJobError(503);
    const payload = JSON.stringify(input);
    if (Buffer.byteLength(payload) > 32768) throw new AiJobError(503);
    return new Promise<ReturnType<typeof validateAiEngineResult>>((resolve, reject) => {
      // Minimal environment: no inherited database, model, payment or Auth0 credentials.
      const env: NodeJS.ProcessEnv = { PYTHONPATH: path.join(this.config.repositoryRoot, "apps/ai-service/src"),
        PYTHONUTF8: "1", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" };
      for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key];
      const child = spawn(this.config.pythonExecutable, ["-S", "-m", "nukhbapay_ai.jobs.stdio_worker",
        ...(this.config.mockScenario ? ["--mock-scenario", this.config.mockScenario] : [])], {
        cwd: this.config.repositoryRoot, env, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "", size = 0, done = false, stopping = false;
      // Cancellation requests termination; it does not acknowledge it. Resolve
      // or reject only after close joins this process and its stdio. The native
      // owner remains the hard bound for an uncooperative process/blocked loop.
      const fail = () => { if (done || stopping) return; stopping = true; child.kill(); clearTimeout(timer); signal.removeEventListener("abort", fail); };
      const timer = setTimeout(fail, 4000);
      signal.addEventListener("abort", fail, { once: true });
      child.on("error", fail); child.stdin.on("error", fail);
      child.stdout.on("data", (chunk: Buffer) => { if(stopping)return;size += chunk.length; if (size > 16384) fail(); else output += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { if(stopping)return;size += chunk.length; if (size > 16384) fail(); });
      child.once("close", code => {
        if (done) return;
        done = true; clearTimeout(timer); signal.removeEventListener("abort", fail);
        if (stopping || code !== 0 || signal.aborted) { reject(new AiJobError(503)); return; }
        try { resolve(validateAiEngineResult(JSON.parse(output), input)); }
        catch { reject(new AiJobError(503)); }
      });
      child.stdin.end(payload);
    });
  }
}

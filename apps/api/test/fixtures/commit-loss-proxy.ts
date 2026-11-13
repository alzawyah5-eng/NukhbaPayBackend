import { createConnection, createServer, type Socket } from "node:net";

/** Test-only, bounded loopback wire fault injector. Never records protocol payloads. */
export async function commitLossProxy(target: URL) {
  if (target.hostname !== "127.0.0.1" || !/^\/nukhabapay_b3b3_[0-9a-f]{32}$/.test(target.pathname)) {
    throw new Error("Unverified proxy target");
  }
  const sockets = new Set<Socket>();
  let mode: "before-forward" | "before-ack" | undefined;
  let remainingCommits = 1;
  let cut = false;
  const server = createServer(front => {
    const back = createConnection({ host: "127.0.0.1", port: Number(target.port || 5432) });
    for (const socket of [front, back]) {
      sockets.add(socket);
      socket.on("error", () => { front.destroy(); back.destroy(); });
      socket.on("close", () => { sockets.delete(socket); front.destroy(); back.destroy(); });
      socket.setTimeout(10000, () => { front.destroy(); back.destroy(); });
    }
    let startup = true, waitingCommit = false;
    let incoming: Buffer<ArrayBufferLike> = Buffer.alloc(0), outgoing: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    front.on("data", chunk => {
      incoming = Buffer.concat([incoming, chunk]);
      if (incoming.length > 1024 * 1024) { front.destroy(); back.destroy(); return; }
      while (incoming.length >= (startup ? 4 : 5)) {
        const size = incoming.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
        if (size < (startup ? 8 : 5) || size > 1024 * 1024) { front.destroy(); back.destroy(); return; }
        if (incoming.length < size) return;
        const packet = incoming.subarray(0, size); incoming = incoming.subarray(size);
        const commit = !startup && packet[0] === 81 && packet.subarray(5).toString() === "COMMIT\0";
        const selectedCommit = commit && mode !== undefined && --remainingCommits === 0;
        startup = false;
        if (selectedCommit && mode === "before-forward") { cut = true; front.destroy(); back.destroy(); return; }
        if (selectedCommit && mode === "before-ack") waitingCommit = true;
        back.write(packet);
      }
    });
    back.on("data", chunk => {
      outgoing = Buffer.concat([outgoing, chunk]);
      if (outgoing.length > 1024 * 1024) { front.destroy(); back.destroy(); return; }
      while (outgoing.length >= 5) {
        const size = outgoing.readInt32BE(1) + 1;
        if (size < 5 || size > 1024 * 1024) { front.destroy(); back.destroy(); return; }
        if (outgoing.length < size) return;
        const packet = outgoing.subarray(0, size); outgoing = outgoing.subarray(size);
        if (waitingCommit && packet[0] === 67 && packet.subarray(5).toString() === "COMMIT\0") {
          cut = true; front.destroy(); back.destroy(); return;
        }
        front.write(packet);
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Proxy listener unavailable");
  const url = new URL(target); url.port = String(address.port); url.searchParams.set("sslmode", "disable");
  return {
    url: url.href,
    arm(value: "before-forward" | "before-ack", commitOrdinal = 1) {
      if (!Number.isInteger(commitOrdinal) || commitOrdinal < 1 || commitOrdinal > 10) throw new Error("Invalid synthetic fault boundary");
      mode = value; remainingCommits = commitOrdinal;
    },
    get cut() { return cut; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

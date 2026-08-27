//! Public library surface, mirroring `src/lib.rs`.
//!
//! ```js
//! import { Client, Server } from "bore-cli-js";
//!
//! const server = new Server(1024, 65535, null);
//! void server.listen();
//!
//! const client = await Client.create("localhost", 3000, "localhost", 0, null);
//! console.log(client.remotePort);
//! await client.listen();
//! ```

import { isEntryPoint, main } from "./main.ts";

export { Authenticator, uuidToBytes } from "./auth.ts";
export { Client } from "./client.ts";
export { BindError, Server } from "./server.ts";
export * from "./shared.ts";
export { event, logger, parseFilter, reloadFilter, withSpan, type Level } from "./logger.ts";
export { parseArgs, CliExit, type Command } from "./cli.ts";
export { run } from "./run.ts";
export { isEntryPoint, main } from "./main.ts";

if (isEntryPoint(import.meta.url)) await main();

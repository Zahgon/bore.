//! Subcommand dispatch, split out of `main.ts` so that importing the library
//! never executes the CLI. Ported from `fn run(command: Command)` in
//! `src/main.rs`.

import { Client } from "./client.ts";
import { rootValueError, type Command } from "./cli.ts";
import { Server } from "./server.ts";

/// Runs the parsed subcommand. Neither branch resolves in practice: the process
/// is expected to be interrupted.
export async function run(command: Command): Promise<void> {
  switch (command.kind) {
    case "local": {
      const client = await Client.create(
        command.localHost,
        command.localPort,
        command.to,
        command.port,
        command.secret,
      );
      await client.listen();
      return;
    }
    case "server": {
      if (command.minPort > command.maxPort) {
        throw rootValueError("port range is empty");
      }
      const server = new Server(command.minPort, command.maxPort, command.secret);
      server.setBindAddr(command.bindAddr);
      server.setBindTunnels(command.bindTunnels ?? command.bindAddr);
      await server.listen();
      return;
    }
  }
}

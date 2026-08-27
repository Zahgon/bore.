# bore

A modern, simple TCP tunnel in JavaScript that exposes local ports to a remote server, bypassing standard NAT connection firewalls. **That's all it does: no more, and no less.**

This is a complete, wire-compatible port of [`ekzhang/bore`](https://github.com/ekzhang/bore) (v0.6.0) from Rust to TypeScript/Node.js. A `bore-js` client can tunnel through an upstream Rust `bore` server, and a Rust `bore` client can tunnel through a `bore-js` server — the two are interchangeable on both the wire and the command line. See [`docs/MIGRATION.md`](docs/MIGRATION.md) for the full equivalence report.

```shell
# Installation (requires Node.js >= 22.18)
npm install -g bore-cli-js

# On your local machine
bore local 8000 --to bore.pub
```

This will expose your local port at `localhost:8000` to the public internet at `bore.pub:<PORT>`, where the port number is assigned randomly.

Similar to [localtunnel](https://github.com/localtunnel/localtunnel) and [ngrok](https://ngrok.io/), except `bore` is intended to be a highly efficient, unopinionated tool for forwarding TCP traffic that is simple to install and easy to self-host, with no frills attached.

## Installation

### npm

```shell
npm install -g bore-cli-js
```

This installs the `bore` executable on your `PATH`. You can also run it without installing:

```shell
npx bore-cli-js local 8000 --to bore.pub
```

### From source

```shell
git clone <this repository>
cd bore-js
npm ci
npm run build
node dist/main.js --help
```

### Docker

```shell
docker build -t bore-js .
docker run -it --init --rm --network host bore-js <ARGS>
```

Unlike the Rust image, which ships a statically-linked binary in a `scratch` container, this image is based on `node:22-alpine` because a Node program needs its runtime. It still drops to the same unprivileged `USER 1000:1000`.

## Detailed Usage

This section describes detailed usage for the `bore` CLI command.

### Local Forwarding

You can forward a port on your local machine by using the `bore local` command. This takes a positional argument, the local port to forward, as well as a mandatory `--to` option, which specifies the address of the remote server.

```shell
bore local 5000 --to bore.pub
```

You can optionally pass in a `--port` option to pick a specific port on the remote to expose, although the command will fail if this port is not available. Also, passing `--local-host` allows you to expose a different host on your local area network besides the loopback address `localhost`.

The full options are shown below.

```shell
Starts a local proxy to the remote server

Usage: bore local [OPTIONS] --to <TO> <LOCAL_PORT>

Arguments:
  <LOCAL_PORT>  The local port to expose [env: BORE_LOCAL_PORT=]

Options:
  -l, --local-host <HOST>  The local host to expose [default: localhost]
  -t, --to <TO>            Address of the remote server to expose local ports to [env: BORE_SERVER=]
  -p, --port <PORT>        Optional port on the remote server to select [default: 0]
  -s, --secret <SECRET>    Optional secret for authentication [env: BORE_SECRET]
  -h, --help               Print help
```

### Self-Hosting

As mentioned in the startup instructions, there is a public instance of the `bore` server running at `bore.pub`. However, if you want to self-host `bore` on your own network, you can do so with the following command:

```shell
bore server
```

That's all it takes! After the server starts running at a given address, you can then update the `bore local` command with option `--to <ADDRESS>` to forward a local port to this remote server.

It's possible to specify different IP addresses for the control server and for the tunnels. This setup is useful for cases where you might want the control server to be on a private network while allowing tunnel connections over a public interface, or vice versa.

The full options for the `bore server` command are shown below.

```shell
Runs the remote proxy server

Usage: bore server [OPTIONS]

Options:
      --min-port <MIN_PORT>          Minimum accepted TCP port number [env: BORE_MIN_PORT=] [default: 1024]
      --max-port <MAX_PORT>          Maximum accepted TCP port number [env: BORE_MAX_PORT=] [default: 65535]
  -s, --secret <SECRET>              Optional secret for authentication [env: BORE_SECRET]
      --bind-addr <BIND_ADDR>        IP address to bind to, clients must reach this [default: 0.0.0.0]
      --bind-tunnels <BIND_TUNNELS>  IP address where tunnels will listen on, defaults to --bind-addr
  -h, --help                         Print help
```

### Logging

Logging is controlled by the `RUST_LOG` environment variable, using the same syntax and defaults as the Rust build (`tracing_subscriber`'s `Targets` filter, without `env-filter`). Logs are written to standard output.

```shell
RUST_LOG=bore_cli=debug bore server
RUST_LOG=trace bore local 8000 --to localhost
NO_COLOR=1 bore server          # disable ANSI styling
```

## Protocol

There is an implicit _control port_ at `7835`, used for creating new connections on demand. At initialization, the client sends a "Hello" message to the server on the TCP control port, asking to proxy a selected remote port. The server then responds with an acknowledgement and begins listening for external TCP connections.

Whenever the server obtains a connection on the remote port, it generates a secure [UUID](https://en.wikipedia.org/wiki/Universally_unique_identifier) for that connection and sends it back to the client. The client then opens a separate TCP stream to the server and sends an "Accept" message containing the UUID on that stream. The server then proxies the two connections between each other.

For correctness reasons and to avoid memory leaks, incoming connections are only stored by the server for up to 10 seconds before being discarded if the client does not accept them.

Messages are newline-free JSON objects in serde's externally tagged representation, terminated by a single `NUL` (`0x00`) byte, with a maximum frame length of 256 bytes:

```
{"Hello":8000}\0        {"Challenge":"<uuid>"}\0    "Heartbeat"\0
{"Accept":"<uuid>"}\0   {"Connection":"<uuid>"}\0   {"Error":"..."}\0
{"Authenticate":"<hex>"}\0
```

## Authentication

On a custom deployment of `bore server`, you can optionally require a _secret_ to prevent the server from being used by others. The protocol requires clients to verify possession of the secret on each TCP connection by answering random challenges in the form of HMAC codes. (This secret is only used for the initial handshake, and no further traffic is encrypted by default.)

```shell
# on the server
bore server --secret my_secret_string

# on the client
bore local <LOCAL_PORT> --to <TO> --secret my_secret_string
```

If a secret is not present in the arguments, `bore` will also attempt to read from the `BORE_SECRET` environment variable.

The challenge response is `HMAC-SHA256(key = SHA256(secret), message = <the challenge UUID's 16 raw bytes>)`, lowercase hex encoded — byte-for-byte identical to the Rust implementation.

## Library Usage

The package also ships as an ES module with TypeScript declarations.

```ts
import { Client, Server } from "bore-cli-js";

const server = new Server(1024, 65535, "my secret");
server.setBindAddr("0.0.0.0");
void server.listen();

const client = await Client.create("localhost", 8000, "example.com", 0, "my secret");
console.log(client.remotePort);
await client.listen();
```

## Development

```shell
npm ci
npm run typecheck
npm test            # 178 tests: unit, end-to-end, CLI parity, and Rust interop
```

The test files import the TypeScript sources directly and run under Node's native type stripping, so `node --test "test/*.test.ts"` works without a build step (Node >= 22.18). `npm test` builds first only because the interop suite needs the compiled `dist/main.js` to spawn.

The interop suite drives a real Rust `bore` binary and is skipped automatically when one is not available. Point it at a binary with `BORE_RUST_BIN=/path/to/bore npm run test:interop`.

## Acknowledgements

Original `bore` created by Eric Zhang ([@ekzhang1](https://twitter.com/ekzhang1)). Licensed under the [MIT license](LICENSE).

This port preserves the original's design and protocol exactly; the author of the original would like to thank the contributors and maintainers of the [Tokio](https://tokio.rs/) project, whose primitives the Node.js `stream` and `net` code here stands in for.

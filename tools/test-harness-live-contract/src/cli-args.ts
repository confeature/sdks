// SPDX-License-Identifier: MIT

/** Argument parsing for the live-contract-harness CLI — importable and tested
 *  without spawning the CLI (tests/cli-args.test.ts). */

export const USAGE = `\
Usage: live-contract-harness [options]

Options:
  --seed <path>           Path to a seed JSON file (relative or absolute)
  --corpus-seed           Seed every wire-case that has a seed, keyed by case id
                          (exclusive with --seed)
  --port <n>              Bind port (default: 0 — OS-assigned)
  --bind <addr>           Bind address (default: 127.0.0.1; only loopback supported in v1)
  --shutdown-grace <ms>   Max ms for graceful teardown (default: 5000)
  --help                  Print this message and exit 0
  --version               Print version and exit 0
  --exec -- <cmd…>        Boot, run <cmd> with CONFEATURE_LIVE=1 and
                          LIVE_HARNESS_URL set, exit with its code, stop
`;

export type ParsedArgs = {
  seed?: string;
  corpusSeed?: boolean;
  exec?: string[];
  port: number;
  bind: "127.0.0.1";
  shutdownGrace: number;
  showHelp?: boolean;
  showVersion?: boolean;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    port: 0,
    bind: "127.0.0.1",
    shutdownGrace: 5_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--help":
      case "-h":
        out.showHelp = true;
        break;
      case "--version":
      case "-v":
        out.showVersion = true;
        break;
      case "--seed":
        out.seed = argv[++i];
        if (!out.seed) throw new BadArgs(`missing value for --seed`);
        break;
      case "--corpus-seed":
        out.corpusSeed = true;
        break;
      case "--exec": {
        if (argv[i + 1] !== "--") throw new BadArgs(`--exec must be followed by -- <cmd…>`);
        out.exec = argv.slice(i + 2);
        if (out.exec.length === 0) throw new BadArgs(`--exec -- needs a command`);
        i = argv.length;
        break;
      }
      case "--port": {
        const v = argv[++i];
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 65535) {
          throw new BadArgs(`--port must be an integer 0..65535 (got ${v})`);
        }
        out.port = n;
        break;
      }
      case "--bind": {
        const v = argv[++i];
        if (v !== "127.0.0.1") {
          throw new BadArgs(`--bind must be 127.0.0.1 in v1 (got ${v})`);
        }
        out.bind = "127.0.0.1";
        break;
      }
      case "--shutdown-grace": {
        const v = argv[++i];
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0) {
          throw new BadArgs(`--shutdown-grace must be a positive integer (got ${v})`);
        }
        out.shutdownGrace = n;
        break;
      }
      default:
        throw new BadArgs(`unknown argument: ${a}`);
    }
  }
  if (out.seed !== undefined && out.corpusSeed) {
    throw new BadArgs(`--seed and --corpus-seed are mutually exclusive`);
  }
  return out;
}

export class BadArgs extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "BadArgs";
  }
}

import { constants as osConstants } from "node:os";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { dirname, join } from "node:path";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import type { ProcessResult } from "./process";

const DEFAULT_COLUMNS = 120;
const DEFAULT_ROWS = 36;
const MAX_INPUT = 16_384;
const MAX_SCROLLBACK = 2_000;

export interface TerminalEndpoint {
  port: number;
  token: string;
  columns: number;
  rows: number;
}

interface SocketData {
  id: number;
}

type Socket = Bun.ServerWebSocket<SocketData>;

function validGeometry(columns: number, rows: number): boolean {
  return Number.isInteger(columns) && columns >= 40 && columns <= 300 &&
    Number.isInteger(rows) && rows >= 10 && rows <= 100;
}

function safeToken(expected: string, supplied: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  // Always perform one constant-time comparison, including malformed lengths.
  return timingSafeEqual(left, right.length === left.length ? right : Buffer.alloc(left.length)) && right.length === left.length;
}

function hostIsLoopback(host: string | null, port: number): boolean {
  if (!host) return false;
  const normalized = host.toLowerCase();
  return normalized === `127.0.0.1:${port}` || normalized === `localhost:${port}` || normalized === `[::1]:${port}`;
}

async function writePrivateJSON(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function openLog(path: string): Promise<WriteStream> {
  await mkdir(dirname(path), { recursive: true });
  const stream = createWriteStream(path, { flags: "a", mode: 0o600 });
  await Promise.race([
    once(stream, "open"),
    once(stream, "error").then(([error]) => Promise.reject(error)),
  ]);
  return stream;
}

async function capture(command: string[]): Promise<string> {
  const process = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(process.stdout).text();
  return await process.exited === 0 ? text : "";
}

async function descendants(pid: number): Promise<number[]> {
  const rows = (await capture(["ps", "-axo", "pid=,ppid="])).split("\n")
    .map(line => line.trim().split(/\s+/).map(Number));
  const result: number[] = [];
  const visit = (parent: number) => {
    for (const [child, ppid] of rows) {
      if (Number.isInteger(child) && ppid === parent && child !== parent) {
        visit(child!);
        result.push(child!);
      }
    }
  };
  visit(pid);
  return result;
}

function signalName(signal: number | null): string | null {
  if (signal === null) return null;
  for (const [name, number] of Object.entries(osConstants.signals)) if (number === signal) return name;
  return String(signal);
}

/** Read and validate the private endpoint advertised by a live terminal supervisor. */
export async function readTerminalEndpoint(directory: string): Promise<TerminalEndpoint | null> {
  try {
    const value: unknown = JSON.parse(await readFile(join(directory, "terminal.json"), "utf8"));
    if (!value || typeof value !== "object") return null;
    const endpoint = value as Record<string, unknown>;
    if (!Number.isInteger(endpoint.port) || (endpoint.port as number) < 1 || (endpoint.port as number) > 65_535 ||
      typeof endpoint.token !== "string" || !/^[a-f0-9]{64}$/.test(endpoint.token) ||
      typeof endpoint.columns !== "number" || typeof endpoint.rows !== "number" ||
      !validGeometry(endpoint.columns, endpoint.rows)) return null;
    return endpoint as unknown as TerminalEndpoint;
  } catch {
    return null;
  }
}

/** Run a command in a native PTY retained by this supervisor process. */
export async function runTerminalProcess(command: string[], options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  directory: string;
  cancelFile?: string;
  timeoutMs?: number;
  onStart?: (pid: number) => Promise<void>;
  columns?: number;
  rows?: number;
}): Promise<ProcessResult> {
  if (!command.length || !command[0]) throw new Error("Terminal command must not be empty");
  const initialColumns = options.columns ?? DEFAULT_COLUMNS;
  const initialRows = options.rows ?? DEFAULT_ROWS;
  if (!validGeometry(initialColumns, initialRows)) throw new Error("Terminal geometry must be 40..300 columns and 10..100 rows");
  if (options.cancelFile && await access(options.cancelFile).then(() => true, () => false)) {
    return { exitCode: null, signal: null, cancelled: true, timedOut: false };
  }

  await mkdir(options.directory, { recursive: true });
  const log = await openLog(join(options.directory, "logs/terminal.log"));
  const logFinished = finished(log);
  logFinished.catch(() => {});
  // Opt-in lossless, timed PTY capture for replaying the actual native TUI.
  const cast = options.env?.TASKGROUND_CAPTURE_TUI === "1"
    ? await openLog(join(options.directory, "terminal.cast")) : undefined;
  const castFinished = cast ? finished(cast) : Promise.resolve();
  castFinished.catch(() => {});
  const captureStart = Date.now();
  cast?.write(JSON.stringify({ version: 2, width: initialColumns, height: initialRows,
    timestamp: captureStart / 1000, env: { TERM: "xterm-256color" } }) + "\n");
  const captureEvent = (kind: string, data: string) => {
    if (cast) cast.write(JSON.stringify([(Date.now() - captureStart) / 1000, kind, data]) + "\n");
  };

  const screen = new HeadlessTerminal({ cols: initialColumns, rows: initialRows, scrollback: MAX_SCROLLBACK, allowProposedApi: true });
  const serializer = new SerializeAddon();
  screen.loadAddon(serializer);
  let screenColumns = initialColumns;
  let screenRows = initialRows;
  let screenWrites = Promise.resolve();
  let endpointWrites = Promise.resolve();
  let queuedBytes = 0;
  let lastAlternateScreen: { data: string; cols: number; rows: number } | undefined;
  let terminal: Bun.Terminal | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let server: Bun.Server<SocketData> | undefined;
  let controller: Socket | undefined;
  let nextSocketId = 1;
  const clients = new Set<Socket>();
  const decoder = new TextDecoder();
  const token = randomBytes(32).toString("hex");
  let cancelled = false;
  let timedOut = false;
  let stopping: Promise<void> | undefined;
  let outputError: Error | undefined;
  let rejectOutput!: (error: Error) => void;
  const outputFailure = new Promise<never>((_, reject) => { rejectOutput = reject; });
  outputFailure.catch(() => {});
  let resolvePtyClosed!: () => void;
  const ptyClosed = new Promise<void>(resolve => { resolvePtyClosed = resolve; });

  // Native TUIs query their terminal even when no browser is watching.
  screen.onData(data => { if (terminal && !terminal.closed) terminal.write(data); });
  screen.parser.registerCsiHandler({ prefix: "?", final: "l" }, params => {
    if (screen.buffer.active.type === "alternate" && params.some(value => value === 47 || value === 1047 || value === 1049)) {
      lastAlternateScreen = { data: serializer.serialize({ scrollback: MAX_SCROLLBACK }), cols: screenColumns, rows: screenRows };
    }
    return false;
  });

  const send = (socket: Socket, message: unknown): boolean => {
    if (socket.readyState !== WebSocket.OPEN) return false;
    const status = socket.send(JSON.stringify(message));
    if (status <= 0) {
      const droppedController = controller === socket;
      if (controller === socket) controller = undefined;
      clients.delete(socket);
      socket.close(1013, "terminal client too slow");
      if (droppedController) queueMicrotask(controls);
      return droppedController;
    }
    return false;
  };
  const controls = () => {
    for (const socket of clients) send(socket, {
      type: "control",
      attached: controller === socket,
      available: !controller || controller === socket,
    });
  };
  const broadcast = (message: unknown) => {
    for (const socket of [...clients]) send(socket, message);
  };
  const snapshot = () => ({ type: "snapshot", data: serializer.serialize({ scrollback: MAX_SCROLLBACK }), cols: screenColumns, rows: screenRows });
  const queueScreenWrite = (bytes: Uint8Array, text: string) => {
    queuedBytes += bytes.byteLength;
    if (queuedBytes > 16 * 1024 * 1024) { failOutput(new Error("Terminal output exceeded the screen buffer limit")); queuedBytes -= bytes.byteLength; return; }
    screenWrites = screenWrites.then(() => new Promise<void>(resolve => {
      screen.write(bytes, () => {
        try { if (text) broadcast({ type: "output", data: text }); }
        finally { queuedBytes -= bytes.byteLength; resolve(); }
      });
    })).catch(failOutput);
  };
  const failOutput = (error: unknown) => {
    if (outputError) return;
    outputError = error instanceof Error ? error : new Error(`Terminal output failed: ${String(error)}`);
    rejectOutput(outputError);
    void stop();
  };
  const stop = () => {
    cancelled = !timedOut;
    if (!child?.pid || stopping) return stopping ?? Promise.resolve();
    const pid = child.pid;
    stopping = (async () => {
      const pids = [...await descendants(pid), pid];
      for (const target of pids) { try { process.kill(target, "SIGTERM"); } catch {} }
      await new Promise(resolve => setTimeout(resolve, 750));
      for (const target of pids) { try { process.kill(target, "SIGKILL"); } catch {} }
    })();
    return stopping;
  };

  log.once("error", failOutput);
  cast?.once("error", failOutput);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; void stop(); }, options.timeoutMs) : undefined;
  const poll = options.cancelFile ? setInterval(() => { void access(options.cancelFile!).then(stop, () => {}); }, 250) : undefined;

  try {
    server = Bun.serve<SocketData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        if (!bunServer.port || !hostIsLoopback(request.headers.get("host"), bunServer.port)) return new Response("Forbidden", { status: 403 });
        const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map(value => value.trim());
        if (protocols.length !== 2 || protocols[0] !== "taskground" || !safeToken(token, protocols[1] ?? "")) {
          return new Response("Unauthorized", { status: 401 });
        }
        const upgraded = bunServer.upgrade(request, {
          data: { id: nextSocketId++ },
          headers: { "Sec-WebSocket-Protocol": "taskground" },
        });
        return upgraded ? undefined : new Response("Upgrade failed", { status: 400 });
      },
      websocket: {
        data: {} as SocketData,
        maxPayloadLength: MAX_INPUT * 8,
        backpressureLimit: 256 * 1024,
        closeOnBackpressureLimit: true,
        open(socket) {
          // Join between parsed writes so a partially parsed chunk cannot appear
          // in both the initial snapshot and the next output frame.
          screenWrites = screenWrites.then(() => {
            if (socket.readyState !== WebSocket.OPEN) return;
            clients.add(socket);
            send(socket, snapshot());
            controls();
          }).catch(failOutput);
        },
        async message(socket, rawMessage) {
          let message: Record<string, unknown>;
          try {
            if (typeof rawMessage !== "string") throw new Error("Messages must be JSON text");
            message = JSON.parse(rawMessage);
            if (!message || typeof message !== "object" || typeof message.type !== "string") throw new Error("Invalid terminal message");
          } catch (error) {
            send(socket, { type: "error", message: error instanceof Error ? error.message : "Invalid terminal message" });
            return;
          }
          if (message.type === "attach") {
            if (controller && controller !== socket) send(socket, { type: "error", message: "Terminal control is already attached" });
            else { controller = socket; controls(); }
            return;
          }
          if (message.type === "detach") {
            if (controller === socket) { controller = undefined; controls(); }
            return;
          }
          if (message.type === "input") {
            if (controller !== socket) { send(socket, { type: "error", message: "Attach before sending terminal input" }); return; }
            if (typeof message.data !== "string" || message.data.length > MAX_INPUT) { send(socket, { type: "error", message: "Terminal input must be at most 16384 characters" }); return; }
            terminal?.write(message.data);
            return;
          }
          if (message.type === "resize") {
            if (controller !== socket) { send(socket, { type: "error", message: "Attach before resizing the terminal" }); return; }
            if (typeof message.cols !== "number" || typeof message.rows !== "number" || !validGeometry(message.cols, message.rows)) {
              send(socket, { type: "error", message: "Terminal size must be 40..300 columns and 10..100 rows" });
              return;
            }
            const columns = message.cols, rows = message.rows;
            captureEvent("r", `${columns}x${rows}`);
            terminal?.resize(columns, rows);
            screenWrites = screenWrites.then(() => {
              screen.resize(columns, rows);
              screenColumns = columns;
              screenRows = rows;
              broadcast(snapshot());
            });
            const resized = screenWrites.then(() => writePrivateJSON(join(options.directory, "terminal.json"), { port: server!.port, token, columns, rows }));
            endpointWrites = endpointWrites.then(() => resized);
            try { await endpointWrites; }
            catch (error) {
              send(socket, { type: "error", message: "Could not update terminal endpoint metadata" });
              failOutput(error);
            }
            return;
          }
          send(socket, { type: "error", message: "Unknown terminal message" });
        },
        close(socket) {
          clients.delete(socket);
          if (controller === socket) { controller = undefined; controls(); }
        },
      },
    });

    let resolveCompletion!: (value: { exitCode: number | null; signal: string | null }) => void;
    const completed = new Promise<{ exitCode: number | null; signal: string | null }>(resolve => { resolveCompletion = resolve; });
    const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), TERM: "xterm-256color", COLORTERM: "truecolor" };
    // Let native programs read current PTY dimensions after SIGWINCH.
    delete env.COLUMNS;
    delete env.LINES;
    child = Bun.spawn(command, {
      cwd: options.cwd,
      env,
      terminal: {
        cols: initialColumns,
        rows: initialRows,
        name: "xterm-256color",
        data(_terminal, bytes) {
          try {
            if (log.writableLength > 16 * 1024 * 1024) throw new Error("Terminal output exceeded the log buffer limit");
            log.write(bytes);
            const copy = Uint8Array.from(bytes);
            const text = decoder.decode(copy, { stream: true });
            captureEvent("o", text);
            queueScreenWrite(copy, text);
          } catch (error) {
            failOutput(error);
          }
        },
        // exitCode is PTY lifecycle status (0=EOF, 1=read error). On Linux, reading the
        // master after the last slave descriptor closes fails with EIO rather than EOF,
        // so a nonzero status is the normal hangup there, not lost output.
        exit() {
          resolvePtyClosed();
        },
      },
      onExit(_process, exitCode, signal) {
        resolveCompletion({ exitCode, signal: signalName(signal) });
      },
    });
    terminal = child.terminal;
    await writePrivateJSON(join(options.directory, "terminal.json"), {
      port: server.port,
      token,
      columns: initialColumns,
      rows: initialRows,
    });
    if (child.pid) await options.onStart?.(child.pid);
    const outcome = await Promise.race([completed, outputFailure]);
    await stopping;
    // A background descendant can retain the slave after the agent has exited.
    // Drain final bytes, but do not let it keep the run supervisor alive forever.
    await Promise.race([ptyClosed, Bun.sleep(1000)]);
    terminal?.close();
    const trailing = decoder.decode();
    if (trailing) queueScreenWrite(new Uint8Array(), trailing);
    await screenWrites;
    if (lastAlternateScreen) broadcast({ type: "snapshot", ...lastAlternateScreen });
    broadcast({ type: "exit", exitCode: outcome.exitCode });
    // Let uWebSockets flush the final output and exit frames before graceful close.
    await Bun.sleep(10);
    return { ...outcome, cancelled, timedOut };
  } catch (error) {
    broadcast({ type: "error", message: error instanceof Error ? error.message : String(error) });
    if (child?.pid && child.exitCode === null && child.signalCode === null) await stop();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (poll) clearInterval(poll);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    log.removeListener("error", failOutput);
    let persistenceError: unknown;
    try {
      const trailing = decoder.decode();
      if (trailing) queueScreenWrite(new Uint8Array(), trailing);
      await endpointWrites.catch(error => { persistenceError = error; });
      await screenWrites;
      const finalScreen = {
        data: serializer.serialize({ scrollback: MAX_SCROLLBACK }),
        cols: screenColumns,
        rows: screenRows,
      };
      await writePrivateJSON(join(options.directory, "terminal-screen.json"), lastAlternateScreen ?? finalScreen);
    } catch (error) { persistenceError ??= error; }
    for (const socket of clients) socket.close(1000, "terminal process finished");
    clients.clear();
    server?.stop(true);
    terminal?.close();
    serializer.dispose();
    screen.dispose();
    log.end();
    cast?.end();
    let logError: unknown;
    await logFinished.catch(error => { if (!outputError) logError = error; });
    await castFinished.catch(error => { if (!outputError) logError = error; });
    await unlink(join(options.directory, "terminal.json")).catch(() => {});
    if (logError) throw logError;
    if (persistenceError) throw persistenceError;
  }
}

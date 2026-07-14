import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getVersion } from '../lib/getVersion.js';
import { onSignals } from '../lib/onSignals.js';
import { serializeCorsOrigin } from '../lib/serializeCorsOrigin.js';
import { randomUUID } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { SessionAccessCounter } from '../lib/sessionAccessCounter.js';
/** How long to wait after SIGTERM before SIGKILLing a child's process group. */
const KILL_GRACE_MS = 5000;
export const DEFAULT_SESSION_IDLE_MS = 1800000; // 30 min with no request
export const DEFAULT_SESSION_MAX_AGE_MS = 43200000; // 12 h
export const DEFAULT_MAX_SESSIONS = 64;
export const DEFAULT_SWEEP_INTERVAL_MS = 60000; // 1 min
const setResponseHeaders = ({ res, headers, }) => Object.entries(headers).forEach(([key, value]) => {
    res.setHeader(key, value);
});
export async function stdioToStatefulStreamableHttp(args) {
    const { stdioCmd, port, streamableHttpPath, logger, corsOrigin, healthEndpoints, headers, sessionTimeout, sessionIdleMs = DEFAULT_SESSION_IDLE_MS, sessionMaxAgeMs = DEFAULT_SESSION_MAX_AGE_MS, maxSessions = DEFAULT_MAX_SESSIONS, sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS, } = args;
    logger.info(`  - Headers: ${Object(headers).length ? JSON.stringify(headers) : '(none)'}`);
    logger.info(`  - port: ${port}`);
    logger.info(`  - stdio: ${stdioCmd}`);
    logger.info(`  - streamableHttpPath: ${streamableHttpPath}`);
    logger.info(`  - CORS: ${corsOrigin ? `enabled (${serializeCorsOrigin({ corsOrigin })})` : 'disabled'}`);
    logger.info(`  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`);
    logger.info(`  - Session timeout: ${sessionTimeout ? `${sessionTimeout}ms` : 'disabled'}`);
    logger.info(`  - Session idle reap: ${sessionIdleMs}ms, max age: ${sessionMaxAgeMs}ms, max sessions: ${maxSessions}`);
    onSignals({ logger });
    const app = express();
    app.use(express.json());
    if (corsOrigin) {
        app.use(cors({
            origin: corsOrigin,
            exposedHeaders: ['Mcp-Session-Id'],
        }));
    }
    for (const ep of healthEndpoints) {
        app.get(ep, (_req, res) => {
            setResponseHeaders({
                res,
                headers,
            });
            res.send('ok');
        });
    }
    // Map to store transports by session ID
    const transports = {};
    // Per-session bookkeeping for the reaper: the child handle, plus a clock that
    // only real requests advance (see the sweep below for why that matters).
    const sessionMeta = new Map();
    /**
     * SIGTERM the child's entire process group, then SIGKILL whatever survives.
     *
     * `spawn(cmd, { shell: true })` makes the child a `/bin/sh -c ...` wrapper. When
     * sh cannot exec the command away (e.g. `npx foo` -> npm exec -> sh -> node), a
     * plain `child.kill()` signals only that outer shell and orphans the real MCP
     * server, which is then re-parented to init and never exits. Spawning detached
     * makes the child a process group leader so `-pid` reaches the whole chain.
     */
    const killTree = (child, sessionId) => {
        if (!child.pid || child.exitCode !== null)
            return;
        const pid = child.pid;
        try {
            process.kill(-pid, 'SIGTERM');
        }
        catch {
            // No process group (Windows, or an unusual environment): best effort.
            try {
                child.kill('SIGTERM');
            }
            catch {
                /* already gone */
            }
        }
        setTimeout(() => {
            try {
                process.kill(-pid, 'SIGKILL');
                logger.info(`SIGKILLed lingering child group for session ${sessionId}`);
            }
            catch {
                /* exited cleanly on SIGTERM, as expected */
            }
        }, KILL_GRACE_MS).unref();
    };
    const reap = (sessionId, reason) => {
        const meta = sessionMeta.get(sessionId);
        const transport = transports[sessionId];
        logger.info(`Reaping session ${sessionId}: ${reason}`);
        sessionMeta.delete(sessionId);
        delete transports[sessionId];
        sessionCounter?.clear(sessionId, false, `reaped (${reason})`);
        if (transport) {
            try {
                transport.close();
            }
            catch {
                /* already closed */
            }
        }
        if (meta)
            killTree(meta.child, sessionId);
    };
    // Session access counter for timeout management
    const sessionCounter = sessionTimeout
        ? new SessionAccessCounter(sessionTimeout, (sessionId) => {
            logger.info(`Session ${sessionId} timed out, cleaning up`);
            reap(sessionId, 'sessionTimeout');
        }, logger)
        : null;
    /**
     * The reaper.
     *
     * `sessionTimeout` alone cannot bound child processes: SessionAccessCounter only
     * arms its cleanup timer when the access count reaches exactly 0, and any new
     * access clears it again. A client holding an SSE stream reconnects every couple
     * of minutes -- inside any sane timeout -- so the timer is armed and disarmed
     * forever and the session never expires. (Observed in production over 7 days:
     * armed 5336 times, fired 34.) Each immortal session pins its own child process,
     * so they accumulate until the process hits its memory limit and is OOM-killed,
     * which clients see as a failure to attach.
     *
     * So idleness is measured against POST requests only. A GET is the client's SSE
     * stream reconnecting, which it does whether or not anyone is using the server;
     * counting that as activity is precisely what makes sessions immortal.
     */
    const sweep = setInterval(() => {
        const now = Date.now();
        for (const [sessionId, meta] of [...sessionMeta.entries()]) {
            const idle = now - meta.lastActivity;
            const age = now - meta.createdAt;
            if (idle > sessionIdleMs) {
                reap(sessionId, `idle ${Math.round(idle / 1000)}s with no request`);
            }
            else if (age > sessionMaxAgeMs) {
                reap(sessionId, `exceeded max age (${Math.round(age / 1000)}s)`);
            }
        }
        // Backstop: never let one misbehaving client fan out without bound.
        if (sessionMeta.size > maxSessions) {
            const excess = [...sessionMeta.entries()]
                .sort((a, b) => a[1].lastActivity - b[1].lastActivity)
                .slice(0, sessionMeta.size - maxSessions);
            for (const [sessionId] of excess) {
                reap(sessionId, `over max sessions (${sessionMeta.size}/${maxSessions})`);
            }
        }
    }, sweepIntervalMs);
    sweep.unref();
    // Handle POST requests for client-to-server communication
    app.post(streamableHttpPath, async (req, res) => {
        // Check for existing session ID
        const sessionId = req.headers['mcp-session-id'];
        let transport;
        if (sessionId && transports[sessionId]) {
            // Reuse existing transport
            transport = transports[sessionId];
            // A POST is real work, and is the only thing that keeps a session alive.
            const meta = sessionMeta.get(sessionId);
            if (meta)
                meta.lastActivity = Date.now();
            // Increment session access count
            sessionCounter?.inc(sessionId, 'POST request for existing session');
        }
        else if (!sessionId && isInitializeRequest(req.body)) {
            // New initialization request
            const server = new Server({ name: 'supergateway', version: getVersion() }, { capabilities: {} });
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sessionId) => {
                    // Store the transport by session ID
                    transports[sessionId] = transport;
                    sessionMeta.set(sessionId, {
                        child,
                        createdAt: Date.now(),
                        lastActivity: Date.now(),
                    });
                    // Initialize session access count
                    sessionCounter?.inc(sessionId, 'session initialization');
                },
            });
            await server.connect(transport);
            // detached: the child leads its own process group, so killTree can signal
            // the whole `sh -> npm -> node` chain rather than just the outer shell.
            const child = spawn(stdioCmd, { shell: true, detached: true });
            child.on('exit', (code, signal) => {
                logger.error(`Child exited: code=${code}, signal=${signal}`);
                transport.close();
            });
            let buffer = '';
            child.stdout.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
                const lines = buffer.split(/\r?\n/);
                buffer = lines.pop() ?? '';
                lines.forEach((line) => {
                    if (!line.trim())
                        return;
                    try {
                        const jsonMsg = JSON.parse(line);
                        logger.info('Child → StreamableHttp:', line);
                        try {
                            transport.send(jsonMsg);
                        }
                        catch (e) {
                            logger.error(`Failed to send to StreamableHttp`, e);
                        }
                    }
                    catch {
                        logger.error(`Child non-JSON: ${line}`);
                    }
                });
            });
            child.stderr.on('data', (chunk) => {
                logger.error(`Child stderr: ${chunk.toString('utf8')}`);
            });
            transport.onmessage = (msg) => {
                logger.info(`StreamableHttp → Child: ${JSON.stringify(msg)}`);
                child.stdin.write(JSON.stringify(msg) + '\n');
            };
            // NB: `sessionId` from the request headers is undefined on the initialize
            // path -- log transport.sessionId, which is the one that actually exists.
            transport.onclose = () => {
                logger.info(`StreamableHttp connection closed (session ${transport.sessionId})`);
                if (transport.sessionId) {
                    sessionCounter?.clear(transport.sessionId, false, 'transport being closed');
                    delete transports[transport.sessionId];
                    sessionMeta.delete(transport.sessionId);
                }
                killTree(child, transport.sessionId);
            };
            transport.onerror = (err) => {
                logger.error(`StreamableHttp error (session ${transport.sessionId}):`, err);
                if (transport.sessionId) {
                    sessionCounter?.clear(transport.sessionId, false, 'transport emitting error');
                    delete transports[transport.sessionId];
                    sessionMeta.delete(transport.sessionId);
                }
                killTree(child, transport.sessionId);
            };
        }
        else if (sessionId) {
            // The session is unknown -- expired, reaped, or from a previous process.
            // The Streamable HTTP spec uses 404 as the signal for "discard this session
            // id and initialize a new one"; a 400 leaves clients stuck, reporting a hard
            // connection failure instead of transparently reconnecting.
            res.status(404).json({
                jsonrpc: '2.0',
                error: {
                    code: -32001,
                    message: 'Session not found',
                },
                id: null,
            });
            return;
        }
        else {
            // Invalid request
            res.status(400).json({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message: 'Bad Request: No valid session ID provided',
                },
                id: null,
            });
            return;
        }
        // Decrement session access count when response ends
        let responseEnded = false;
        const handleResponseEnd = (event) => {
            if (!responseEnded && transport.sessionId) {
                responseEnded = true;
                logger.info(`Response ${event}`, transport.sessionId);
                sessionCounter?.dec(transport.sessionId, `POST response ${event}`);
            }
        };
        res.on('finish', () => handleResponseEnd('finished'));
        res.on('close', () => handleResponseEnd('closed'));
        // Handle the request
        await transport.handleRequest(req, res, req.body);
    });
    // Reusable handler for GET and DELETE requests
    const handleSessionRequest = async (req, res) => {
        const sessionId = req.headers['mcp-session-id'];
        if (!sessionId) {
            res.status(400).send('Invalid or missing session ID');
            return;
        }
        if (!transports[sessionId]) {
            res.status(404).send('Session not found');
            return;
        }
        // Deliberately does not touch lastActivity: a GET here is the client's SSE
        // stream reconnecting, which it does on a timer regardless of whether anyone
        // is using the server. Treating that as activity is what makes sessions
        // immortal and leaks their child processes.
        // Increment session access count
        sessionCounter?.inc(sessionId, `${req.method} request for existing session`);
        // Decrement session access count when response ends
        let responseEnded = false;
        const handleResponseEnd = (event) => {
            if (!responseEnded) {
                responseEnded = true;
                logger.info(`Response ${event}`, sessionId);
                sessionCounter?.dec(sessionId, `${req.method} response ${event}`);
            }
        };
        res.on('finish', () => handleResponseEnd('finished'));
        res.on('close', () => handleResponseEnd('closed'));
        const transport = transports[sessionId];
        await transport.handleRequest(req, res);
    };
    // Handle GET requests for server-to-client notifications via SSE
    app.get(streamableHttpPath, handleSessionRequest);
    // Handle DELETE requests for session termination
    app.delete(streamableHttpPath, handleSessionRequest);
    app.listen(port, () => {
        logger.info(`Listening on port ${port}`);
        logger.info(`StreamableHttp endpoint: http://localhost:${port}${streamableHttpPath}`);
    });
}

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
// --- ardencore patch: bounded sessions ---------------------------------------
// Upstream 3.4.3 leaks one child process per session. Two independent causes:
//
//  1. `--sessionTimeout` is not an idle timeout. SessionAccessCounter only arms
//     its cleanup timer when the access count hits exactly 0, and *any* new
//     access clears it again. An MCP client holding an SSE stream reconnects
//     every ~2 min, so the timer is armed and disarmed forever and the session
//     never expires. Observed: timer armed 5336x, fired 34x.
//
//  2. `spawn(cmd, {shell: true})` makes the child a `/bin/sh -c ...` wrapper.
//     For a command that is not exec'd away (e.g. `npx foo` -> npm exec -> sh ->
//     node) `child.kill()` SIGTERMs only the shell, orphaning the real server.
//
// Fix: reap on real request activity (POST), not SSE keepalive traffic (GET);
// kill the whole process group; and answer an unknown session id with 404 so
// clients re-initialize per the MCP spec instead of getting an opaque 400.
const IDLE_MS = Number(process.env.SUPERGATEWAY_SESSION_IDLE_MS ?? 1800000); // 30 min without a POST
const MAX_AGE_MS = Number(process.env.SUPERGATEWAY_SESSION_MAX_AGE_MS ?? 43200000); // 12 h absolute
const MAX_SESSIONS = Number(process.env.SUPERGATEWAY_MAX_SESSIONS ?? 8);
const SWEEP_MS = Number(process.env.SUPERGATEWAY_SWEEP_MS ?? 60000);
const setResponseHeaders = ({ res, headers, }) => Object.entries(headers).forEach(([key, value]) => {
    res.setHeader(key, value);
});
export async function stdioToStatefulStreamableHttp(args) {
    const { stdioCmd, port, streamableHttpPath, logger, corsOrigin, healthEndpoints, headers, sessionTimeout, } = args;
    logger.info(`  - Headers: ${Object(headers).length ? JSON.stringify(headers) : '(none)'}`);
    logger.info(`  - port: ${port}`);
    logger.info(`  - stdio: ${stdioCmd}`);
    logger.info(`  - streamableHttpPath: ${streamableHttpPath}`);
    logger.info(`  - CORS: ${corsOrigin ? `enabled (${serializeCorsOrigin({ corsOrigin })})` : 'disabled'}`);
    logger.info(`  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`);
    logger.info(`  - Session timeout: ${sessionTimeout ? `${sessionTimeout}ms` : 'disabled'}`);
    logger.info(`  - Session idle reap: ${IDLE_MS}ms, max age: ${MAX_AGE_MS}ms, max sessions: ${MAX_SESSIONS}`);
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
    // Per-session bookkeeping for the reaper: child handle + real-activity clock.
    const sessionMeta = new Map();
    // SIGTERM the child's whole process group, then SIGKILL anything still alive.
    // The child is a process group leader (spawned detached), so -pid hits every
    // process in the `sh -> npm -> node` chain rather than just the outer shell.
    const killTree = (child, sessionId) => {
        if (!child || child.exitCode !== null)
            return;
        try {
            process.kill(-child.pid, 'SIGTERM');
        }
        catch {
            try {
                child.kill('SIGTERM');
            }
            catch { }
        }
        setTimeout(() => {
            try {
                process.kill(-child.pid, 'SIGKILL');
                logger.info(`SIGKILLed lingering child group for ${sessionId}`);
            }
            catch { }
        }, 5000).unref();
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
            catch { }
        }
        if (meta?.child)
            killTree(meta.child, sessionId);
    };
    // Session access counter for timeout management
    const sessionCounter = sessionTimeout
        ? new SessionAccessCounter(sessionTimeout, (sessionId) => {
            logger.info(`Session ${sessionId} timed out, cleaning up`);
            reap(sessionId, 'sessionTimeout');
        }, logger)
        : null;
    // The actual reaper. Upstream's timer cannot fire while a client keeps an SSE
    // stream warm, so this sweep is what bounds child processes in practice.
    setInterval(() => {
        const now = Date.now();
        for (const [sid, meta] of [...sessionMeta.entries()]) {
            const idle = now - meta.lastActivity;
            const age = now - meta.createdAt;
            if (idle > IDLE_MS)
                reap(sid, `idle ${Math.round(idle / 1000)}s with no request`);
            else if (age > MAX_AGE_MS)
                reap(sid, `exceeded max age (${Math.round(age / 1000)}s)`);
        }
        if (sessionMeta.size > MAX_SESSIONS) {
            const stale = [...sessionMeta.entries()]
                .sort((a, b) => a[1].lastActivity - b[1].lastActivity)
                .slice(0, sessionMeta.size - MAX_SESSIONS);
            for (const [sid] of stale)
                reap(sid, `over max sessions (${sessionMeta.size}/${MAX_SESSIONS})`);
        }
    }, SWEEP_MS);
    // Handle POST requests for client-to-server communication
    app.post(streamableHttpPath, async (req, res) => {
        // Check for existing session ID
        const sessionId = req.headers['mcp-session-id'];
        let transport;
        if (sessionId && transports[sessionId]) {
            // Reuse existing transport
            transport = transports[sessionId];
            // A POST is real work: it, and only it, keeps the session alive.
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
            // detached: own process group, so killTree can signal the whole chain.
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
            // Session was reaped (or never existed). The MCP spec says a server
            // MUST answer 404 here so the client starts a fresh session; upstream
            // returned an opaque 400, which clients surface as a hard attach error.
            res.status(404).json({
                jsonrpc: '2.0',
                error: {
                    code: -32001,
                    message: 'Session not found or expired: start a new session',
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
        if (!sessionId || !transports[sessionId]) {
            res.status(404).send('Session not found or expired: start a new session');
            return;
        }
        // NB: deliberately does NOT touch lastActivity. A GET is the client's SSE
        // stream reconnecting, which it does every ~2 min whether or not anyone is
        // using the server; treating that as activity is what made sessions immortal.
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

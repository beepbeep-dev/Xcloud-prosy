// Credit Bubbo and Gemini (lol)
import "dotenv/config";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import os from "node:os";
import cluster from "node:cluster";
import { fileURLToPath } from "node:url";
import express from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import compression from "compression";
import basicAuth from "express-basic-auth";
import chalk from "chalk";
import rateLimit from "express-rate-limit";
import { SocksProxyAgent } from "socks-proxy-agent";
import { createBareServer } from "@tomphttp/bare-server-node";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";
import config from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isVercel = process.env.VERCEL === "1";

const app = express();

// --- EC2 VM CONFIGURATION ---
const EC2_BASE_URL = 'https://ec2-18-219-58-159.us-east-2.compute.amazonaws.com';
const EC2_HOST = 'ec2-18-219-58-159.us-east-2.compute.amazonaws.com';
const CREATE_VM_URL = `${EC2_BASE_URL}/api/create?developer_id=loremgroupusllc&site_limit=10&delete_after=60`;
const vmStore = new Map();

// --- MIDDLEWARE & CONFIG ---
app.set("trust proxy", 1); 

app.use(express.json({ limit: "10kb" }));
app.use(compression()); // Compress responses

app.use((req, res, next) => {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    next();
});

// --- RATE LIMITERS ---
const apiLimiter = rateLimit({
    windowMs: 5 * 1000, 
    max: 15, 
    message: { error: "Too many API requests." },
    validate: { trustProxy: false } 
});

const proxyLimiter = rateLimit({
    windowMs: 15 * 1000,
    max: 400,
    standardHeaders: true,
    legacyHeaders: false,
    message: "[inkshower] High traffic detected. Cooling down.",
    validate: { trustProxy: false }
});

// --- AGENTS & BARE SERVERS ---
const agentOptions = { keepAlive: true, maxSockets: Infinity };
const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(agentOptions);

const torAgent = new SocksProxyAgent(config.tor?.proxy || "socks5h://127.0.0.1:9050", { timeout: 10000 });
torAgent.keepAlive = false;

const bareServerDirect = createBareServer("/edu/", { httpAgent, httpsAgent });
const bareServerTor = createBareServer("/tor/", { agent: torAgent, httpAgent: torAgent, httpsAgent: torAgent });
const bareServers = [bareServerDirect, bareServerTor];

const checkTor = (req) => {
    const cookies = req.headers.cookie || "";
    return config.tor?.enabled === true || cookies.toLowerCase().includes("inkshower-tor-enabled=true");
};

// --- EC2 VM UTILS ---
async function checkEC2Health(vmUrl, maxRetries = 30, delayMs = 1000) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const r = await fetch(vmUrl, { method: 'HEAD', timeout: 5000 });
            if (r.status === 200) return { healthy: true, url: vmUrl };
            console.log(`Attempt ${i + 1}: Got status ${r.status}, retrying...`);
        } catch (t) {
            console.log(`Attempt ${i + 1}: Error - ${t.message}, retrying...`);
        }
        if (i < maxRetries - 1) await new Promise(r => setTimeout(r, delayMs));
    }
    return { healthy: false, url: vmUrl };
}

// --- API ROUTES ---

app.get("/check", (req, res) => res.status(200).send("OK"));

// Hyperbeam VM Proxy
app.get("/computer", apiLimiter, async (req, res) => {
    try {
        const response = await fetch("https://engine.hyperbeam.com/v0/vm", {
            method: "POST",
            headers: { Authorization: `Bearer ${process.env.HB_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({}),
        });
        
        res.status(response.status);
        res.setHeader("Content-Type", "application/json");
        
        const body = Readable.fromWeb(response.body);
        await pipeline(body, res); 
    } catch (error) {
        if (!res.headersSent) res.status(500).json({ error: "Hyperbeam unreachable" });
    }
});
app.get('/urlcheck', async (req, res) => {
    // Supports /check?url=site.com or /check?=site.com
    const url = req.query.url || req.query[''];
    
    if (!url) {
        return res.status(400).send('<h1>Missing URL</h1><p>Usage: /check?url=example.com</p>');
    }

    try {
        // Your server uses the secret token, the client never sees it
        const apiUrl = `https://live.glseries.net/api/v1/check?token=${process.env.GL_API_TOKEN}&url=${encodeURIComponent(url)}`;
        
        const response = await fetch(apiUrl, { 
            agent: httpsAgent, // Reusing your high-performance agent
            headers: { 'Accept': 'application/json' }
        });
        
        const data = await response.json();

        if (!data.success) {
            return res.status(500).send(`<h1>API Error</h1><p>${data.message || 'The check service is currently unavailable.'}</p>`);
        }

        // Efficiently build the table rows
        const rows = data.results.map(r => `
            <tr>
                <td><strong>${r.name}</strong></td>
                <td style="color: #9494a3; font-size: 13px;">${r.category}</td>
                <td><span class="status ${r.blocked ? 'blocked' : 'clear'}">${r.blocked ? 'BLOCKED' : 'UNBLOCKED'}</span></td>
                <td style="color: #9494a3; font-size: 13px;">${r.responseTime}ms</td>
            </tr>
        `).join('');

        res.setHeader('Content-Type', 'text/html');
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
            
                <style>
                    :root { --bg: #0a0a0d; --card: #12121a; --primary: #ff6b00; --text: #e1e1e6; --red: #ff5252; --green: #00ff88; }
                    body { font-family: 'Outfit', sans-serif; background: var(--bg); color: var(--text); padding: 40px; display: flex; justify-content: center; margin: 0; }
                    .container { width: 100%; max-width: 750px; }
                    .header { margin-bottom: 30px; border-left: 4px solid var(--primary); padding-left: 20px; }
                    h1 { margin: 0; font-size: 28px; }
                    .url-sub { color: #9494a3; font-family: monospace; }
                    table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 8px; overflow: hidden; }
                    th { text-align: left; padding: 15px; background: rgba(255,255,255,0.03); color: #9494a3; font-size: 12px; text-transform: uppercase; }
                    td { padding: 12px 15px; border-bottom: 1px solid rgba(255,255,255,0.02); }
                    .status { font-weight: 700; font-size: 10px; padding: 3px 8px; border-radius: 4px; }
                    .status.clear { background: rgba(0,255,136,0.1); color: var(--green); }
                    .status.blocked { background: rgba(255,82,82,0.1); color: var(--red); }
                    .usage { margin-top: 15px; text-align: right; font-size: 11px; color: #555; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h1>Xcheck</h1>
                        <div class="url-sub">${data.url}</div>
                    </div>
                    <table>
                        <thead>
                            <tr><th>Filter</th><th>Category</th><th>Status</th><th>Latency</th></tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </body>
            </html>
        `);
    } catch (err) {
        res.status(500).send("<h1>Check Failed</h1><p>Could not connect to the api.</p>");
    }
});
// Google Suggestions Proxy
app.get("/api/suggestions", apiLimiter, async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json([]);
    
    try {
        const response = await fetch(`https://suggestqueries.google.com/complete/search?client=chrome&q=${encodeURIComponent(query)}`);
        res.status(response.status);
        res.setHeader("Content-Type", "application/json");
        
        const body = Readable.fromWeb(response.body);
        await pipeline(body, res);
    } catch { 
        if (!res.headersSent) res.json([]); 
    }
});
// --- BLAZING FAST NATIVE PROXY ROUTE ---
app.use('/go', (req, res) => {
    // Supports both /go?url=https://... and /go?=https://...
    const targetUrl = req.query.url || req.query['']; 
    
    if (!targetUrl) {
        return res.status(400).type('text/plain').send('Missing target URL');
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(targetUrl);
    } catch {
        return res.status(400).type('text/plain').send('Invalid URL format');
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const requestMethod = isHttps ? https.request : http.request;
    
    // RE-USE EXISTING AGENTS: Your keepAlive agents prevent new TCP connections per request
    const agent = isHttps ? httpsAgent : httpAgent;

    const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: req.method,
        headers: {
            ...req.headers,
            host: parsedUrl.hostname, // Crucial: Rewrite the host header for the target
        },
        agent: agent,
    };

    // Strip headers that could cause proxy loops or conflicts
    delete options.headers['x-forwarded-for'];
    delete options.headers['x-forwarded-host'];
    delete options.headers['x-forwarded-proto'];

    const proxyReq = requestMethod(options, (proxyRes) => {
        res.status(proxyRes.statusCode);
        
        // Fast header forwarding
        for (const [key, value] of Object.entries(proxyRes.headers)) {
            // Strip transfer-encoding to prevent Express chunking conflicts
            if (key.toLowerCase() !== 'transfer-encoding') {
                res.setHeader(key, value);
            }
        }

        // DIRECT PIPE: Zero memory buffering. The data flows straight from target to client.
        proxyRes.pipe(res, { end: true });
    });

    // Handle connection errors instantly without taking down your cluster worker
    proxyReq.on('error', (err) => {
        if (!res.headersSent) {
            res.status(502).type('text/plain').send('Bad Gateway / Target Unreachable');
        }
    });

    // DIRECT PIPE: Send incoming client body (for POST/PUT) straight to the target
    req.pipe(proxyReq, { end: true });
});
// EC2 VM Creation
app.get('/api/vm', apiLimiter, async (req, res) => {
    try {
        console.log('Creating VM...');
        const premiumCode = req.query.premium || '';
        let apiUrl = CREATE_VM_URL;
        
        if (premiumCode) apiUrl += `&premium=${encodeURIComponent(premiumCode)}`;
        
        const response = await fetch(apiUrl, { method: 'GET', headers: { Accept: 'application/json' } });
        if (!response.ok) {
            const text = await response.text();
            return res.status(response.status).json({ error: 'Failed to create VM', details: text });
        }
        
        const vmData = await response.json();
        console.log('VM created:', vmData);
        
        if (vmData.status !== 'success') return res.status(500).json({ error: 'VM creation failed', details: vmData });
        
        const vmUrl = vmData.url;
        const containerId = vmData.container_id;
        vmStore.set(containerId, { ...vmData, createdAt: Date.now() });
        console.log(`Checking VM health at ${vmUrl}...`);
        
        const healthCheck = await checkEC2Health(vmUrl);
        if (!healthCheck.healthy) {
            return res.json({ ...vmData, warning: 'VM may still be starting up. Please refresh if you see a 502 error.', healthCheckAttempts: 30 });
        }
        return res.json({ ...vmData, verified: true });
    } catch (t) {
        console.error('Error creating VM:', t);
        return res.status(500).json({ error: 'Failed to create VM', details: t.message });
    }
});

// Manual EC2 Port Connection
app.get('/api/connect/:port', apiLimiter, async (req, res) => {
    const { port } = req.params;
    const vmUrl = `http://${EC2_HOST}:${port}/`;
    
    try {
        console.log(`Manually connecting to port ${port}...`);
        const containerId = `manual-${port}`;
        console.log(`Checking health for manual port ${port} at ${vmUrl}...`);
        
        const healthCheck = await checkEC2Health(vmUrl);
        const vmData = {
            status: 'success',
            url: vmUrl,
            container_id: containerId,
            port: port,
            name: `Friend's Session (${port})`,
            verified: healthCheck.healthy
        };
        
        vmStore.set(containerId, { ...vmData, createdAt: Date.now(), max_session_minutes: 60, inactivity_timeout_seconds: 60 });
        return res.json(vmData);
    } catch (t) {
        console.error('Error connecting to port:', t);
        return res.status(500).json({ error: 'Failed to connect to port', details: t.message });
    }
});

// Render EC2 VM Client
app.get('/api/vm/:containerId', async (req, res) => {
    const { containerId } = req.params;
    const vmData = vmStore.get(containerId);
    
    if (!vmData) {
        return res.status(404).send(`<!DOCTYPE html><html><head><title>VM Not Found</title><style>body{font-family:Arial,sans-serif;padding:40px;text-align:center}.error{color:red}</style></head><body><h1 class="error">VM Not Found</h1><p>The requested VM container ID was not found.</p><p><a href="/">Go to Home</a></p></body></html>`);
    }
    
    const vmUrl = vmData.url;
    const maxSessionMinutes = vmData.max_session_minutes || 60;
    const inactivityTimeoutSeconds = vmData.inactivity_timeout_seconds || 60;
    const name = vmData.name || containerId;
    
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>VM Console | ${name}</title><style>:root{--bg-color:#0a0a0d;--header-bg:#12121a;--primary-color:#ff6b00;--text-main:#e1e1e6;--text-muted:#9494a3;--border-color:rgba(255,107,0,.15)}*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Outfit',sans-serif;background:var(--bg-color);color:var(--text-main);height:100vh;display:flex;flex-direction:column;overflow:hidden}.header{background:var(--header-bg);padding:12px 24px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border-color);z-index:20}.vm-brand{display:flex;align-items:center;gap:12px}.logo-small{width:24px;height:24px;background:var(--primary-color);border-radius:6px;display:flex;align-items:center;justify-content:center;color:#000;font-weight:800;font-size:14px}.vm-name{font-size:14px;font-weight:600;color:var(--text-main)}.vm-id-tag{font-size:11px;color:var(--text-muted);background:rgba(255,255,255,.03);padding:2px 8px;border-radius:4px;font-family:monospace}.controls{display:flex;align-items:center;gap:24px}.timer-box{display:flex;align-items:center;gap:8px;font-family:monospace;font-weight:700;color:var(--primary-color);font-size:16px}.timer-box.warning{color:#ff5252;animation:pulse 1s infinite}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.6}}.inactivity-status{font-size:12px;color:var(--text-muted)}.vm-viewport{flex:1;position:relative;background:#000}iframe{width:100%;height:100%;border:none;position:absolute;top:0;left:0}.overlay{position:absolute;top:0;left:0;right:0;bottom:0;background:var(--bg-color);display:flex;flex-direction:column;justify-content:center;align-items:center;z-index:10;gap:20px}.loader{width:40px;height:40px;border:3px solid rgba(255,107,0,.1);border-top:3px solid var(--primary-color);border-radius:50%;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><div class="header"><div class="vm-brand"><div class="logo-small">U</div><span class="vm-name">${name}</span><span class="vm-id-tag">${containerId.substring(0,12)}</span></div><div class="controls"><span class="inactivity-status">⚠️ Inactivity Timeout (${inactivityTimeoutSeconds}s)</span><div class="timer-box" id="timer">${maxSessionMinutes}:00</div></div></div><div class="vm-viewport"><div class="overlay" id="loading"><div class="loader"></div><p style="font-size:13px;color:var(--text-muted)">Attaching to workspace...</p></div><iframe id="vmFrame" src="${vmUrl}" allow="fullscreen; clipboard-read; clipboard-write" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"></iframe></div><script>let totalSeconds=${maxSessionMinutes}*60;const timerEl=document.getElementById('timer');const updateTimer=()=>{const m=Math.floor(totalSeconds/60),s=totalSeconds%60;timerEl.textContent=m+':'+(s<10?'0':'')+s;if(totalSeconds<=300)timerEl.classList.add('warning');if(totalSeconds<=0){timerEl.textContent='EXPIRED';document.getElementById('vmFrame').style.display='none';document.getElementById('loading').style.display='flex';document.getElementById('loading').innerHTML='<h2 style="color:#ff5252">Session Expired</h2>';return}totalSeconds--};setInterval(updateTimer,1000);const iframe=document.getElementById('vmFrame'),loading=document.getElementById('loading');iframe.onload=()=>loading.style.display='none';iframe.onerror=()=>loading.innerHTML='<h2 style="color:#ff5252">Failed to load environment</h2>';</script></body></html>`;
    
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('X-Frame-Options', 'ALLOW-FROM *');
    res.send(html);

});

// --- AUTH & PROXY ROUTING ---
if (config.challenge !== false) {
    app.use(basicAuth({ users: config.users, challenge: true }));
}

app.use("/edu/", proxyLimiter);
app.use("/tor/", proxyLimiter);

app.use((req, res, next) => {
    const bare = bareServers.find((s) => s.shouldRoute(req));
    if (bare) bare.routeRequest(req, res);
    else next();
});

app.get("/uv/uv.config.js", (req, res) => {
    const barePath = checkTor(req) ? "/tor/" : "/edu/";
    res.type("application/javascript").send(`self.__uv$config = { prefix: '/service/', bare: '${barePath}', encodeUrl: Ultraviolet.codec.xor.encode, decodeUrl: Ultraviolet.codec.xor.decode, handler: '/uv/uv.handler.js', client: '/uv/uv.client.js', bundle: '/uv/uv.bundle.js', config: '/uv/uv.config.js', sw: '/uv/uv.sw.js' };`);
});

// --- STATIC FILES ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

app.use(express.static(path.join(__dirname, "static"), { extensions: ["html"] }));
app.use(express.static(path.join(__dirname, "public")));

// 404 Handler
app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, "static", "404.html"));
});

// --- SERVER LOGIC ---
const startServer = () => {
    const server = http.createServer();
    
    server.on("request", (req, res) => {
        const bare = bareServers.find((s) => s.shouldRoute(req));
        if (bare) bare.routeRequest(req, res);
        else app(req, res);
    });

    server.on("upgrade", (req, socket, head) => {
        if (req.url.startsWith("/wisp/")) {
            wisp.routeRequest(req, socket, head);
        } else {
            const bare = bareServers.find((s) => s.shouldRoute(req));
            if (bare) bare.routeUpgrade(req, socket, head);
            else socket.destroy();
        }
    });

    const PORT = process.env.PORT || 8080;

    server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
            console.error(chalk.red(`❌ Port ${PORT} is already in use. Retrying in 1s...`));
            setTimeout(() => {
                server.close();
                server.listen(PORT);
            }, 1000);
        }
    });

    server.listen(PORT, () => {
        console.log(chalk.green(`🚀 inkshower Started | Port ${PORT}`));
    });
};

if (!isVercel) {
    if (cluster.isPrimary && !process.env.PM2_HOME) {
        const numCPUs = os.cpus().length;
        console.log(chalk.cyan(`Primary process setting up ${numCPUs} workers...`));
        for (let i = 0; i < numCPUs; i++) cluster.fork();
        
        cluster.on("exit", (worker) => {
            console.log(chalk.yellow(`Worker ${worker.process.pid} died. Forking a new one...`));
            cluster.fork();
        });
    } else {
        startServer();
    }
}

export default app;
#!/usr/bin/env node
/**
 * The plugin's transport in the browser engines Obsidian runs on: WebKit (iPhone, iPad) and
 * Chromium (desktop, Android). The anysocket browser bundle the plugin ships runs in a real page
 * and does what the plugin does with a 1.6.0 server: authenticate, encrypt, version check,
 * register the device, upload and download text and binary files, receive live changes.
 *
 *   npm i --no-save playwright && npx playwright install webkit chromium
 *   node test/webkit/run.js
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { Server, PASSWORD } = require("../e2e/harness");

let playwright;
try {
    playwright = require(process.env.PLAYWRIGHT_PATH || "playwright");
} catch (e) {
    console.log("Playwright is not installed (npm i --no-save playwright && npx playwright install webkit chromium).");
    process.exit(0);
}

const BUNDLE = require.resolve("anysocket/dist/anysocket.browser.js", {
    paths: [path.join(__dirname, "..", "..", "..", "obsidian-anysocket-sync"), path.join(__dirname, "..", "..")]
});
const BUILD = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "client", "build_info.json"), "utf8"));

// what runs in the page: a device, the way the plugin's SyncV2 talks to the server
const PAGE = `<!doctype html><meta charset="utf-8"><script src="/anysocket.js"></script><script>
const log = [];
const check = (name, ok, extra) => log.push({ name, ok: !!ok, extra: extra === undefined ? "" : String(extra) });
const hex = (buf) => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
const sha = async (data) => hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : data));
window.run = async (port, password, build) => {
    try {
        const anysocket = new AnySocket({ auth: { secret: password, optional: true } });
        const legacy = await sha(anysocket.id.substring(0, 16) + password + anysocket.id.substring(16));
        anysocket.authPacket = () => legacy;
        anysocket.onAuth = async (packet) => (await sha(packet.id.substring(0, 16) + password + packet.id.substring(16))) === packet.auth;
        const changes = [];
        anysocket.on("message", (packet) => { if (packet.msg && packet.msg.type === "changed") changes.push(packet.msg); });

        const peer = await anysocket.connect("ws", "127.0.0.1", port, { heartbeatInterval: 10000, heartbeatsMaxMissed: 5, connectTimeout: 10000 });
        check("connects (with connectTimeout, fixed in anysocket 1.0.2)", true);
        check("built-in mutual auth", peer.isAuthenticated());
        await peer.e2e();
        const info = peer.e2eInfo();
        check("encrypted", peer.isE2EEnabled(), JSON.stringify(info));
        check("the channel is authenticated", info && info.authenticated, JSON.stringify(info));

        const time = await peer.getSyncedTime();
        check("synced time", time && Math.abs(time.time - Date.now()) < 5000);
        const version = await peer.rpc.onVersionCheck(build.version, build.build);
        check("version check", version.type === "ok", JSON.stringify(version));
        const hello = await peer.rpc.hello({ id: "webkit" + hex(crypto.getRandomValues(new Uint8Array(8))), secret: hex(crypto.getRandomValues(new Uint8Array(32))), name: "iPhone", platform: "ios", autoSync: true });
        check("approved as the first device", hello.device && hello.device.status === "approved", JSON.stringify(hello.device));

        const text = "# From the browser engine\\nünïcødé ✓\\n";
        const textBytes = new TextEncoder().encode(text);
        const putText = await peer.rpcWith({ timeout: 60000 }).sync.put("Notes/engine.md", { type: "file", action: "created", sha1: await sha(textBytes), mtime: Date.now() }, false, textBytes);
        check("uploads text", putText.result === "applied" && putText.meta.sha1 === await sha(textBytes), JSON.stringify(putText));

        // getRandomValues takes at most 64KB at a time
        const image = new Uint8Array(300 * 1024);
        for (let i = 0; i < image.length; i += 65536) crypto.getRandomValues(image.subarray(i, Math.min(i + 65536, image.length)));
        const imageSha = await sha(image);
        const putImage = await peer.rpcWith({ timeout: 60000 }).sync.put("Assets/photo.png", { type: "file", action: "created", sha1: imageSha, mtime: Date.now() }, false, image);
        check("uploads 300KB of binary", putImage.result === "applied" && putImage.meta.sha1 === imageSha && putImage.meta.size === image.length, JSON.stringify(putImage.meta));

        const list = await peer.rpc.sync.list(false, false, 5000);
        check("lists the server", list.full && list.entries.some(e => e[0] === "Assets/photo.png"), list.entries.length);

        const gotText = await peer.rpcWith({ timeout: 60000 }).sync.content("Notes/engine.md", false);
        const decoded = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }).decode(gotText);
        check("downloads text, as bytes", gotText instanceof Uint8Array && decoded === text, Object.prototype.toString.call(gotText));
        const gotImage = await peer.rpcWith({ timeout: 60000 }).sync.content("Assets/photo.png", false);
        check("downloads binary, byte for byte", gotImage instanceof Uint8Array && (await sha(gotImage)) === imageSha);

        // blob previews (version history of images)
        const url = URL.createObjectURL(new Blob([gotImage], { type: "image/png" }));
        check("blob URLs for previews", url.startsWith("blob:"));
        URL.revokeObjectURL(url);

        window.__peer = peer;
        window.__changes = changes;
        window.__imageSha = imageSha;
        return log;
    } catch (e) {
        check("no error", false, (e && (e.stack || e.message)) || e);
        return log;
    }
};
window.changesSeen = () => window.__changes.map(c => c.entries.map(e => e[0])).flat();
</script>`;

(async () => {
    const cleanups = [];
    const t = { after: (fn) => cleanups.push(fn) };
    const bundle = fs.readFileSync(BUNDLE);
    const web = http.createServer((req, res) => {
        if (req.url === "/anysocket.js") {
            res.writeHead(200, { "content-type": "text/javascript" });
            return res.end(bundle);
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end(PAGE);
    });
    await new Promise(r => web.listen(0, "127.0.0.1", r));
    const pageUrl = "http://127.0.0.1:" + web.address().port + "/";
    console.log("anysocket bundle:", BUNDLE.replace(/.*node_modules/, "node_modules"), require(path.join(path.dirname(BUNDLE), "..", "package.json")).version);

    let failed = 0;
    for (const engine of (process.env.ENGINES || "webkit,chromium").split(",")) {
        console.log("\n=== " + engine + (engine === "webkit" ? " (iPhone, iPad)" : " (desktop, Android)"));
        const server = await new Server(t, { config: { logs: { level: 1 } } }).start();
        let browser;
        try {
            browser = await playwright[engine].launch();
        } catch (e) {
            console.log("  SKIP " + engine + " is not installed (" + e.message.split("\n")[0] + ")");
            continue;
        }
        const page = await browser.newPage();
        page.on("pageerror", (e) => console.log("  page error:", e.message));
        await page.goto(pageUrl);
        const log = await page.evaluate(([port, password, build]) => window.run(port, password, build), [server.port, PASSWORD, BUILD]);

        // another device (node) is approved on the server and changes a file: the page hears about it
        const AnySocket = require("anysocket");
        const c = new AnySocket({ auth: { secret: PASSWORD } });
        const legacyC = crypto.createHash("sha256").update(c.id.substring(0, 16) + PASSWORD + c.id.substring(16)).digest("hex");
        c.authPacket = () => legacyC;
        c.onAuth = () => true;
        const peerC = await c.connect("ws", "127.0.0.1", server.port);
        await peerC.e2e();
        await peerC.rpc.onVersionCheck(BUILD.version, BUILD.build);
        const id = "tablet" + crypto.randomBytes(8).toString("hex");
        const secret = crypto.randomBytes(32).toString("hex");
        await peerC.rpc.hello({ id, secret, name: "Tablet", platform: "android" });
        server.cli("devices", "approve", "Tablet");
        await new Promise(r => setTimeout(r, 300));
        await peerC.rpc.sync.put("From another device.md", { type: "file", action: "created", sha1: "x", mtime: Date.now() }, false, Buffer.from("hello from the tablet"));
        const seen = await (async () => {
            for (let i = 0; i < 50; i++) {
                const changes = await page.evaluate(() => window.changesSeen());
                if (changes.includes("From another device.md")) return true;
                await new Promise(r => setTimeout(r, 100));
            }
            return false;
        })();
        log.push({ name: "hears about another device's change", ok: seen, extra: "" });
        await c.stop().catch(() => {});

        for (const item of log) {
            console.log((item.ok ? "  PASS " : "  FAIL ") + item.name + (item.extra ? "  (" + item.extra.slice(0, 160) + ")" : ""));
            if (!item.ok) failed++;
        }
        const stored = server.stored("Assets/photo.png");
        const ok = stored && crypto.createHash("sha256").update(stored.data).digest("hex") === (await page.evaluate(() => window.__imageSha));
        console.log((ok ? "  PASS " : "  FAIL ") + "the server stored the binary byte for byte");
        if (!ok) failed++;
        await browser.close();
        await server.stop();
    }
    web.close();
    for (const fn of cleanups) await fn();
    console.log(failed ? "\n" + failed + " failed" : "\nall passed");
    process.exit(failed ? 1 : 0);
})();

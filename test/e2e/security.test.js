const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const WS = require("ws");
const AnySocket = require("anysocket");
const { Server, Device, waitFor, PASSWORD } = require("./harness");

// a client with some password, the way the plugin authenticates
async function login(port, password) {
    const a = new AnySocket({ auth: { secret: password, optional: true } });
    const legacy = crypto.createHash("sha256").update(a.id.substring(0, 16) + password + a.id.substring(16)).digest("hex");
    a.authPacket = () => legacy;
    a.onAuth = () => true;
    const start = Date.now();
    try {
        await a.connect("ws", "127.0.0.1", port);
        return { ok: true, ms: Date.now() - start };
    } catch (e) {
        return { ok: false, ms: Date.now() - start };
    } finally {
        await a.stop().catch(() => {});
    }
}

test("guessing the password is slow; the right password is not", async (t) => {
    const server = await new Server(t).start();
    const right = await login(server.port, PASSWORD);
    assert.equal(right.ok, true);
    assert.ok(right.ms < 1500, "right password: " + right.ms + "ms");
    const wrong = await login(server.port, "guess-1");
    assert.equal(wrong.ok, false);
    assert.ok(wrong.ms >= 1900, "wrong password answered after " + wrong.ms + "ms");
});

test("a burst of wrong passwords is reported, and a real device still connects", async (t) => {
    const server = await new Server(t).start();
    await Promise.all(Array.from({ length: 35 }, (_, i) => login(server.port, "guess-" + i)));
    await waitFor(() => /failed logins in the last minute: someone may be guessing the password/.test(server.logs), { message: "alarm" });

    const laptop = new Device(t, server, { name: "Laptop" });
    const start = Date.now();
    await laptop.start();
    await laptop.waitSynced();
    assert.ok(Date.now() - start < 5000, "the real device is not slowed down");
});

test("nothing is answered to an unencrypted or unauthenticated socket", async (t) => {
    const server = await new Server(t).start();
    const ws = new WS("ws://127.0.0.1:" + server.port + "/");
    await new Promise(r => ws.on("open", r));
    const closed = new Promise(r => ws.on("close", r));
    // garbage, a fake RPC, a huge text frame
    ws.send(Buffer.from([0]));
    ws.send("2" + "x".repeat(10));
    await closed;
    assert.equal(server.exited, false);
    assert.equal(server.stored("anything"), null);
});

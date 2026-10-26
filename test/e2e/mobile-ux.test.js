const test = require("node:test");
const assert = require("node:assert");
const { Server, Device, waitFor, waitSame, sleep, freePort } = require("./harness");

async function laptopAndPhone(t, phoneOptions = {}) {
    const server = await new Server(t).start();
    const laptop = new Device(t, server, { name: "Laptop" });
    await laptop.start();
    await laptop.waitSynced();
    const phone = new Device(t, server, Object.assign({ name: "Phone", platform: "ios" }, phoneOptions));
    await phone.start();
    await phone.waitState(s => s.status === "waiting_approval", "waiting");
    server.cli("devices", "approve", "Phone");
    await phone.waitSynced();
    return { server, laptop, phone };
}

// ---- mobile ----

test("mobile: the app goes to the background and comes back, and catches up", async (t) => {
    const { server, laptop, phone } = await laptopAndPhone(t);
    await phone.background(true);
    await waitFor(() => /\[Phone\] Disconnected/.test(server.logs), { message: "phone disconnects in the background" });

    await laptop.write("while away.md", "written while the phone was in the background");
    await laptop.settle();
    await sleep(500);
    assert.equal(await phone.exists("while away.md"), false);

    await phone.background(false);
    await phone.waitSynced();
    await waitFor(async () => (await phone.read("while away.md")) === "written while the phone was in the background", { message: "caught up" });
});

test("mobile: switching apps quickly many times leaves everything consistent", async (t) => {
    const { laptop, phone } = await laptopAndPhone(t);
    for (let i = 0; i < 8; i++) {
        await phone.background(true);
        await laptop.write("n" + i + ".md", "note " + i);
        await sleep(30 + i * 15);
        await phone.background(false);
        await sleep(30);
    }
    await phone.waitSynced(30000);
    const tree = await waitSame([laptop, phone], 30000);
    assert.equal(Object.keys(tree).filter(p => /^n\d\.md$/.test(p)).length, 8);
});

test("mobile: a change waiting to be sent when the app goes to the background is sent later", async (t) => {
    const { laptop, phone } = await laptopAndPhone(t, { settings: { delayedSync: 10 } });
    await phone.write("typed.md", "typed just before switching apps");
    await phone.background(true);
    await sleep(300);
    await phone.background(false);
    await phone.waitSynced();
    await waitFor(async () => (await laptop.read("typed.md")) === "typed just before switching apps", { message: "sent after coming back" });
});

test("mobile: devices get a real default name (not \"Unknown\")", async (t) => {
    const server = await new Server(t).start();
    const iphone = new Device(t, server, { name: "ignored", platform: "ios", settings: { deviceName: "" } });
    const android = new Device(t, server, { name: "ignored", platform: "android", settings: { deviceName: "Unknown" } });
    await iphone.start();
    await android.start();
    await iphone.waitState(s => !!s.device, "registered");
    await android.waitState(s => !!s.device, "registered");
    const names = [(await iphone.state()).device.name, (await android.state()).device.name].sort();
    assert.deepEqual(names, ["Pixel 8", "iPhone"]);
});

// ---- what the person sees ----

test("status: a wrong password says so, in words", async (t) => {
    const server = await new Server(t).start();
    const device = new Device(t, server, { name: "Laptop", settings: { password: "not the password" } });
    await device.start();
    const s = await device.waitState(s => s.status === "auth_failed", "wrong password", 30000);
    assert.equal(s.text, "Wrong password");
    assert.match(s.sentence, /didn't accept the password/);
});

test("status: an unreachable server shows offline, and changes wait", async (t) => {
    const server = { port: await freePort() };
    const device = new Device(t, server, { name: "Laptop" });
    await device.start();
    const s = await device.waitState(s => s.status === "unreachable", "unreachable");
    assert.equal(s.text, "Offline");
    assert.match(s.sentence, /Can't reach the server at 127\.0\.0\.1:\d+\. Your changes are kept/);
});

test("status: not set up, and turned off", async (t) => {
    const server = await new Server(t).start();
    const fresh = new Device(t, server, { name: "Fresh", settings: { password: "" } });
    await fresh.start();
    assert.equal((await fresh.waitState(s => s.status === "setup", "setup")).text, "Set up sync");

    const off = new Device(t, server, { name: "Off", settings: { syncEnabled: false } });
    await off.start();
    assert.equal((await off.waitState(s => s.status === "disabled", "off")).text, "Sync off");
});

test("status: auto sync off keeps changes until \"Sync now\"", async (t) => {
    const { server, laptop } = await (async () => {
        const server = await new Server(t).start();
        const laptop = new Device(t, server, { name: "Laptop", settings: { autoSync: false } });
        await laptop.start();
        return { server, laptop };
    })();
    await laptop.waitState(s => s.status === "paused", "paused");
    await laptop.write("a.md", "a");
    await laptop.write("b.md", "b");
    const s = await laptop.waitState(s => s.pending === 2, "2 waiting");
    assert.equal(s.text, "Auto sync off · 2 waiting");
    assert.equal(server.stored("a.md"), null);

    await laptop.syncNow();
    await laptop.settle();
    assert.equal(server.stored("a.md").data.toString(), "a");
    assert.equal((await laptop.state()).pending, 0);
});

test("notifications: \"Important only\" doesn't pop up for routine things", async (t) => {
    const server = await new Server(t).start();
    const quiet = new Device(t, server, { name: "Quiet", settings: { notifications: 1 } });
    await quiet.start();
    await quiet.waitSynced();
    await quiet.write("a.md", "a");
    await quiet.settle();
    assert.deepEqual(await quiet.notices(), []);

    const off = new Device(t, server, { name: "Silent", settings: { notifications: 0 } });
    await off.start();
    await off.waitState(s => s.status === "waiting_approval", "waiting");
    assert.deepEqual(await off.notices(), [], "even the approval prompt stays in the status bar");
});

test("reconnecting backs off while the server is down", async (t) => {
    const server = await new Server(t).start();
    const device = new Device(t, server, { name: "Laptop" });
    await device.start();
    await device.waitSynced();
    await server.stop();
    await device.waitState(s => s.status === "offline" || s.status === "unreachable", "offline");
    // with 1s, 2s, 5s, 10s waits, about 3 attempts in 9 seconds (it used to try every second)
    const before = Date.now();
    const attempts = [];
    while (Date.now() - before < 9000) {
        const s = await device.state();
        if (s.status === "connecting" && attempts[attempts.length - 1] !== "c") attempts.push("c");
        if (s.status !== "connecting") attempts.push("-");
        await sleep(100);
    }
    const tries = attempts.filter(a => a === "c").length;
    assert.ok(tries <= 5, "tried " + tries + " times");

    await server.start();
    await device.waitState(s => s.status === "synced", "back", 40000);
});

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { tmpdir } = require("../helpers/tmp");
const DB = require("../../libs/DB");
const Devices = require("../../libs/Devices");
const { STATUS, GRANDFATHER_ACTIVE, GRANDFATHER_WINDOW } = Devices;

const DAY = 24 * 60 * 60 * 1000;
const creds = (id, name = id) => ({ id: id.padEnd(12, "0"), secret: "secret-of-" + id.padEnd(12, "0"), name, platform: "desktop" });

function setup(t, legacy) {
    const dir = tmpdir(t, "devices");
    if (legacy) {
        fs.mkdirSync(path.join(dir, "db"), { recursive: true });
        fs.writeFileSync(path.join(dir, "db", "data.json"), JSON.stringify(legacy));
    }
    const db = new DB(path.join(dir, "db"));
    return { dir, db, devices: new Devices(db) };
}

test("the first device is approved, the next one waits", (t) => {
    const { devices } = setup(t);
    const first = devices.register(creds("laptop"));
    assert.equal(first.device.status, STATUS.APPROVED);
    assert.equal(first.device.approved_by, "first device");
    const second = devices.register(creds("phone"));
    assert.equal(second.device.status, STATUS.PENDING);
    assert.equal(second.created, true);
});

test("a device has to prove it is itself", (t) => {
    const { devices } = setup(t);
    devices.register(creds("laptop"));
    const thief = devices.register(Object.assign(creds("laptop"), { secret: "a-guessed-secret-123" }));
    assert.equal(thief.error, "invalid device credentials");
    assert.equal(devices.register(creds("laptop")).device.status, STATUS.APPROVED);
});

test("the secret is never stored", (t) => {
    const { dir, devices } = setup(t);
    devices.register(creds("laptop"));
    assert.ok(!fs.readFileSync(path.join(dir, "db", "data.json"), "utf8").includes("secret-of-"));
});

test("malformed device credentials are refused", (t) => {
    const { devices } = setup(t);
    assert.ok(devices.register({ id: "../../x", secret: "1234567890123456", name: "x" }).error);
    assert.ok(devices.register({ id: "abcdefgh", secret: "short", name: "x" }).error);
    assert.ok(devices.register({}).error);
    assert.equal(devices.list().length, 0);
});

test("approve, revoke and remove, by id or by name", (t) => {
    const { devices } = setup(t);
    devices.register(creds("laptop", "Laptop"));
    const phone = devices.register(creds("phone", "My Phone")).device;
    devices.approve("my phone", "Laptop");
    assert.equal(devices.get(phone.id).status, STATUS.APPROVED);
    assert.equal(devices.get(phone.id).approved_by, "Laptop");
    devices.revoke(phone.id);
    assert.equal(devices.get(phone.id).status, STATUS.REVOKED);
    // a revoked device stays revoked when it reconnects
    assert.equal(devices.register(creds("phone", "My Phone")).device.status, STATUS.REVOKED);
    devices.remove(phone.id);
    assert.equal(devices.get(phone.id), null);
    assert.throws(() => devices.approve("nobody"), /No device/);
});

test("two devices with the same name have to be picked by id", (t) => {
    const { devices } = setup(t);
    devices.register(creds("one", "Phone"));
    devices.register(creds("two", "Phone"));
    assert.throws(() => devices.approve("phone"), /use its id/);
});

test("upgrading from 1.5: devices active in the last 30 days are approved by name", (t) => {
    const now = Date.now();
    const { devices, db } = setup(t, {
        devices: {
            "Laptop": { last_online: now - 2 * DAY },
            "Old tablet": { last_online: now - GRANDFATHER_ACTIVE - DAY }
        }
    });
    // the first device is approved anyway
    devices.register(creds("other", "Desktop"));
    assert.equal(devices.register(creds("laptop", "Laptop")).device.approved_by, "upgrade");
    assert.equal(devices.register(creds("tablet", "Old tablet")).device.status, STATUS.PENDING);
    // a name is only claimed once
    assert.equal(devices.register(creds("impostor", "Laptop")).device.status, STATUS.PENDING);
    assert.equal(db.data.legacy_claimed["Laptop"], creds("laptop").id);
});

test("the upgrade grace period ends", (t) => {
    const now = Date.now();
    const { devices, db } = setup(t, { devices: { "Laptop": { last_online: now } } });
    devices.register(creds("first", "First"));
    db.data.upgraded_at = now - GRANDFATHER_WINDOW - DAY;
    db.data.devices["Laptop"].last_online = db.data.upgraded_at;
    assert.equal(devices.register(creds("laptop", "Laptop")).device.status, STATUS.PENDING);
});

test("cleanup waits for approved devices only", (t) => {
    const { devices } = setup(t);
    assert.equal(devices.minLastOnline(), -1);
    const laptop = devices.register(creds("laptop")).device;
    devices.register(creds("pending"));
    laptop.last_online = 1234;
    assert.equal(devices.minLastOnline(), 1234);
});

test("data.json stays readable by 1.5.x (legacy devices untouched)", (t) => {
    const legacy = { devices: { "Laptop": { last_online: 5 } } };
    const { dir, devices } = setup(t, legacy);
    devices.register(creds("laptop", "Laptop"));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "db", "data.json"), "utf8"));
    assert.deepEqual(saved.devices, legacy.devices);
    assert.ok(saved.devices_v2);
});

test("a corrupt data.json is kept aside and the server starts", (t) => {
    const dir = tmpdir(t, "db");
    fs.mkdirSync(path.join(dir, "db"));
    fs.writeFileSync(path.join(dir, "db", "data.json"), "{\"devices\": {");
    const db = new DB(path.join(dir, "db"));
    assert.deepEqual(db.data.devices, {});
    assert.ok(fs.readdirSync(path.join(dir, "db")).some(f => f.startsWith("data.json.broken-")));
});

test("data.json is written atomically", (t) => {
    const { dir, db } = setup(t);
    db.data.x = 1;
    db.save();
    assert.deepEqual(fs.readdirSync(path.join(dir, "db")), ["data.json"]);
});

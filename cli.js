#!/usr/bin/env node
/**
 * Server commands.
 *
 *   node cli.js devices                      list devices
 *   node cli.js devices approve <name|id>    allow a waiting device to sync
 *   node cli.js devices revoke <name|id>     stop a device from syncing
 *   node cli.js devices remove <name|id>     decline a waiting device (it can ask again)
 *
 * Docker: docker exec <container> node cli.js devices
 */
const fs = require("fs");
const path = require("path");

const USAGE = `Usage:
  node cli.js devices                      list devices
  node cli.js devices approve <name|id>    allow a waiting device to sync
  node cli.js devices revoke <name|id>     stop a device from syncing
  node cli.js devices remove <name|id>     decline a waiting device (it can ask again)`;

function ago(time) {
    if (!time) {
        return "never";
    }
    const s = Math.round((Date.now() - time) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
}

function printDevices(devices) {
    if (devices.length === 0) {
        console.log("No devices yet. The first device that connects is approved automatically.");
        return;
    }
    const order = { pending: 0, approved: 1, revoked: 2 };
    devices.sort((a, b) => order[a.status] - order[b.status] || (b.last_online || 0) - (a.last_online || 0));
    const rows = devices.map(d => [
        d.status === "pending" ? "WAITING" : d.status.toUpperCase(),
        d.name,
        d.platform || "",
        d.online ? "online" : ago(d.last_online),
        d.id
    ]);
    const head = ["STATUS", "NAME", "PLATFORM", "LAST SEEN", "ID"];
    const widths = head.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)));
    const line = (r) => r.map((c, i) => String(c).padEnd(widths[i])).join("  ");
    console.log(line(head));
    rows.forEach(r => console.log(line(r)));
    const waiting = devices.filter(d => d.status === "pending");
    if (waiting.length) {
        console.log("\nApprove with: node cli.js devices approve \"" + waiting[0].name + "\"");
    }
}

function loadConfig() {
    const configPath = path.resolve(process.env.ANYSOCKET_SYNC_CONFIG || path.join(__dirname, "config.js"));
    if (!fs.existsSync(configPath)) {
        throw new Error("config.js not found (" + configPath + ")");
    }
    const config = require(configPath);
    config.app_dir = __dirname;
    config.data_dir = "data";
    config.data_path = path.resolve(process.env.ANYSOCKET_SYNC_DATA || path.join(__dirname, config.data_dir));
    return config;
}

// the running server, over its local admin socket
async function connect(config) {
    const AnySocket = require("anysocket");
    const { adminSocketPath } = require("./libs/server");
    const client = new AnySocket({ auth: { secret: config.password } });
    client.onAuth = () => true;
    try {
        const peer = await client.connect("ipc", adminSocketPath(config), { connectTimeout: 3000 });
        return { peer, close: () => client.stop().catch(() => {}) };
    } catch (e) {
        await client.stop().catch(() => {});
        return null;
    }
}

// the server is not running: work on data.json directly
function offline(config) {
    global.XDB = new (require("./libs/DB"))(config.data_path + "/db");
    const devices = new (require("./libs/Devices"))(XDB);
    return {
        list: () => devices.list(),
        approve: (id) => devices.public(devices.approve(id, "server")),
        revoke: (id) => devices.public(devices.revoke(id)),
        remove: (id) => devices.public(devices.remove(id))
    };
}

async function main(argv) {
    const [group, command, ...rest] = argv;
    const target = rest.join(" ");
    if (group !== "devices" || (command && ["approve", "revoke", "remove"].indexOf(command) === -1) || (command && !target)) {
        console.log(USAGE);
        return 1;
    }

    const config = loadConfig();
    const link = await connect(config);
    let api;
    if (link) {
        api = link.peer.rpc.devices;
    } else {
        console.log("(server is not running, editing data.json directly)\n");
        api = offline(config);
    }

    try {
        if (!command) {
            printDevices(await api.list());
        } else {
            const device = await api[command](target);
            const done = { approve: "Approved", revoke: "Removed", remove: "Declined" }[command];
            console.log(done + ": " + device.name + " (" + device.id + ")");
        }
        return 0;
    } catch (e) {
        console.log("Error: " + (e && (e.error || e.message) || e));
        return 1;
    } finally {
        if (link) {
            await link.close();
        }
    }
}

if (require.main === module) {
    main(process.argv.slice(2)).then(code => process.exit(code));
}

module.exports = { main };

const crypto = require("crypto");

const DAY = 24 * 60 * 60 * 1000;
// devices seen this recently before the upgrade to 1.6.0 are approved by name...
const GRANDFATHER_ACTIVE = 30 * DAY;
// ...for this long after the upgrade
const GRANDFATHER_WINDOW = 30 * DAY;

const STATUS = {
    APPROVED: "approved",
    PENDING: "pending",
    REVOKED: "revoked"
};

const hash = (secret) => crypto.createHash("sha256").update(String(secret)).digest("hex");

function sameHash(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Which devices may sync. The first device is approved on its own; every device
 * after it waits until an approved device (or the server CLI) approves it.
 * Each device proves it is itself with a secret only it knows (we keep a hash).
 */
module.exports = class Devices {
    constructor(db) {
        this.db = db;
        const data = db.data;
        if (!data.devices_v2 || typeof data.devices_v2 !== "object") {
            data.devices_v2 = {};
        }
        if (!data.upgraded_at) {
            data.upgraded_at = Date.now();
            data.legacy_claimed = {};
        }
        if (!data.legacy_claimed) {
            data.legacy_claimed = {};
        }
        db.save();
    }

    get all() {
        return this.db.data.devices_v2;
    }

    get(id) {
        return this.all[id] || null;
    }

    list() {
        return Object.keys(this.all).map(id => this.public(this.all[id]));
    }

    public(device) {
        if (!device) {
            return null;
        }
        return {
            id: device.id,
            name: device.name,
            platform: device.platform,
            status: device.status,
            created: device.created,
            last_online: device.last_online,
            approved_by: device.approved_by || null
        };
    }

    hasApproved() {
        return Object.values(this.all).some(device => device.status === STATUS.APPROVED);
    }

    // a device that synced with the 1.5.x server shortly before the upgrade, under this name
    isGrandfathered(name) {
        const data = this.db.data;
        if (!name || Date.now() - data.upgraded_at > GRANDFATHER_WINDOW) {
            return false;
        }
        if (data.legacy_claimed[name]) {
            return false;
        }
        const legacy = data.devices[name];
        if (!legacy || !legacy.last_online) {
            return false;
        }
        return legacy.last_online >= data.upgraded_at - GRANDFATHER_ACTIVE;
    }

    /**
     * Called on every connection. Returns { device, created } or { error }.
     */
    register({ id, secret, name, platform }) {
        if (typeof id !== "string" || !/^[a-zA-Z0-9-]{8,64}$/.test(id) ||
            typeof secret !== "string" || secret.length < 16 || secret.length > 256) {
            return { error: "invalid device credentials" };
        }
        name = String(name || "Unknown device").slice(0, 64);
        platform = String(platform || "").slice(0, 32);

        const now = Date.now();
        let device = this.get(id);
        if (device) {
            if (!sameHash(device.secret_hash, hash(secret))) {
                return { error: "invalid device credentials" };
            }
            device.name = name;
            device.platform = platform;
            device.last_online = now;
            this.db.save();
            return { device, created: false };
        }

        device = {
            id,
            name,
            platform,
            secret_hash: hash(secret),
            status: STATUS.PENDING,
            created: now,
            last_online: now
        };

        if (!this.hasApproved()) {
            device.status = STATUS.APPROVED;
            device.approved_by = "first device";
        } else if (this.isGrandfathered(name)) {
            device.status = STATUS.APPROVED;
            device.approved_by = "upgrade";
        }
        if (device.status === STATUS.APPROVED && this.db.data.devices[name]) {
            this.db.data.legacy_claimed[name] = id;
        }

        this.all[id] = device;
        this.db.save();
        return { device, created: true };
    }

    seen(id) {
        const device = this.get(id);
        if (device) {
            device.last_online = Date.now();
            this.db.save();
        }
    }

    // id, or a unique (case-insensitive) name
    find(idOrName) {
        if (this.all[idOrName]) {
            return this.all[idOrName];
        }
        const matches = Object.values(this.all).filter(d => d.name.toLowerCase() === String(idOrName).toLowerCase());
        if (matches.length > 1) {
            throw new Error("More than one device is named \"" + idOrName + "\", use its id");
        }
        return matches[0] || null;
    }

    setStatus(idOrName, status, by) {
        const device = this.find(idOrName);
        if (!device) {
            throw new Error("No device \"" + idOrName + "\"");
        }
        device.status = status;
        if (status === STATUS.APPROVED) {
            device.approved_by = by || null;
        }
        this.db.save();
        return device;
    }

    approve(idOrName, by) {
        return this.setStatus(idOrName, STATUS.APPROVED, by);
    }

    revoke(idOrName) {
        return this.setStatus(idOrName, STATUS.REVOKED);
    }

    // forget a device entirely (a pending request that was declined)
    remove(idOrName) {
        const device = this.find(idOrName);
        if (!device) {
            throw new Error("No device \"" + idOrName + "\"");
        }
        delete this.all[device.id];
        this.db.save();
        return device;
    }

    // the oldest last_online among approved devices (cleanup waits for all of them)
    minLastOnline() {
        const approved = Object.values(this.all).filter(d => d.status === STATUS.APPROVED);
        if (approved.length === 0) {
            return -1;
        }
        return Math.min(...approved.map(d => d.last_online || 0));
    }
};

module.exports.STATUS = STATUS;
module.exports.GRANDFATHER_ACTIVE = GRANDFATHER_ACTIVE;
module.exports.GRANDFATHER_WINDOW = GRANDFATHER_WINDOW;

const crypto = require("crypto");
const Helpers = require("../helpers");
const { isMergeable, merge, copyPath } = require("./merge");

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

const RESULT = {
    // nothing to do, the server already has exactly this
    UNCHANGED: "unchanged",
    // the change was stored as is
    APPLIED: "applied",
    // both devices edited different parts of the note; the server combined them
    MERGED: "merged",
    // both devices changed the same part; the other version was kept as a second file
    KEPT_BOTH: "kept_both",
    // a delete of a version that was since changed elsewhere; the newer version is kept
    STALE: "stale",
    // a rename the server could not do as a move; the client deletes + creates instead
    FALLBACK: "fallback",
    RENAMED: "renamed"
};

function toBuffer(data) {
    // false: "no content" from a browser client (anysocket's browser build can't send a null argument)
    if (data == null || data === false) {
        return null;
    }
    if (Buffer.isBuffer(data)) {
        return data;
    }
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        return Buffer.from(data.buffer || data, data.byteOffset || 0, data.byteLength);
    }
    if (typeof data === "string") {
        return Buffer.from(data, "utf8");
    }
    throw new Error("unsupported content");
}

// the fields a client may set; everything else (seq, renamed_to, ...) is the server's
function cleanMeta(meta) {
    if (!meta || typeof meta !== "object") {
        throw new Error("missing metadata");
    }
    const type = meta.type === "folder" ? "folder" : "file";
    const action = meta.action === "deleted" ? "deleted" : "created";
    const mtime = Number(meta.mtime);
    if (!Number.isFinite(mtime) || mtime <= 0) {
        throw new Error("invalid mtime");
    }
    return {
        type,
        action,
        sha1: typeof meta.sha1 === "string" ? meta.sha1 : null,
        mtime: Math.round(mtime)
    };
}

const sameState = (a, b) => !!a && !!b && a.action === b.action &&
    (a.action === "deleted" || a.type === "folder" || a.sha1 === b.sha1);

/**
 * Sync protocol v2 (1.6.0+). The client drives: it lists what changed on the server,
 * downloads what it needs, and uploads its own changes saying which server version they
 * were based on. Every decision happens here, under a per-path lock.
 */
module.exports = class SyncService {
    constructor(storage, options = {}) {
        this.storage = storage;
        this.debug = options.debug || 0;
        // (changes, origin) -> tells the other devices
        this.onChange = options.onChange || (() => {});
    }

    /**
     * What changed after `cursor`, oldest first, at most `limit` entries at a time (a vault can
     * have hundreds of thousands of files). A cursor from another epoch (the server restarted)
     * or none at all starts a full listing. `more`: call again with the returned cursor.
     */
    list(cursor, epoch, limit = Infinity) {
        const full = epoch !== this.storage.epoch || typeof cursor !== "number";
        const latest = this.storage.seq;
        const changes = this.storage.changesSince(full ? 0 : cursor);
        const page = changes.slice(0, Math.max(1, limit));
        const more = changes.length > page.length;
        return {
            epoch: this.storage.epoch,
            cursor: more ? page[page.length - 1][1].seq : latest,
            full,
            more,
            entries: page
        };
    }

    async meta(path) {
        return await this.storage.readMetadata(path);
    }

    // the content of the current version, or of a given one
    async content(path, timestamp) {
        if (timestamp) {
            if (!/^\d+$/.test(String(timestamp))) {
                return null;
            }
            return await this.storage.readExact(path + "/" + timestamp, true);
        }
        return await this.storage.read(path, true);
    }

    isTaken(path) {
        const meta = this.storage.index.get(path);
        return !!meta && meta.action !== "deleted";
    }

    async store(path, meta, data) {
        if (data != null) {
            meta.size = data.length;
        }
        return await this.storage.storeEntry(path, meta, data, Helpers.isBinary(path));
    }

    /**
     * An upload: a new/changed file or folder, or a delete.
     * `base` is the server state the change was made from ({ sha1, action }), or null when
     * the client never synced this path.
     */
    async put(path, rawMeta, base, rawData, device) {
        const meta = cleanMeta(rawMeta);
        const data = toBuffer(rawData);
        meta.path = path;
        meta.device = device.name;
        if (meta.type === "file" && meta.action === "created") {
            if (data == null) {
                throw new Error("missing content");
            }
            // the content decides, not what the client says about it
            meta.sha1 = sha256(data);
        }

        const changes = [];
        const result = await this.storage.withLock(path, async () => {
            const current = this.storage.index.get(path);

            if (sameState(current, meta)) {
                return { result: RESULT.UNCHANGED, meta: current };
            }

            const fromCurrent = !!current && !!base && sameState(current, {
                type: current.type, action: base.action, sha1: base.sha1
            });

            if (!current || fromCurrent) {
                const stored = await this.store(path, meta, data);
                changes.push(path);
                return { result: RESULT.APPLIED, meta: stored };
            }

            // ---- the server changed since this device last saw it ----

            // deleting a version that is no longer the current one: keep the newer one
            if (meta.action === "deleted") {
                return { result: RESULT.STALE, meta: current };
            }

            // edited here, deleted elsewhere: the edit wins
            if (current.action === "deleted" || meta.type === "folder" || current.type === "folder") {
                const stored = await this.store(path, meta, data);
                changes.push(path);
                return { result: RESULT.APPLIED, meta: stored };
            }

            // both changed the content: combine the edits when they don't overlap
            if (base && base.action === "created" && isMergeable(path)) {
                const baseText = await this.storage.findVersionBySha(path, base.sha1);
                const serverText = await this.storage.read(path);
                if (baseText != null && serverText != null) {
                    const merged = merge(baseText, data.toString("utf8"), serverText);
                    if (merged != null) {
                        const mergedData = Buffer.from(merged, "utf8");
                        const stored = await this.store(path, {
                            type: "file",
                            action: "created",
                            sha1: sha256(mergedData),
                            mtime: Math.max(Date.now(), current.mtime + 1, meta.mtime + 1),
                            path,
                            device: device.name
                        }, mergedData);
                        changes.push(path);
                        this.debug >= 2 && console.log("[SYNC] Combined edits:", path);
                        return { result: RESULT.MERGED, meta: stored };
                    }
                }
            }

            // keep both: the newer version keeps the name, the other one gets a second file
            const exists = (candidate) => this.isTaken(candidate) || candidate === path;
            if (meta.mtime > current.mtime) {
                const serverData = await this.storage.read(path, true);
                const copy = copyPath(path, current.device || "Another device", current.mtime, exists);
                const copyMeta = await this.storeCopy(copy, current, serverData);
                const stored = await this.store(path, meta, data);
                changes.push(path);
                if (copyMeta) changes.push(copy);
                return { result: RESULT.KEPT_BOTH, meta: stored, copy: copyMeta ? copy : null };
            }

            const copy = copyPath(path, device.name, meta.mtime, exists);
            const copyMeta = await this.storeCopy(copy, meta, data);
            if (copyMeta) changes.push(copy);
            return { result: RESULT.KEPT_BOTH, meta: current, copy: copyMeta ? copy : null };
        });

        this.debug >= 2 && console.log("[SYNC][" + device.name + "] " + result.result + ":", path);
        if (changes.length) {
            this.onChange(changes, device);
        }
        return result;
    }

    async storeCopy(copy, meta, data) {
        if (data == null) {
            return null;
        }
        return await this.storage.withLock(copy, async () => {
            return await this.store(copy, {
                type: "file",
                action: "created",
                sha1: sha256(data),
                mtime: meta.mtime,
                path: copy,
                device: meta.device
            }, data);
        });
    }

    /**
     * A rename that keeps history. `base` is the state of `from` the client renamed.
     * Anything unusual (from changed elsewhere, to taken) is answered with FALLBACK,
     * and the client deletes + creates instead.
     */
    async rename(from, to, base, device) {
        if (from === to) {
            return { result: RESULT.FALLBACK };
        }
        const result = await this.storage.withLock([from, to], async () => {
            const source = this.storage.index.get(from);
            const target = this.storage.index.get(to);
            if (!source || source.action === "deleted") {
                return { result: RESULT.FALLBACK };
            }
            if (!base || !sameState(source, { type: source.type, action: base.action, sha1: base.sha1 })) {
                return { result: RESULT.FALLBACK };
            }
            if (target && target.action !== "deleted") {
                return { result: RESULT.FALLBACK };
            }

            const moved = Object.assign({}, source, { path: to, device: device.name });
            delete moved.renamed_to;
            const tombstone = {
                type: source.type,
                action: "deleted",
                sha1: source.sha1 || null,
                mtime: Math.max(Date.now(), source.mtime + 1),
                path: from,
                renamed_to: to,
                device: device.name
            };

            let stored;
            if (source.type === "file") {
                stored = await this.storage.rename(from, to, tombstone, moved);
            } else {
                stored = {
                    moved: await this.storage.writeMetadata(to, moved),
                    left: await this.storage.writeMetadata(from, tombstone)
                };
            }
            return { result: RESULT.RENAMED, meta: stored.moved, tombstone: stored.left };
        });

        this.debug >= 2 && console.log("[SYNC][" + device.name + "] " + result.result + ":", from, "->", to);
        if (result.result === RESULT.RENAMED) {
            this.onChange([from, to], device);
        }
        return result;
    }

    async versions(path) {
        const meta = await this.storage.readMetadata(path);
        if (!meta) {
            return { deleted: false, data: [] };
        }
        const versions = await this.storage.iterateVersions(path);
        return {
            deleted: meta.action === "deleted",
            data: versions.map(v => v.timestamp)
        };
    }

    files(mode) {
        const files = [];
        for (const [path, meta] of this.storage.index) {
            if (meta.type !== "file") {
                continue;
            }
            const deleted = meta.action === "deleted";
            if ((mode === "deleted") === deleted) {
                files.push({ path, mtime: meta.mtime });
            }
        }
        return files;
    }
};

module.exports.RESULT = RESULT;
module.exports.sha256 = sha256;

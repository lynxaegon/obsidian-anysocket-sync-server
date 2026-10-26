// @ts-nocheck
const crypto = require("crypto");
const FSAdapter = require("./FSAdapter");

/**
 * Vault storage on disk, one folder per entry:
 *   <path>/metadata      the entry's current state (JSON)
 *   <path>/<mtime>       a version of the file's content
 *
 * All metadata is also kept in memory (loaded once on init), so syncing never
 * walks the disk. Every metadata change gets a sequence number, which is what
 * incremental sync asks for ("everything after seq N").
 */
module.exports = class Storage {
    constructor(root, options = {}) {
        this.fsVault = new FSAdapter(root);
        this.index = new Map();
        this.seq = 0;
        // changes per process; a client holding a cursor from another epoch does a full sync
        this.epoch = crypto.randomBytes(8).toString("hex");
        this.binaryVersions = options.binaryVersions == null ? 3 : options.binaryVersions;
        this.locks = new Map();
    }

    async init() {
        await this.fsVault.init();
        this.index.clear();
        const paths = await this.fsVault.iterate();
        for (const path of paths) {
            const metadata = await this.loadMetadata(path);
            if (metadata) {
                this.index.set(path, metadata);
            }
        }
        for (const metadata of this.index.values()) {
            if (metadata.seq > this.seq) {
                this.seq = metadata.seq;
            }
        }
        // entries written by 1.5.x have no sequence number; numbered in memory so a listing can be
        // paged (a restart changes the epoch, so clients list everything again anyway)
        for (const metadata of this.index.values()) {
            if (!metadata.seq) {
                metadata.seq = ++this.seq;
            }
        }
    }

    // sizes of entries written before 1.6.0, filled in after start without blocking it
    async fillSizes() {
        for (const [path, metadata] of this.index) {
            if (metadata.type === "file" && metadata.action === "created" && metadata.size == null) {
                const size = await this.fsVault.size(path + "/" + metadata.mtime);
                if (size != null && this.index.get(path) === metadata) {
                    metadata.size = size;
                }
            }
        }
    }

    // reads an entry's metadata from disk, rebuilding it from its newest version if it is corrupt
    async loadMetadata(path) {
        const raw = await this.fsVault.read(path + "/metadata");
        if (raw != null) {
            try {
                const metadata = JSON.parse(raw);
                if (metadata && typeof metadata === "object") {
                    return metadata;
                }
            } catch (e) {
                // fall through to the rebuild
            }
        }

        const versions = await this.fsVault.iterateVersions(path);
        let metadata;
        if (versions.length > 0) {
            const content = await this.fsVault.read(versions[0].path, true);
            metadata = {
                action: "created",
                type: "file",
                mtime: versions[0].timestamp,
                sha1: crypto.createHash("sha256").update(content).digest("hex"),
                path: path
            };
        } else if (await this.fsVault.hasChildren(path)) {
            metadata = {
                action: "created",
                type: "folder",
                mtime: Date.now(),
                path: path
            };
        } else {
            console.error("[Storage] Unreadable metadata, no versions to rebuild it from:", path);
            return null;
        }

        console.error("[Storage] Rebuilt corrupt metadata for:", path);
        await this.fsVault.write(path + "/metadata", JSON.stringify(metadata));
        return metadata;
    }

    // runs fn with exclusive access to the given paths
    async withLock(paths, fn) {
        paths = [...new Set(Array.isArray(paths) ? paths : [paths])].sort();
        const previous = paths.map(path => this.locks.get(path) || Promise.resolve());
        let release;
        const current = new Promise(resolve => release = resolve);
        const chained = Promise.all(previous).then(() => current);
        paths.forEach(path => this.locks.set(path, chained));

        await Promise.all(previous);
        try {
            return await fn();
        } finally {
            release();
            paths.forEach(path => {
                if (this.locks.get(path) === chained) {
                    this.locks.delete(path);
                }
            });
        }
    }

    async write(path, data, binary) {
        let metadata = await this.readMetadata(path);
        if (!metadata) {
            return null;
        }

        try {
            const result = await this.fsVault.write(path + "/" + metadata.mtime, data, binary);
            if (binary) {
                await this.pruneVersions(path, this.binaryVersions);
            }
            return result;
        } catch (e) {
            console.error("[Error] Storage.write (" + path + "/" + metadata.mtime + ")", e);
        }

        return null;
    }

    /**
     * Stores an entry: the content first (as the version named by metadata.mtime), then the
     * metadata, so a crash in between never leaves metadata pointing at content that is missing.
     */
    async storeEntry(path, metadata, data, binary) {
        if (metadata.type === "file" && metadata.action === "created") {
            if (data == null) {
                throw new Error("missing content for " + path);
            }
            await this.fsVault.write(path + "/" + metadata.mtime, data, binary);
        }
        const stored = await this.writeMetadata(path, metadata);
        if (binary && metadata.type === "file") {
            await this.pruneVersions(path, this.binaryVersions);
        }
        return stored;
    }

    // keeps the newest `keep` versions of an entry
    async pruneVersions(path, keep) {
        const versions = await this.fsVault.iterateVersions(path);
        for (const version of versions.slice(Math.max(keep, 1))) {
            await this.fsVault.delete(version.path);
        }
    }

    async read(path, binary = false) {
        let metadata = await this.readMetadata(path);
        if (!metadata || metadata.type == "folder") {
            return null;
        }

        try {
            return await this.fsVault.read(path + "/" + metadata.mtime, binary);
        } catch (e) {
            console.error("[Error] Storage.read (" + path + "/" + metadata.mtime + ")", e);
        }
        return null;
    }

    async readExact(path, binary) {
        return await this.fsVault.read(path, binary);
    }

    // removes an entry completely (cleanup); a path with children only loses its own files
    async delete(path) {
        if (await this.fsVault.hasChildren(path)) {
            const versions = await this.fsVault.iterateVersions(path);
            for (const version of versions) {
                await this.fsVault.delete(version.path);
            }
            await this.fsVault.delete(path + "/metadata");
        } else {
            await this.fsVault.delete(path);
        }
        this.index.delete(path);
    }

    // a single version file (cleanup)
    async deleteVersion(versionPath) {
        return await this.fsVault.delete(versionPath);
    }

    async exists(path) {
        return this.index.has(path);
    }

    async readMetadata(path) {
        return this.index.get(path) || null;
    }

    async writeMetadata(path, metadata) {
        metadata = Object.assign({}, metadata, { seq: ++this.seq });
        try {
            await this.fsVault.write(path + "/metadata", JSON.stringify(metadata));
            this.index.set(path, metadata);
        } catch (e) {
            console.error("[Error] Storage.writeMetadata (" + path + "/metadata)", e);
        }
        return metadata;
    }

    /**
     * Moves an entry's own files (versions and metadata, never its children) to a new path,
     * leaving a tombstone behind that points at the new path.
     */
    async rename(from, to, tombstone, metadata) {
        const versions = await this.fsVault.iterateVersions(from);
        await this.fsVault.mkdir(to);
        for (const version of versions) {
            const name = version.path.split("/").pop();
            await this.fsVault.rename(version.path, to + "/" + name);
        }
        const moved = await this.writeMetadata(to, metadata);
        const left = await this.writeMetadata(from, tombstone);
        return { moved, left };
    }

    async iterate() {
        return Array.from(this.index.keys());
    }

    // [path, metadata] pairs changed after `seq`, oldest change first
    changesSince(seq) {
        const result = [];
        for (const [path, metadata] of this.index) {
            if ((metadata.seq || 0) > seq) {
                result.push([path, metadata]);
            }
        }
        return result.sort((a, b) => (a[1].seq || 0) - (b[1].seq || 0));
    }

    async iterateVersions(path) {
        return await this.fsVault.iterateVersions(path);
    }

    // the content of the version whose sha256 matches, newest first
    async findVersionBySha(path, sha1, binary = false) {
        if (!sha1) {
            return null;
        }
        const versions = await this.fsVault.iterateVersions(path);
        for (const version of versions) {
            const content = await this.fsVault.read(version.path, true);
            if (content && crypto.createHash("sha256").update(content).digest("hex") === sha1) {
                return binary ? content : content.toString("utf8");
            }
        }
        return null;
    }
}

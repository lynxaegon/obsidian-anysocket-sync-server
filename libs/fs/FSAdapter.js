// @ts-nocheck
const fs = require("fs").promises;
const fsConstants = require("fs").constants;
const crypto = require("crypto");

// temp files live next to their target, so the rename is atomic; anything
// starting with "." is never a version or an entry
const TMP_PREFIX = ".tmp-";

module.exports = class FSAdapter {
    constructor(basePath) {
        this.basePath = basePath;
    }

    async init() {
        await fs.mkdir(this.basePath, {
            recursive: true
        });
    }

    async mkdir(path) {
        await fs.mkdir(this.basePath + path, {
            recursive: true
        });
    }

    // written to a temp file and renamed over the target, so a crash
    // never leaves a half-written file behind
    async write(path, data, binary) {
        let folder = path.split("/").slice(0, -1).join("/");
        if (folder) {
            await this.mkdir(folder);
        }

        const target = this.basePath + path;
        const tmp = this.basePath + (folder ? folder + "/" : "") + TMP_PREFIX + crypto.randomBytes(6).toString("hex");
        try {
            if (binary) {
                await fs.writeFile(tmp, data);
            } else {
                await fs.writeFile(tmp, data, "utf8");
            }
            await fs.rename(tmp, target);
        } catch (e) {
            await fs.rm(tmp, { force: true }).catch(() => {});
            throw e;
        }

        return data;
    }

    async read(path, binary) {
        try {
            if (binary) {
                return await fs.readFile(this.basePath + path);
            }
            return await fs.readFile(this.basePath + path, "utf8");
        } catch (e) {
            return null;
        }
    }

    async size(path) {
        try {
            return (await fs.stat(this.basePath + path)).size;
        } catch (e) {
            return null;
        }
    }

    async exists(path) {
        return fs.access(this.basePath + path, fsConstants.F_OK)
            .then(() => true)
            .catch(() => false)
    }

    async rename(oldPath, newPath) {
        let folder = newPath.split("/").slice(0, -1).join("/");
        if (folder) {
            await this.mkdir(folder);
        }
        await fs.rename(this.basePath + oldPath, this.basePath + newPath);
    }

    async delete(path) {
        return await fs.rm(this.basePath + path, {
            recursive: true,
            force: true
        });
    }

    // every entry (a folder holding a "metadata" file), relative to basePath
    async iterate(root) {
        root = root || this.basePath;
        const dirents = await fs.readdir(root, {withFileTypes: true});
        const files = await Promise.all(dirents.map(async (dirent) => {
            let _path = root + "/" + dirent.name;
            if (dirent.isDirectory()) {
                return await this.iterate(_path);
            } else if (dirent.name == "metadata") {
                return [root.replace(this.basePath + "/", "")];
            } else if (dirent.name.startsWith(TMP_PREFIX)) {
                // left over from a crash mid-write
                await fs.rm(_path, { force: true }).catch(() => {});
            }
            return [];
        }));
        return Array.prototype.concat(...files);
    }

    // version files of an entry (named by their mtime), newest first
    async iterateVersions(path) {
        let files;
        try {
            files = await fs.readdir(this.basePath + path, {withFileTypes: true});
        } catch (e) {
            return [];
        }
        let versions = [];
        for(let item of files) {
            if(item.isDirectory() || item.name == "metadata" || item.name.startsWith(".")) {
                continue;
            }
            const timestamp = parseInt(item.name);
            if(isNaN(timestamp) || String(timestamp) !== item.name) {
                continue;
            }
            versions.push({
                path: path + "/" + item.name,
                timestamp: timestamp
            });
        }
        return versions.sort((a, b) => {
            return b.timestamp - a.timestamp;
        });
    }

    // the subfolders of an entry, i.e. its children
    async hasChildren(path) {
        try {
            const items = await fs.readdir(this.basePath + path, {withFileTypes: true});
            return items.some(item => item.isDirectory());
        } catch (e) {
            return false;
        }
    }
}

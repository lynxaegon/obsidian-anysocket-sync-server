const { diff3Merge } = require("node-diff3");

// plain text we can safely combine line by line (not json, canvas, ...)
const MERGEABLE = ["md", "txt"];

function isMergeable(path) {
    const parts = path.split("/").pop().split(".");
    return parts.length > 1 && MERGEABLE.indexOf(parts.pop().toLowerCase()) !== -1;
}

/**
 * Combines two edits of the same text, made from a common base.
 * Returns the combined text, or null when both edits touch the same lines
 * (the caller then keeps both versions instead).
 */
function merge(base, ours, theirs) {
    if (ours === theirs) {
        return ours;
    }
    if (base === ours) {
        return theirs;
    }
    if (base === theirs) {
        return ours;
    }

    const regions = diff3Merge(ours.split("\n"), base.split("\n"), theirs.split("\n"));
    const lines = [];
    for (const region of regions) {
        if (region.conflict) {
            return null;
        }
        lines.push(...region.ok);
    }
    return lines.join("\n");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// characters Windows, macOS, Android or Obsidian links don't accept in a file name
const sanitize = (name) => String(name || "").replace(/[\\/:*?"<>|#^\[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);

/**
 * "Folder/Note (iPhone's version, Oct 26).md" - the name a kept second version gets.
 * `exists(path)` is used to pick a name that is not taken.
 */
function copyPath(path, deviceName, time, exists) {
    const slash = path.lastIndexOf("/");
    const folder = slash === -1 ? "" : path.slice(0, slash + 1);
    const file = path.slice(slash + 1);
    const dot = file.lastIndexOf(".");
    const stem = dot > 0 ? file.slice(0, dot) : file;
    const ext = dot > 0 ? file.slice(dot) : "";

    const date = new Date(time);
    const owner = sanitize(deviceName) || "Another device";
    const label = owner + "'s version, " + MONTHS[date.getMonth()] + " " + date.getDate();

    let candidate = folder + stem + " (" + label + ")" + ext;
    for (let n = 2; exists(candidate); n++) {
        candidate = folder + stem + " (" + label + " " + n + ")" + ext;
    }
    return candidate;
}

module.exports = { isMergeable, merge, copyPath, sanitize };

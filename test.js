/**
 * Comprehensive Test Suite for Obsidian AnySocket Sync Server
 * 
 * This test simulates clients and verifies:
 * - File creation, modification, deletion
 * - Rename operations (delete + create)
 * - Conflict resolution
 * - Multi-client synchronization
 * - Delete queue handling
 */

const fs = require('fs').promises;
const path = require('path');

// Test configuration
const TEST_DATA_DIR = path.join(__dirname, 'test-data');
const TEST_CONFIG = {
    app_dir: __dirname,
    data_dir: 'test-data',
    password: 'test-password-123',
    port: 3001,
    host: '127.0.0.1',
    logs: {
        level: 2
    },
    cleanup: {
        enabled: false
    }
};

// Test helpers
class TestHelper {
    constructor() {
        this.tests = [];
        this.passed = 0;
        this.failed = 0;
    }

    async test(name, fn) {
        try {
            console.log(`\n🧪 Testing: ${name}`);
            await fn();
            this.passed++;
            console.log(`✅ PASS: ${name}`);
        } catch (error) {
            this.failed++;
            console.error(`❌ FAIL: ${name}`);
            console.error(`   Error: ${error.message}`);
            console.error(`   Stack: ${error.stack}`);
        }
    }

    assert(condition, message) {
        if (!condition) {
            throw new Error(`Assertion failed: ${message}`);
        }
    }

    assertEquals(actual, expected, message) {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(
                `${message}\n` +
                `  Expected: ${JSON.stringify(expected)}\n` +
                `  Actual:   ${JSON.stringify(actual)}`
            );
        }
    }

    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    printSummary() {
        console.log('\n' + '='.repeat(60));
        console.log(`Test Summary: ${this.passed + this.failed} tests`);
        console.log(`✅ Passed: ${this.passed}`);
        console.log(`❌ Failed: ${this.failed}`);
        console.log('='.repeat(60));
        return this.failed === 0;
    }
}

// Mock peer for testing
class MockPeer {
    constructor(id, deviceName) {
        this.id = id;
        this.data = {
            id: deviceName,
            autoSync: true,
            syncing: false,
            files: {}
        };
        this.sentMessages = [];
    }

    async send(message) {
        this.sentMessages.push(message);
        return message;
    }

    clearMessages() {
        this.sentMessages = [];
    }

    getLastMessage(type) {
        for (let i = this.sentMessages.length - 1; i >= 0; i--) {
            if (this.sentMessages[i].type === type) {
                return this.sentMessages[i];
            }
        }
        return null;
    }

    getAllMessages(type) {
        return this.sentMessages.filter(m => m.type === type);
    }
}

// Main test runner
async function runTests() {
    const helper = new TestHelper();

    // Clean up test data directory
    try {
        await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
    } catch (e) {
        // Ignore if doesn't exist
    }

    await fs.mkdir(TEST_DATA_DIR, { recursive: true });
    await fs.mkdir(path.join(TEST_DATA_DIR, 'files'), { recursive: true });
    await fs.mkdir(path.join(TEST_DATA_DIR, 'db'), { recursive: true });

    // Initialize test environment
    global.XStorage = new (require('./libs/fs/Storage'))(path.join(TEST_DATA_DIR, 'files') + '/');
    global.XDB = new (require('./libs/DB'))(path.join(TEST_DATA_DIR, 'db'));
    
    await XStorage.init();

    const SyncServer = require('./libs/server');
    const server = new SyncServer(TEST_CONFIG);

    console.log('Starting Obsidian Sync Server Test Suite...\n');

    // Test 1: File Creation
    await helper.test('File Creation - Client sends new file', async () => {
        const peer = new MockPeer('client1', 'test-device-1');
        
        const fileData = {
            action: 'created',
            sha1: 'abc123hash',
            mtime: Date.now(),
            type: 'file',
            path: 'test-file.md'
        };

        const packet = { peer, msg: { type: 'file_event', data: fileData } };
        await server.onFileEvent(fileData, packet);

        // Verify server requested the file content
        const lastMessage = peer.getLastMessage('file_data');
        helper.assert(lastMessage, 'Server should request file content');
        helper.assertEquals(lastMessage.data.type, 'send', 'Should request file send');
        helper.assertEquals(lastMessage.data.path, 'test-file.md', 'Should request correct path');
    });

    // Test 2: File Upload
    await helper.test('File Upload - Client sends file content', async () => {
        const peer = new MockPeer('client1', 'test-device-1');
        
        const fileData = {
            type: 'apply',
            binary: false,
            data: 'Hello World!',
            path: 'test-file.md',
            metadata: {
                action: 'created',
                sha1: 'abc123hash',
                mtime: Date.now(),
                type: 'file'
            }
        };

        const packet = { peer, msg: { type: 'file_data', data: fileData } };
        await server.onFileData(fileData, packet);

        // Verify file was stored
        const storedContent = await XStorage.read('test-file.md');
        helper.assertEquals(storedContent, 'Hello World!', 'File content should be stored');

        const storedMetadata = await XStorage.readMetadata('test-file.md');
        helper.assert(storedMetadata, 'Metadata should be stored');
        helper.assertEquals(storedMetadata.action, 'created', 'Metadata action should be created');
    });

    // Test 3: File Deletion
    await helper.test('File Deletion - Client deletes file', async () => {
        const peer = new MockPeer('client1', 'test-device-1');
        
        const deleteData = {
            action: 'deleted',
            sha1: 'abc123hash',
            mtime: Date.now() + 1000,
            type: 'file',
            path: 'test-file.md'
        };

        const packet = { peer, msg: { type: 'file_event', data: deleteData } };
        await server.onFileEvent(deleteData, packet);

        // Verify metadata was updated
        const storedMetadata = await XStorage.readMetadata('test-file.md');
        helper.assertEquals(storedMetadata.action, 'deleted', 'Metadata should be marked as deleted');

        // Verify server didn't request file content for deletion
        const messages = peer.getAllMessages('file_data');
        const sendRequests = messages.filter(m => m.data && m.data.type === 'send');
        helper.assertEquals(sendRequests.length, 0, 'Should not request content for deletion');
    });

    // Test 4: File Rename (Delete + Create)
    await helper.test('File Rename - Delete old path, create new path', async () => {
        const peer = new MockPeer('client1', 'test-device-1');
        const now = Date.now();
        
        // First create a file
        await server.onFileData({
            type: 'apply',
            binary: false,
            data: 'Rename test content',
            path: 'old-name.md',
            metadata: {
                action: 'created',
                sha1: 'def456hash',
                mtime: now,
                type: 'file'
            }
        }, { peer });

        peer.clearMessages();

        // Step 1: Delete old path
        await server.onFileEvent({
            action: 'deleted',
            sha1: 'def456hash',
            mtime: now + 100,
            type: 'file',
            path: 'old-name.md'
        }, { peer });

        const oldMetadata = await XStorage.readMetadata('old-name.md');
        helper.assertEquals(oldMetadata.action, 'deleted', 'Old path should be marked as deleted');

        peer.clearMessages();

        // Step 2: Create new path
        await server.onFileEvent({
            action: 'created',
            sha1: 'def456hash',
            mtime: now + 200,
            type: 'file',
            path: 'new-name.md'
        }, { peer });

        // Server should request content
        const lastMessage = peer.getLastMessage('file_data');
        helper.assertEquals(lastMessage.data.type, 'send', 'Should request file content for new path');

        // Upload to new path
        await server.onFileData({
            type: 'apply',
            binary: false,
            data: 'Rename test content',
            path: 'new-name.md',
            metadata: {
                action: 'created',
                sha1: 'def456hash',
                mtime: now + 200,
                type: 'file'
            }
        }, { peer });

        const newContent = await XStorage.read('new-name.md');
        helper.assertEquals(newContent, 'Rename test content', 'Content should be at new path');
    });

    // Test 5: Multi-Client Sync
    await helper.test('Multi-Client Sync - Changes broadcast to other clients', async () => {
        const peer1 = new MockPeer('client1', 'device-1');
        const peer2 = new MockPeer('client2', 'device-2');
        
        // Add both peers to peerList (simulate connected clients)
        const peerListBackup = server.getPeerList();
        server.setPeerList([peer1, peer2]);

        const now = Date.now();

        // Client 1 uploads a file
        await server.onFileData({
            type: 'apply',
            binary: false,
            data: 'Multi-client test',
            path: 'shared-file.md',
            metadata: {
                action: 'created',
                sha1: 'shared123',
                mtime: now,
                type: 'file'
            }
        }, { peer: peer1 });

        // Check if Client 2 received the broadcast
        const broadcastMessage = peer2.getLastMessage('file_data');
        helper.assert(broadcastMessage, 'Client 2 should receive broadcast');
        helper.assertEquals(broadcastMessage.data.path, 'shared-file.md', 'Broadcast should contain correct path');
        helper.assertEquals(broadcastMessage.data.data, 'Multi-client test', 'Broadcast should contain file content');

        // Restore peerList
        server.setPeerList(peerListBackup);
    });

    // Test 6: Conflict Resolution - Client Newer
    await helper.test('Conflict Resolution - Client has newer version', async () => {
        const peer = new MockPeer('client1', 'test-device-1');
        const now = Date.now();
        
        // Server has old version
        await server.onFileData({
            type: 'apply',
            binary: false,
            data: 'Old content',
            path: 'conflict-file.md',
            metadata: {
                action: 'created',
                sha1: 'old123',
                mtime: now,
                type: 'file'
            }
        }, { peer });

        peer.clearMessages();

        // Client sends newer version
        const result = await server.onFileEvent({
            action: 'created',
            sha1: 'new456',
            mtime: now + 5000,  // Newer timestamp
            type: 'file',
            path: 'conflict-file.md'
        }, { peer });

        helper.assertEquals(result, 'client_newer', 'Should recognize client is newer');
        
        const lastMessage = peer.getLastMessage('file_data');
        helper.assertEquals(lastMessage.data.type, 'send', 'Should request newer version from client');
    });

    // Test 7: Conflict Resolution - Server Newer
    await helper.test('Conflict Resolution - Server has newer version', async () => {
        const peer = new MockPeer('client1', 'test-device-1');
        const now = Date.now();
        
        // Server has newer version
        await server.onFileData({
            type: 'apply',
            binary: false,
            data: 'Newer content',
            path: 'conflict-file-2.md',
            metadata: {
                action: 'created',
                sha1: 'newer123',
                mtime: now + 10000,
                type: 'file'
            }
        }, { peer });

        peer.clearMessages();

        // Client sends older version
        const result = await server.onFileEvent({
            action: 'created',
            sha1: 'older456',
            mtime: now,  // Older timestamp
            type: 'file',
            path: 'conflict-file-2.md'
        }, { peer });

        helper.assertEquals(result, 'server_newer', 'Should recognize server is newer');
        
        const lastMessage = peer.getLastMessage('file_data');
        helper.assertEquals(lastMessage.data.type, 'apply', 'Should send server version to client');
        helper.assertEquals(lastMessage.data.data, 'Newer content', 'Should send correct content');
    });

    // Test 8: Binary File Handling
    await helper.test('Binary File Handling', async () => {
        const peer = new MockPeer('client1', 'test-device-1');
        
        const binaryData = Buffer.from([0x89, 0x50, 0x4E, 0x47]); // PNG header
        
        await server.onFileData({
            type: 'apply',
            binary: true,
            data: binaryData,
            path: 'test-image.png',
            metadata: {
                action: 'created',
                sha1: 'binary123',
                mtime: Date.now(),
                type: 'file'
            }
        }, { peer });

        const storedBinary = await XStorage.read('test-image.png', true);
        helper.assert(Buffer.isBuffer(storedBinary), 'Should store binary data');
        helper.assertEquals(storedBinary.length, 4, 'Binary data length should match');
    });

    // Test 9: Delete Queue - SHA1 Preservation
    await helper.test('Delete Queue - SHA1 is preserved in deletion', async () => {
        const peer = new MockPeer('client1', 'test-device-1');
        const now = Date.now();
        
        // Create file first
        await server.onFileData({
            type: 'apply',
            binary: false,
            data: 'Delete me',
            path: 'to-delete.md',
            metadata: {
                action: 'created',
                sha1: 'delete123hash',
                mtime: now,
                type: 'file'
            }
        }, { peer });

        // Delete with preserved SHA1
        await server.onFileEvent({
            action: 'deleted',
            sha1: 'delete123hash',  // SHA1 should be preserved
            mtime: now + 1000,
            type: 'file',
            path: 'to-delete.md'
        }, { peer });

        const metadata = await XStorage.readMetadata('to-delete.md');
        helper.assertEquals(metadata.sha1, 'delete123hash', 'SHA1 should be preserved in deletion');
        helper.assertEquals(metadata.action, 'deleted', 'Action should be deleted');
    });

    // Test 10: No Change Detection
    await helper.test('No Change Detection - Same metadata ignored', async () => {
        const peer = new MockPeer('client1', 'test-device-1');
        const now = Date.now();
        const sha1 = 'same123hash';
        
        // Create file
        await server.onFileData({
            type: 'apply',
            binary: false,
            data: 'Same content',
            path: 'no-change.md',
            metadata: {
                action: 'created',
                sha1: sha1,
                mtime: now,
                type: 'file'
            }
        }, { peer });

        peer.clearMessages();

        // Send same metadata again
        const result = await server.onFileEvent({
            action: 'created',
            sha1: sha1,
            mtime: now,
            type: 'file',
            path: 'no-change.md'
        }, { peer });

        helper.assertEquals(result, null, 'Should return null for no change');
        helper.assertEquals(peer.sentMessages.length, 0, 'Should not send any messages');
    });

    // Test 11: Conflict - Same Timestamp, Different Content
    await helper.test('Conflict Resolution - Same timestamp, different SHA1 (server wins by default)', async () => {
        const peer = new MockPeer('client1', 'test-device-1');
        const timestamp = Date.now();
        
        // Server has version A
        await server.onFileData({
            type: 'apply',
            binary: false,
            data: 'Server version A',
            path: 'same-time-conflict.md',
            metadata: {
                action: 'created',
                sha1: 'serverHashA',
                mtime: timestamp,
                type: 'file'
            }
        }, { peer });

        peer.clearMessages();

        // Client sends version B with SAME timestamp
        const result = await server.onFileEvent({
            action: 'created',
            sha1: 'clientHashB',
            mtime: timestamp,  // Same timestamp!
            type: 'file',
            path: 'same-time-conflict.md'
        }, { peer });

        // When timestamps are equal, server doesn't update (returns 0)
        helper.assertEquals(result, null, 'Should return null when timestamps equal');
        
        // Verify server kept its version
        const storedMetadata = await XStorage.readMetadata('same-time-conflict.md');
        helper.assertEquals(storedMetadata.sha1, 'serverHashA', 'Server should keep its version');
    });

    // Test 12: Conflict - Create after Delete
    await helper.test('Conflict Resolution - Create after delete (resurrection)', async () => {
        const peer = new MockPeer('client1', 'test-device-1');
        const now = Date.now();
        
        // Create file
        await server.onFileData({
            type: 'apply',
            binary: false,
            data: 'Original content',
            path: 'resurrect.md',
            metadata: {
                action: 'created',
                sha1: 'original123',
                mtime: now,
                type: 'file'
            }
        }, { peer });

        // Delete it
        await server.onFileEvent({
            action: 'deleted',
            sha1: 'original123',
            mtime: now + 1000,
            type: 'file',
            path: 'resurrect.md'
        }, { peer });

        const deletedMetadata = await XStorage.readMetadata('resurrect.md');
        helper.assertEquals(deletedMetadata.action, 'deleted', 'Should be marked as deleted');

        peer.clearMessages();

        // Resurrect with newer timestamp
        const result = await server.onFileEvent({
            action: 'created',
            sha1: 'resurrected456',
            mtime: now + 2000,
            type: 'file',
            path: 'resurrect.md'
        }, { peer });

        helper.assertEquals(result, 'client_newer', 'Should accept resurrection');
        
        // Should request the new content
        const lastMessage = peer.getLastMessage('file_data');
        helper.assertEquals(lastMessage.data.type, 'send', 'Should request resurrected file');
    });

    // Test 13: Conflict - Delete vs Modify
    await helper.test('Conflict Resolution - Delete vs Modify (newer wins)', async () => {
        const peer1 = new MockPeer('client1', 'device-1');
        const peer2 = new MockPeer('client2', 'device-2');
        const now = Date.now();
        
        server.setPeerList([peer1, peer2]);

        // Create file
        await server.onFileData({
            type: 'apply',
            binary: false,
            data: 'Initial content',
            path: 'delete-vs-modify.md',
            metadata: {
                action: 'created',
                sha1: 'initial123',
                mtime: now,
                type: 'file'
            }
        }, { peer: peer1 });

        // Client 1 modifies (older timestamp)
        await server.onFileEvent({
            action: 'created',
            sha1: 'modified456',
            mtime: now + 1000,
            type: 'file',
            path: 'delete-vs-modify.md'
        }, { peer: peer1 });

        // Client 2 deletes (newer timestamp)
        await server.onFileEvent({
            action: 'deleted',
            sha1: 'initial123',
            mtime: now + 2000,  // Newer!
            type: 'file',
            path: 'delete-vs-modify.md'
        }, { peer: peer2 });

        const finalMetadata = await XStorage.readMetadata('delete-vs-modify.md');
        helper.assertEquals(finalMetadata.action, 'deleted', 'Newer delete should win');
        helper.assert(finalMetadata.mtime >= now + 2000, 'Should have newer timestamp');

        server.setPeerList([]);
    });

    // Test 14: Conflict - Rapid Sequential Changes
    await helper.test('Conflict Resolution - Rapid sequential modifications', async () => {
        const peer = new MockPeer('client1', 'test-device-1');
        let timestamp = Date.now();
        
        // Initial version
        await server.onFileData({
            type: 'apply',
            binary: false,
            data: 'Version 1',
            path: 'rapid-changes.md',
            metadata: {
                action: 'created',
                sha1: 'v1hash',
                mtime: timestamp,
                type: 'file'
            }
        }, { peer });

        // Rapid updates
        for (let i = 2; i <= 5; i++) {
            timestamp += 100;
            await server.onFileEvent({
                action: 'created',
                sha1: `v${i}hash`,
                mtime: timestamp,
                type: 'file',
                path: 'rapid-changes.md'
            }, { peer });

            peer.clearMessages();

            await server.onFileData({
                type: 'apply',
                binary: false,
                data: `Version ${i}`,
                path: 'rapid-changes.md',
                metadata: {
                    action: 'created',
                    sha1: `v${i}hash`,
                    mtime: timestamp,
                    type: 'file'
                }
            }, { peer });
        }

        // Verify latest version is stored
        const content = await XStorage.read('rapid-changes.md');
        helper.assertEquals(content, 'Version 5', 'Should have latest version');
        
        const metadata = await XStorage.readMetadata('rapid-changes.md');
        helper.assertEquals(metadata.sha1, 'v5hash', 'Should have latest SHA1');
    });

    // Test 15: Conflict - Delete with Wrong SHA1
    await helper.test('Conflict Resolution - Delete with mismatched SHA1', async () => {
        const peer = new MockPeer('client1', 'test-device-1');
        const now = Date.now();
        
        // Server has version A
        await server.onFileData({
            type: 'apply',
            binary: false,
            data: 'Version A',
            path: 'sha1-mismatch.md',
            metadata: {
                action: 'created',
                sha1: 'correctHashA',
                mtime: now,
                type: 'file'
            }
        }, { peer });

        // Client tries to delete with wrong SHA1 but newer timestamp
        const result = await server.onFileEvent({
            action: 'deleted',
            sha1: 'wrongHashB',  // Different SHA1
            mtime: now + 1000,
            type: 'file',
            path: 'sha1-mismatch.md'
        }, { peer });

        // Should still accept the deletion (timestamp is newer)
        helper.assertEquals(result, 'client_newer', 'Should accept deletion despite SHA1 mismatch');
        
        const metadata = await XStorage.readMetadata('sha1-mismatch.md');
        helper.assertEquals(metadata.action, 'deleted', 'Should be deleted');
    });

    // Test 16: Conflict - Multiple Clients Racing
    await helper.test('Conflict Resolution - Multiple clients updating simultaneously', async () => {
        const peer1 = new MockPeer('client1', 'device-1');
        const peer2 = new MockPeer('client2', 'device-2');
        const peer3 = new MockPeer('client3', 'device-3');
        const baseTime = Date.now();
        
        server.setPeerList([peer1, peer2, peer3]);

        // All clients start with same file
        await server.onFileData({
            type: 'apply',
            binary: false,
            data: 'Base version',
            path: 'race-condition.md',
            metadata: {
                action: 'created',
                sha1: 'baseHash',
                mtime: baseTime,
                type: 'file'
            }
        }, { peer: peer1 });

        // Client 1 updates (early)
        await server.onFileEvent({
            action: 'created',
            sha1: 'client1Hash',
            mtime: baseTime + 100,
            type: 'file',
            path: 'race-condition.md'
        }, { peer: peer1 });

        // Client 2 updates (middle)
        await server.onFileEvent({
            action: 'created',
            sha1: 'client2Hash',
            mtime: baseTime + 200,
            type: 'file',
            path: 'race-condition.md'
        }, { peer: peer2 });

        // Client 3 updates (latest)
        await server.onFileEvent({
            action: 'created',
            sha1: 'client3Hash',
            mtime: baseTime + 300,
            type: 'file',
            path: 'race-condition.md'
        }, { peer: peer3 });

        // Last update should win
        await server.onFileData({
            type: 'apply',
            binary: false,
            data: 'Client 3 version',
            path: 'race-condition.md',
            metadata: {
                action: 'created',
                sha1: 'client3Hash',
                mtime: baseTime + 300,
                type: 'file'
            }
        }, { peer: peer3 });

        const content = await XStorage.read('race-condition.md');
        helper.assertEquals(content, 'Client 3 version', 'Latest update should win');

        server.setPeerList([]);
    });

    // Test 17: Conflict - Old Client Sends Stale Update
    await helper.test('Conflict Resolution - Old client with stale data rejected', async () => {
        const peer = new MockPeer('client1', 'test-device-1');
        const now = Date.now();
        
        // Server has newer version
        await server.onFileData({
            type: 'apply',
            binary: false,
            data: 'Newest version',
            path: 'stale-update.md',
            metadata: {
                action: 'created',
                sha1: 'newestHash',
                mtime: now + 10000,
                type: 'file'
            }
        }, { peer });

        peer.clearMessages();

        // Old client sends ancient update
        const result = await server.onFileEvent({
            action: 'created',
            sha1: 'oldHash',
            mtime: now - 50000,  // Much older!
            type: 'file',
            path: 'stale-update.md'
        }, { peer });

        helper.assertEquals(result, 'server_newer', 'Server should reject stale update');
        
        // Should send server version to client
        const lastMessage = peer.getLastMessage('file_data');
        helper.assertEquals(lastMessage.data.type, 'apply', 'Should send server version');
        helper.assertEquals(lastMessage.data.data, 'Newest version', 'Should send current content');
    });

    // Test 18: Conflict - Rename During Modification
    await helper.test('Conflict Resolution - Rename while another client modifies', async () => {
        const peer1 = new MockPeer('client1', 'device-1');
        const peer2 = new MockPeer('client2', 'device-2');
        const now = Date.now();
        
        server.setPeerList([peer1, peer2]);

        // Initial file
        await server.onFileData({
            type: 'apply',
            binary: false,
            data: 'Original content',
            path: 'rename-vs-modify.md',
            metadata: {
                action: 'created',
                sha1: 'originalHash',
                mtime: now,
                type: 'file'
            }
        }, { peer: peer1 });

        // Client 1 renames (delete old path)
        await server.onFileEvent({
            action: 'deleted',
            sha1: 'originalHash',
            mtime: now + 1000,
            type: 'file',
            path: 'rename-vs-modify.md'
        }, { peer: peer1 });

        // Client 2 tries to modify old path (older timestamp)
        const result = await server.onFileEvent({
            action: 'created',
            sha1: 'modifiedHash',
            mtime: now + 500,  // Older than delete!
            type: 'file',
            path: 'rename-vs-modify.md'
        }, { peer: peer2 });

        // Server should tell client2 that file is deleted
        helper.assertEquals(result, 'server_newer', 'Server should inform about deletion');

        server.setPeerList([]);
    });

    // Test 19: Conflict - Binary vs Text File
    await helper.test('Conflict Resolution - Binary file conflict', async () => {
        const peer = new MockPeer('client1', 'test-device-1');
        const now = Date.now();
        
        const binaryV1 = Buffer.from([0x01, 0x02, 0x03]);
        const binaryV2 = Buffer.from([0x04, 0x05, 0x06]);

        // Version 1
        await server.onFileData({
            type: 'apply',
            binary: true,
            data: binaryV1,
            path: 'binary-conflict.bin',
            metadata: {
                action: 'created',
                sha1: 'binaryV1Hash',
                mtime: now,
                type: 'file'
            }
        }, { peer });

        peer.clearMessages();

        // Client has newer version
        await server.onFileEvent({
            action: 'created',
            sha1: 'binaryV2Hash',
            mtime: now + 1000,
            type: 'file',
            path: 'binary-conflict.bin'
        }, { peer });

        helper.assertEquals(peer.getLastMessage('file_data').data.type, 'send', 'Should request newer binary');

        // Upload newer version
        await server.onFileData({
            type: 'apply',
            binary: true,
            data: binaryV2,
            path: 'binary-conflict.bin',
            metadata: {
                action: 'created',
                sha1: 'binaryV2Hash',
                mtime: now + 1000,
                type: 'file'
            }
        }, { peer });

        const stored = await XStorage.read('binary-conflict.bin', true);
        helper.assert(Buffer.isBuffer(stored), 'Should store binary');
        helper.assertEquals(stored.length, 3, 'Should have correct binary length');
    });

    // Test 20: Conflict - Null SHA1 Handling
    await helper.test('Conflict Resolution - Null SHA1 in delete event', async () => {
        const peer = new MockPeer('client1', 'test-device-1');
        const now = Date.now();
        
        // Create file
        await server.onFileData({
            type: 'apply',
            binary: false,
            data: 'To be deleted',
            path: 'null-sha1.md',
            metadata: {
                action: 'created',
                sha1: 'existingHash',
                mtime: now,
                type: 'file'
            }
        }, { peer });

        // Delete with null SHA1 (edge case from old client or metadata loss)
        await server.onFileEvent({
            action: 'deleted',
            sha1: null,  // Null SHA1
            mtime: now + 1000,
            type: 'file',
            path: 'null-sha1.md'
        }, { peer });

        const metadata = await XStorage.readMetadata('null-sha1.md');
        helper.assertEquals(metadata.action, 'deleted', 'Should still process deletion');
        // SHA1 can be null for deletions
    });

    // Test 21: Conflict - Client A deletes, Client B creates (delete wins - newer)
    await helper.test('Conflict Resolution - Delete vs Create (delete newer, delete wins)', async () => {
        const peerA = new MockPeer('clientA', 'device-A');
        const peerB = new MockPeer('clientB', 'device-B');
        const now = Date.now();
        
        server.setPeerList([peerA, peerB]);

        // Both clients start with the same file
        await server.onFileData({
            type: 'apply',
            binary: false,
            data: 'Original content',
            path: 'delete-vs-create-1.md',
            metadata: {
                action: 'created',
                sha1: 'originalHash',
                mtime: now,
                type: 'file'
            }
        }, { peer: peerA });

        peerA.clearMessages();
        peerB.clearMessages();

        // Client B creates new version (older timestamp)
        await server.onFileEvent({
            action: 'created',
            sha1: 'clientBNewHash',
            mtime: now + 1000,  // Earlier
            type: 'file',
            path: 'delete-vs-create-1.md'
        }, { peer: peerB });

        await server.onFileData({
            type: 'apply',
            binary: false,
            data: 'Client B new content',
            path: 'delete-vs-create-1.md',
            metadata: {
                action: 'created',
                sha1: 'clientBNewHash',
                mtime: now + 1000,
                type: 'file'
            }
        }, { peer: peerB });

        // Client A deletes (newer timestamp - should win)
        await server.onFileEvent({
            action: 'deleted',
            sha1: 'originalHash',
            mtime: now + 2000,  // Later - should win!
            type: 'file',
            path: 'delete-vs-create-1.md'
        }, { peer: peerA });

        // Verify delete won (last write wins)
        const metadata = await XStorage.readMetadata('delete-vs-create-1.md');
        helper.assertEquals(metadata.action, 'deleted', 'Delete should win (newer timestamp)');
        helper.assertEquals(metadata.mtime, now + 2000, 'Should have delete timestamp');

        // Verify peerB was notified of the deletion
        const deletionNotification = peerB.sentMessages.find(m => 
            m.type === 'file_data' && 
            m.data.path === 'delete-vs-create-1.md' &&
            m.data.metadata?.action === 'deleted'
        );
        helper.assert(deletionNotification, 'Client B should be notified of deletion');

        server.setPeerList([]);
    });

    // Test 22: Conflict - Client A deletes, Client B creates (create wins - newer)
    await helper.test('Conflict Resolution - Delete vs Create (create newer, create wins)', async () => {
        const peerA = new MockPeer('clientA', 'device-A');
        const peerB = new MockPeer('clientB', 'device-B');
        const now = Date.now();
        
        server.setPeerList([peerA, peerB]);

        // Both clients start with the same file
        await server.onFileData({
            type: 'apply',
            binary: false,
            data: 'Original content',
            path: 'delete-vs-create-2.md',
            metadata: {
                action: 'created',
                sha1: 'originalHash',
                mtime: now,
                type: 'file'
            }
        }, { peer: peerA });

        peerA.clearMessages();
        peerB.clearMessages();

        // Client A deletes (older timestamp)
        await server.onFileEvent({
            action: 'deleted',
            sha1: 'originalHash',
            mtime: now + 1000,  // Earlier
            type: 'file',
            path: 'delete-vs-create-2.md'
        }, { peer: peerA });

        // Verify deletion is recorded
        let metadata = await XStorage.readMetadata('delete-vs-create-2.md');
        helper.assertEquals(metadata.action, 'deleted', 'File should be deleted first');

        // Client B creates new version (newer timestamp - should win)
        const resultB = await server.onFileEvent({
            action: 'created',
            sha1: 'clientBNewHash',
            mtime: now + 2000,  // Later - should win!
            type: 'file',
            path: 'delete-vs-create-2.md'
        }, { peer: peerB });

        helper.assertEquals(resultB, 'client_newer', 'Create should be accepted (newer timestamp)');

        // Server should request the new content
        const sendRequest = peerB.getLastMessage('file_data');
        helper.assertEquals(sendRequest.data.type, 'send', 'Server should request new content');

        // Client B sends content
        await server.onFileData({
            type: 'apply',
            binary: false,
            data: 'Client B new content',
            path: 'delete-vs-create-2.md',
            metadata: {
                action: 'created',
                sha1: 'clientBNewHash',
                mtime: now + 2000,
                type: 'file'
            }
        }, { peer: peerB });

        // Verify create won (last write wins)
        metadata = await XStorage.readMetadata('delete-vs-create-2.md');
        helper.assertEquals(metadata.action, 'created', 'Create should win (newer timestamp)');
        helper.assertEquals(metadata.sha1, 'clientBNewHash', 'Should have new SHA1');
        helper.assertEquals(metadata.mtime, now + 2000, 'Should have create timestamp');

        // Verify content exists
        const content = await XStorage.read('delete-vs-create-2.md');
        helper.assertEquals(content, 'Client B new content', 'File should exist with new content');

        // Verify peerA was notified of the recreation
        const createNotification = peerA.sentMessages.find(m => 
            m.type === 'file_data' && 
            m.data.path === 'delete-vs-create-2.md' &&
            m.data.metadata?.action === 'created'
        );
        helper.assert(createNotification, 'Client A should be notified of recreation');

        server.setPeerList([]);
    });

    // Test 23: Conflict - Simultaneous delete and create (same timestamp)
    await helper.test('Conflict Resolution - Delete vs Create (same timestamp)', async () => {
        const peerA = new MockPeer('clientA', 'device-A');
        const peerB = new MockPeer('clientB', 'device-B');
        const now = Date.now();
        const sameTimestamp = now + 1000;
        
        server.setPeerList([peerA, peerB]);

        // Both clients start with the same file
        await server.onFileData({
            type: 'apply',
            binary: false,
            data: 'Original content',
            path: 'delete-vs-create-3.md',
            metadata: {
                action: 'created',
                sha1: 'originalHash',
                mtime: now,
                type: 'file'
            }
        }, { peer: peerA });

        peerA.clearMessages();
        peerB.clearMessages();

        // Client A deletes (exact same timestamp)
        await server.onFileEvent({
            action: 'deleted',
            sha1: 'originalHash',
            mtime: sameTimestamp,
            type: 'file',
            path: 'delete-vs-create-3.md'
        }, { peer: peerA });

        const deleteMetadata = await XStorage.readMetadata('delete-vs-create-3.md');
        helper.assertEquals(deleteMetadata.action, 'deleted', 'Should be deleted');

        // Client B creates with exact same timestamp
        const resultB = await server.onFileEvent({
            action: 'created',
            sha1: 'clientBNewHash',
            mtime: sameTimestamp,  // Same timestamp!
            type: 'file',
            path: 'delete-vs-create-3.md'
        }, { peer: peerB });

        // When timestamps are equal, server keeps its current state
        // Since delete came first, it should remain deleted
        helper.assertEquals(resultB, null, 'Should return null for equal timestamp');

        const finalMetadata = await XStorage.readMetadata('delete-vs-create-3.md');
        helper.assertEquals(finalMetadata.action, 'deleted', 'Delete should remain (came first with same timestamp)');

        server.setPeerList([]);
    });

    // Test 24: Client Bug - Delete then recreate same file (create should win)
    await helper.test('Client Bug Fix - Delete then recreate same file path', async () => {
        const peer = new MockPeer('client1', 'test-device-1');
        const now = Date.now();
        
        // Create initial file
        await server.onFileData({
            type: 'apply',
            binary: false,
            data: 'First version',
            path: 'recreate-test.md',
            metadata: {
                action: 'created',
                sha1: 'firstHash',
                mtime: now,
                type: 'file'
            }
        }, { peer });

        // User deletes the file
        await server.onFileEvent({
            action: 'deleted',
            sha1: 'firstHash',
            mtime: now + 1000,
            type: 'file',
            path: 'recreate-test.md'
        }, { peer });

        let metadata = await XStorage.readMetadata('recreate-test.md');
        helper.assertEquals(metadata.action, 'deleted', 'File should be deleted');

        peer.clearMessages();

        // User creates a NEW file with the SAME path (newer timestamp)
        await server.onFileEvent({
            action: 'created',
            sha1: 'secondHash',
            mtime: now + 2000,  // Newer than deletion
            type: 'file',
            path: 'recreate-test.md'
        }, { peer });

        helper.assertEquals(peer.getLastMessage('file_data').data.type, 'send', 'Server should request new file');

        // Send the new file content
        await server.onFileData({
            type: 'apply',
            binary: false,
            data: 'Second version - completely new file',
            path: 'recreate-test.md',
            metadata: {
                action: 'created',
                sha1: 'secondHash',
                mtime: now + 2000,
                type: 'file'
            }
        }, { peer });

        // Verify the new file exists (not deleted)
        metadata = await XStorage.readMetadata('recreate-test.md');
        helper.assertEquals(metadata.action, 'created', 'File should be created (not deleted)');
        helper.assertEquals(metadata.sha1, 'secondHash', 'Should have new file SHA1');

        const content = await XStorage.read('recreate-test.md');
        helper.assertEquals(content, 'Second version - completely new file', 'Should have new content');
    });

    // Clean up
    try {
        await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
    } catch (e) {
        console.error('Cleanup error:', e);
    }

    // Print summary
    const success = helper.printSummary();
    process.exit(success ? 0 : 1);
}

// Run tests
runTests().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});


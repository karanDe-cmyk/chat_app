const express = require('express');
const { createServer } = require('node:http');
const { join } = require('node:path');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { availableParallelism } = require('node:os');
const cluster = require('node:cluster');
const { createAdapter, setupPrimary } = require('@socket.io/cluster-adapter');

if (cluster.isPrimary) {
    const numCPUs = availableParallelism();
    // Create one worker per available core
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork({
            PORT: 3000 + i
        });
    }

    // Set up the adapter on the primary thread
    setupPrimary();
    return;
}

async function main() {
    // Open the database file
    const db = await open({
        filename: 'chat.db',
        driver: sqlite3.Database
    });

    // Create the 'messages' table if it doesn't exist
    await db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_offset TEXT UNIQUE,
            content TEXT
        );
    `);

    const app = express();
    const server = createServer(app);
    const io = new Server(server, {
        connectionStateRecovery: {},
        adapter: createAdapter()
    });

    app.get('/', (req, res) => {
        res.sendFile(join(__dirname, 'index.html'));
    });

    app.use('/assets', express.static('assets'));

    io.on('connection', async (socket) => {
        console.log('User connected:', socket.id);

        // Join room
        socket.on('joinRoom', async (roomName) => {
            socket.join(roomName);
            console.log(`User ${socket.id} joined room: ${roomName}`);
        
            // Optional: delete all messages for a fresh chat (only for new room sessions)
            try {
                await db.run('DELETE FROM messages');
                console.log(`Cleared message history for room: ${roomName}`);
            } catch (e) {
                console.error('Error clearing chat history:', e);
            }
        });

        // Chat message handling
        socket.on('chat message', async ({ room, msg }, clientOffset, callback = () => { }) => {
            let result;
            try {
                result = await db.run(
                    'INSERT INTO messages (content, client_offset) VALUES (?, ?)',
                    msg,
                    clientOffset
                );
            } catch (e) {
                if (e.code === 'SQLITE_CONSTRAINT') {
                    // Message already stored, call callback anyway
                    return callback();
                } else {
                    console.error('DB error:', e);
                    return;
                }
            }

            socket.to(room).emit('chat message', msg, result.lastID);
            callback();
        });

        // On reconnection: replay missing messages
        if (!socket.recovered) {
            const offset = socket.handshake.auth.serverOffset || 0;
            try {
                await db.each(
                    'SELECT id, content FROM messages WHERE id > ?',
                    [offset],
                    (_err, row) => {
                        socket.emit('chat message', row.content, row.id);
                    }
                );
            } catch (e) {
                console.error('Replay error:', e);
            }
        }
    });

    const port = process.env.PORT || 3001;
    server.listen(port, '0.0.0.0', () => {
        console.log(`Server running at http://192.168.31.1:${port}`);
    });
}

main();

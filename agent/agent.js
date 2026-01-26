const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const { TextEncoder } = require('util');
const express = require('express');
const http = require('http');

// Configuration
const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://127.0.0.1:18789';
const HQ_PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// --- Setup Express & HTTP Server ---
const app = express();
const server = http.createServer(app);

// Serve Static UI
app.use(express.static(path.join(__dirname, '../web-ui')));

// Helper: Verify Solana Signature
function verifySolanaSignature(publicKeyStr, signatureStr, messageStr) {
    try {
        const decode = bs58.decode || bs58.default.decode;
        const publicKey = decode(publicKeyStr);
        // Expecting Hex signature now for reliability
        const signature = new Uint8Array(Buffer.from(signatureStr, 'hex'));
        const message = new TextEncoder().encode(messageStr);

        return nacl.sign.detached.verify(message, signature, publicKey);
    } catch (e) {
        console.error("Signature verification failed:", e);
        return false;
    }
}

// State
let users = {};
let todosCache = {}; // username -> array
let linkCodes = {}; // code -> { username, expires }

function saveUsers() {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// Load Users
if (fs.existsSync(USERS_FILE)) {
    try {
        users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        console.log(`Loaded ${Object.keys(users).length} users.`);
    } catch (e) {
        console.error("Error loading users:", e);
    }
}

// Helper: Get Todos for User
function getTodos(username) {
    if (todosCache[username]) return todosCache[username];

    const file = path.join(DATA_DIR, `todos_${username}.json`);
    if (fs.existsSync(file)) {
        try {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            todosCache[username] = data;
            return data;
        } catch (e) { console.error(`Error loading todos for ${username}`, e); }
    }

    // Default empty
    todosCache[username] = [];
    return todosCache[username];
}

function saveTodos(username) {
    if (!todosCache[username]) return;
    const file = path.join(DATA_DIR, `todos_${username}.json`);
    fs.writeFileSync(file, JSON.stringify(todosCache[username], null, 2));
}

function getUserByTelegramId(tid) {
    for (const [username, data] of Object.entries(users)) {
        if (data.telegramId === tid) return username;
    }
    return null;
}

// --- Headquarters Server (for Web UI) ---
const hqServer = new WebSocket.Server({ server });

hqServer.on('connection', (ws) => {
    console.log('Web Client connected (unauthenticated)');
    ws.isAlive = true;
    ws.username = null; // Stores Wallet Address

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            // 1. Auth Handshake (Solana)
            if (data.type === 'LOGIN') {
                const { publicKey, signature, message: msgAuth } = data;

                // Verify Signature
                if (verifySolanaSignature(publicKey, signature, msgAuth)) {
                    ws.username = publicKey; // Use Wallet as Username
                    console.log(`Wallet logged in: ${publicKey}`);

                    // Auto-register if new (optional, or just load empty)
                    // For now, we allow any valid signature to Login and have a private list

                    // Send success + initial state
                    ws.send(JSON.stringify({
                        type: 'LOGIN_SUCCESS',
                        username: publicKey,
                        todos: getTodos(publicKey)
                    }));
                } else {
                    ws.send(JSON.stringify({ type: 'LOGIN_FAIL', message: "Invalid Signature" }));
                }
                return;
            }

            // Require Auth for other actions
            if (!ws.username) return;

            if (data.type === 'GENERATE_LINK_CODE') {
                // Generate 6 digit code
                const code = Math.floor(100000 + Math.random() * 900000).toString();
                linkCodes[code] = {
                    username: ws.username,
                    expires: Date.now() + 5 * 60 * 1000 // 5 mins
                };

                // Cleanup old codes
                for (const c in linkCodes) {
                    if (linkCodes[c].expires < Date.now()) delete linkCodes[c];
                }

                ws.send(JSON.stringify({ type: 'LINK_CODE', code }));
            } else if (data.type === 'ADD_TODO') {
                const todo = { id: Date.now(), text: data.text, done: false };
                getTodos(ws.username).push(todo);
                saveTodos(ws.username);
                broadcastState(ws.username);
            } else if (data.type === 'TOGGLE_TODO') {
                const list = getTodos(ws.username);
                const todo = list.find(t => t.id === data.id);
                if (todo) {
                    todo.done = !todo.done;
                    saveTodos(ws.username);
                    broadcastState(ws.username);
                }
            } else if (data.type === 'GET_TODOS') {
                ws.send(JSON.stringify({ type: 'STATE_UPDATE', todos: getTodos(ws.username) }));
            } else if (data.type === 'SEND_CHAT') {
                // Forward to Gateway (if connected)
                // We construct a payload the gateway keyer/broadcaster understands
                // Gateway expects: { chatId, text }

                // Problem: We need the chatId to reply to.
                // The UI doesn't know the chatId unless we stored it or mapped it.
                // We have 'users[wallet].telegramId'.
                const tid = users[ws.username]?.telegramId;
                if (tid && gatewayWs && gatewayWs.readyState === WebSocket.OPEN) {
                    gatewayWs.send(JSON.stringify({
                        chatId: tid,
                        text: data.text
                    }));
                } else {
                    console.log("Cannot send chat: No Telegram Link or Gateway Offline");
                }
            }

        } catch (e) {
            console.error("Error parsing message:", e);
        }
    });
});

function broadcastState(username) {
    if (!username) return;
    const list = getTodos(username);
    const message = JSON.stringify({ type: 'STATE_UPDATE', todos: list });

    hqServer.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.username === username) {
            client.send(message);
        }
    });
}

// --- Clawd Gateway Client ---
let gatewayWs;

function connectToGateway() {
    console.log(`Connecting to Clawd Gateway at ${GATEWAY_URL}...`);
    gatewayWs = new WebSocket(GATEWAY_URL);

    gatewayWs.on('open', () => {
        console.log('Connected to Clawd Gateway!');
    });

    gatewayWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());

            let telegramId = null;
            let text = "";

            // Handle flattened payload from custom Gateway
            if (msg.payload && msg.payload.message) {
                // Standard Clawd-like
                text = msg.payload.message.text || msg.payload.message.conversation || "";
                telegramId = msg.payload.from || msg.payload.key?.remoteJid;
            } else if (msg.text && msg.chatId) {
                // Direct custom gateway payload
                text = msg.text;
                telegramId = msg.chatId.toString();
            }

            if (!text || !telegramId) return;

            // Handle /link command
            if (text.startsWith('/link ')) {
                const code = text.replace('/link ', '').trim();
                const linkData = linkCodes[code];

                if (linkData && linkData.expires > Date.now()) {
                    // Success! Link User
                    const walletAddress = linkData.username;

                    if (!users[walletAddress]) users[walletAddress] = {};
                    users[walletAddress].telegramId = telegramId;

                    saveUsers();
                    delete linkCodes[code];

                    console.log(`Linked Wallet ${walletAddress} to Telegram ${telegramId}`);
                    // Optional: Send reply back via Gateway?
                } else {
                    console.log(`Invalid link code from ${telegramId}`);
                }
                return;
            }

            // If text starts with /todo
            if (text.startsWith('/todo ')) {
                // Find user
                let username = null;
                for (const [wallet, data] of Object.entries(users)) {
                    if (data.telegramId === telegramId) {
                        username = wallet;
                        break;
                    }
                }

                if (username) {
                    const taskText = text.replace('/todo ', '').trim();
                    console.log(`Adding task for ${username}: ${taskText}`);
                    getTodos(username).push({ id: Date.now(), text: taskText, done: false });
                    saveTodos(username);
                    broadcastState(username);

                    // Optional: Broadcast chat message to UI
                    // hqServer.clients.forEach ...
                } else {
                    console.log(`Received command from unknown ID ${telegramId}. Please /link first!`);
                }
            } else {
                // Standard Chat Message - Broadcast to UI!
                // Find who this telegram user belongs to
                let username = null;
                for (const [wallet, data] of Object.entries(users)) {
                    if (data.telegramId === telegramId) {
                        username = wallet;
                        break;
                    }
                }

                // If we know the user, send to their UI
                if (username) {
                    const chatMsg = JSON.stringify({
                        text: text,
                        from: 'Telegram',
                        sender: msg.sender || 'User'
                    });
                    hqServer.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN && client.username === username) {
                            client.send(chatMsg);
                        }
                    });
                }
            }

        } catch (e) {
            // ignore
        }
    });

    gatewayWs.on('error', (e) => {
        // console.error('Gateway error:', e.message);
    });

    gatewayWs.on('close', () => {
        setTimeout(connectToGateway, 5000);
    });
}

connectToGateway();

// Start Server
server.listen(HQ_PORT, () => {
    console.log(`Headquarters Server (Express + WS) running on port ${HQ_PORT}`);
});

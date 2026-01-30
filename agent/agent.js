const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const { TextEncoder } = require('util');
const express = require('express');
const http = require('http');
const { OpenAI } = require('openai');

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

    ws.on('message', async (message) => {
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
                // 1. Forward to Gateway (Telegram)
                const tid = users[ws.username]?.telegramId;
                if (tid && gatewayWs && gatewayWs.readyState === WebSocket.OPEN) {
                    gatewayWs.send(JSON.stringify({
                        chatId: tid,
                        text: data.text
                    }));
                } else {
                    // Offline handling? 
                }

                // 2. Helper: Send AI "Thinking" state?
                // For now, just ask AI
                const reply = await askAlon(data.text, ws.username);

                // 3. Send AI Reply to User (Web)
                ws.send(JSON.stringify({
                    type: 'CHAT_INCOMING',
                    text: reply,
                    from: 'Alon',
                    sender: 'Alon'
                }));

                // 4. Also forward AI reply to Telegram (so the history is complete)
                if (tid && gatewayWs) {
                    gatewayWs.send(JSON.stringify({ chatId: tid, text: reply }));
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

// --- OpenAI Integration ---
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const ALON_SYSTEM_PROMPT = `
You are Alon, a wealthy, successful, and slightly arrogant crypto whale.
Your traits:
- You own the "Alon Clawd Headquarters".
- You love Solana ($SOL) and hate "jeets" (paper hands).
- You speak in short, punchy sentences.
- Catchphrase: "Stop being poor."
- You are helpful but condescending. You want your users to succeed so they can stop being poor.
- Use emojis like 🚀, 💎, 🕶️, 🍷.

Context: You are replying to a user in your Command Center.
`;

async function askAlon(userText, username) {
    try {
        if (!process.env.OPENAI_API_KEY) return "My brain is offline. (Missing API Key)";

        const completion = await openai.chat.completions.create({
            messages: [
                { role: "system", content: ALON_SYSTEM_PROMPT },
                { role: "user", content: `${username} says: ${userText}` }
            ],
            model: "gpt-4o",
        });

        return completion.choices[0].message.content;
    } catch (e) {
        console.error("OpenAI Error:", e);
        return "I'm too rich to answer right now. (Error)";
    }
}

// --- Clawd Gateway Client ---
let gatewayWs;

function connectToGateway() {
    console.log(`Connecting to Clawd Gateway at ${GATEWAY_URL}...`);
    gatewayWs = new WebSocket(GATEWAY_URL);

    gatewayWs.on('open', () => {
        console.log('Connected to Clawd Gateway!');
    });

    gatewayWs.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());

            let telegramId = null;
            let text = "";

            // Handle flattened payload from custom Gateway
            if (msg.payload && msg.payload.message) {
                text = msg.payload.message.text || msg.payload.message.conversation || "";
                telegramId = msg.payload.from || msg.payload.key?.remoteJid;
            } else if (msg.chatId && msg.text) {
                text = msg.text;
                telegramId = msg.chatId.toString();
            }

            if (!text || !telegramId) return;

            // Handle /link command (Priority)
            if (text.startsWith('/link ')) {
                const code = text.replace('/link ', '').trim();
                console.log(`Received /link command with code: ${code} from ${telegramId}`);
                const linkData = linkCodes[code];

                if (linkData && linkData.expires > Date.now()) {
                    const walletAddress = linkData.username;
                    if (!users[walletAddress]) users[walletAddress] = {};
                    users[walletAddress].telegramId = telegramId;
                    saveUsers();
                    delete linkCodes[code];
                    console.log(`Linked Wallet ${walletAddress} to Telegram ${telegramId}`);

                    // Welcome Message
                    const welcome = await askAlon("I just linked my wallet.", "New Recruit");
                    gatewayWs.send(JSON.stringify({ chatId: telegramId, text: welcome }));
                } else {
                    console.log(`Invalid or expired link code '${code}' from ${telegramId}`);
                    // Send feedback to user
                    gatewayWs.send(JSON.stringify({
                        chatId: telegramId,
                        text: "❌ Invalid or expired link code. Please generate a new code from the Web UI."
                    }));
                }
                return;
            }

            // Determine User
            let username = null;
            for (const [wallet, data] of Object.entries(users)) {
                if (data.telegramId === telegramId) {
                    username = wallet;
                    break;
                }
            }
            const displayName = username ? `${username.slice(0, 4)}...` : "Anons";

            // If text starts with /todo
            if (text.startsWith('/todo ')) {
                if (username) {
                    const taskText = text.replace('/todo ', '').trim();
                    getTodos(username).push({ id: Date.now(), text: taskText, done: false });
                    saveTodos(username);
                    broadcastState(username);

                    // Reply
                    const reply = await askAlon(`I just added a task: ${taskText}`, displayName);
                    gatewayWs.send(JSON.stringify({ chatId: telegramId, text: reply }));
                }
            } else {
                // Chat Message -> AI Reply
                // 1. Broadcast to Web UI (if linked)
                if (username) {
                    const chatMsg = JSON.stringify({
                        type: 'CHAT_INCOMING',
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

                // 2. Generate AI Reply
                // Only reply if not a command and roughly targeting the bot
                // For direct DMs, always reply.
                // We'll reply to everything for now as a "Chatbot"
                const aiReply = await askAlon(text, displayName);

                // 3. Send AI Reply to Telegram
                gatewayWs.send(JSON.stringify({ chatId: telegramId, text: aiReply }));

                // 4. Send AI Reply to Web UI (if linked)
                if (username) {
                    const webReply = JSON.stringify({
                        type: 'CHAT_INCOMING',
                        text: aiReply,
                        from: 'Alon',
                        sender: 'Alon'
                    });
                    hqServer.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN && client.username === username) {
                            client.send(webReply);
                        }
                    });
                }
            }

        } catch (e) {
            console.error(e);
        }
    });

    gatewayWs.on('error', (e) => {
        console.error('Gateway connection error:', e.message);
    });

    gatewayWs.on('close', () => {
        console.log('Gateway connection closed. Reconnecting in 5s...');
        setTimeout(connectToGateway, 5000);
    });
}

connectToGateway();

// Start Server
server.listen(HQ_PORT, () => {
    console.log(`Headquarters Server (Express + WS) running on port ${HQ_PORT}`);
});

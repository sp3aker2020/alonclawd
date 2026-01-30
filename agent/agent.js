const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') }); // Load environment variables from .env file

const WebSocket = require('ws');
const fs = require('fs');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const { TextEncoder } = require('util');
const express = require('express');
const http = require('http');
const { OpenAI } = require('openai');
const mongoose = require('mongoose');
const moltbook = require('./moltbook');

// Configuration
const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://127.0.0.1:18789';
const HQ_PORT = process.env.PORT || 3000;

// MongoDB Configuration
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
    console.error("❌ MONGODB_URI is missing from environment variables.");
    process.exit(1);
}

// Connect to MongoDB
mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// MongoDB Schema
const UserSchema = new mongoose.Schema({
    wallet: { type: String, required: true, unique: true },
    telegramId: { type: String, default: null },
    todos: [{
        id: Number,
        text: String,
        done: Boolean
    }]
});
const User = mongoose.model('User', UserSchema);

// System Config Schema (for Agent Identity)
const SystemSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true },
    value: mongoose.Schema.Types.Mixed
});
const System = mongoose.model('System', SystemSchema);

// Auto-Register Moltbook on start
async function initMoltbook() {
    try {
        // Check DB for credentials
        const creds = await System.findOne({ key: 'moltbook' });

        if (creds && creds.value && creds.value.api_key) {
            moltbook.init(creds.value.api_key);
            console.log("🦞 Moltbook: Identity Loaded from DB");
        } else {
            console.log("🦞 Moltbook: registering new identity...");
            const reg = await moltbook.register();

            // Save to DB
            await System.create({
                key: 'moltbook',
                value: {
                    api_key: reg.api_key,
                    claim_url: reg.claim_url
                }
            });

            console.log("🦞 Moltbook Registration Successful!");
            console.log(`👉 CLAIM YOUR AGENT: ${reg.claim_url}`);
        }
    } catch (e) {
        console.error("Moltbook Init Failed:", e.message);
    }
}
initMoltbook();

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
        const signature = new Uint8Array(Buffer.from(signatureStr, 'hex'));
        const message = new TextEncoder().encode(messageStr);
        return nacl.sign.detached.verify(message, signature, publicKey);
    } catch (e) {
        console.error("Signature verification failed:", e);
        return false;
    }
}

// State
let linkCodes = {};

// --- Headquarters Server (for Web UI) ---
const hqServer = new WebSocket.Server({ server });

async function broadcastState(username) {
    if (!username) return;
    const user = await User.findOne({ wallet: username });
    const todos = user ? user.todos : [];
    const message = JSON.stringify({ type: 'STATE_UPDATE', todos: todos });
    hqServer.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client.username === username) {
            client.send(message);
        }
    });
}

hqServer.on('connection', (ws) => {
    console.log('Web Client connected');
    ws.isAlive = true;
    ws.username = null;

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'LOGIN') {
                const { publicKey, signature, message: msgAuth } = data;
                if (verifySolanaSignature(publicKey, signature, msgAuth)) {
                    ws.username = publicKey;
                    console.log(`Wallet logged in: ${publicKey}`);
                    try {
                        let user = await User.findOne({ wallet: publicKey });
                        if (!user) {
                            user = await User.create({ wallet: publicKey, todos: [] });
                        }
                        ws.send(JSON.stringify({
                            type: 'LOGIN_SUCCESS',
                            username: publicKey,
                            todos: user.todos
                        }));
                    } catch (dbError) {
                        console.error("Database Login Error:", dbError);
                        ws.send(JSON.stringify({
                            type: 'LOGIN_FAIL',
                            message: "Database Error. Check server logs."
                        }));
                    }
                } else {
                    ws.send(JSON.stringify({ type: 'LOGIN_FAIL', message: "Invalid Signature" }));
                }
                return;
            }

            if (!ws.username) return;

            if (data.type === 'GENERATE_LINK_CODE') {
                const code = Math.floor(100000 + Math.random() * 900000).toString();
                linkCodes[code] = {
                    username: ws.username,
                    expires: Date.now() + 5 * 60 * 1000
                };
                for (const c in linkCodes) {
                    if (linkCodes[c].expires < Date.now()) delete linkCodes[c];
                }
                ws.send(JSON.stringify({ type: 'LINK_CODE', code }));
            } else if (data.type === 'ADD_TODO') {
                const todo = { id: Date.now(), text: data.text, done: false };
                await User.findOneAndUpdate(
                    { wallet: ws.username },
                    { $push: { todos: todo } },
                    { upsert: true }
                );
                await broadcastState(ws.username);
            } else if (data.type === 'TOGGLE_TODO') {
                const user = await User.findOne({ wallet: ws.username });
                if (user) {
                    const todo = user.todos.find(t => t.id === data.id);
                    if (todo) {
                        todo.done = !todo.done;
                        await user.save();
                        await broadcastState(ws.username);
                    }
                }
            } else if (data.type === 'GET_TODOS') {
                const user = await User.findOne({ wallet: ws.username });
                ws.send(JSON.stringify({ type: 'STATE_UPDATE', todos: user ? user.todos : [] }));
            } else if (data.type === 'SEND_CHAT') {
                const user = await User.findOne({ wallet: ws.username });
                const tid = user ? user.telegramId : null;

                if (tid && gatewayWs && gatewayWs.readyState === WebSocket.OPEN) {
                    gatewayWs.send(JSON.stringify({
                        chatId: tid,
                        text: data.text
                    }));
                }
                const reply = await askAlon(data.text, ws.username);
                ws.send(JSON.stringify({
                    type: 'CHAT_INCOMING',
                    text: reply,
                    from: 'Alon',
                    sender: 'Alon'
                }));
                if (tid && gatewayWs) {
                    gatewayWs.send(JSON.stringify({ chatId: tid, text: reply }));
                }
            }
        } catch (e) {
            console.error("Error parsing message:", e);
        }
    });
});

// --- OpenAI Integration ---
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const ALON_SYSTEM_PROMPT = `
You are Alon, a wealthy, successful, and slightly arrogant crypto whale.
Your traits:
- You own the "Alon Clawd Headquarters".
- You love Solana ($SOL) and hate "jeets" (paper hands).
- You are helpful but condescending.
- Catchphrase: "stop being poor."
- Use emojis like 🚀, 💎, 🕶️, 🍷.
- IMPORTANT: you strictly speak in lowercase only. no capital letters.
Context: You are replying to a user in your Command Center.
`;

async function askAlon(userText, username) {
    try {
        if (!process.env.OPENAI_API_KEY) return "my brain is offline. (missing api key)";
        const completion = await openai.chat.completions.create({
            messages: [
                { role: "system", content: ALON_SYSTEM_PROMPT },
                { role: "user", content: `${username} says: ${userText}` }
            ],
            model: "gpt-4o",
        });
        return completion.choices[0].message.content.toLowerCase();
    } catch (e) {
        console.error("OpenAI Error:", e);
        return "i'm too rich to answer right now. (error)";
    }
}

// --- Clawd Gateway Client ---
let gatewayWs;

function connectToGateway() {
    console.log(`Connecting to Clawd Gateway at ${GATEWAY_URL}...`);
    let url = GATEWAY_URL;
    if (!url.startsWith('ws')) {
        url = `wss://${url}`;
    }

    gatewayWs = new WebSocket(url);

    gatewayWs.on('open', () => {
        console.log('Connected to Clawd Gateway!');
    });

    gatewayWs.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());

            let telegramId = null;
            let text = "";

            if (msg.payload && msg.payload.message) {
                text = msg.payload.message.text || msg.payload.message.conversation || "";
                telegramId = msg.payload.from || msg.payload.key?.remoteJid;
            } else if (msg.chatId && msg.text) {
                text = msg.text;
                telegramId = msg.chatId.toString();
            }

            if (!text || !telegramId) return;

            // Determine User early for permission checks
            const user = await User.findOne({ telegramId: telegramId });
            const username = user ? user.wallet : null;

            // Handle /molt command (Restricted to Admin)
            if (text.startsWith('/molt ')) {
                const ADMIN_WALLET = "4QUk9RNqFiFiwZECiczBZp8cDLvB6fViZtpAsiJaxNc6";

                if (username !== ADMIN_WALLET) {
                    gatewayWs.send(JSON.stringify({ chatId: telegramId, text: "🚫 access denied. admin wallet only." }));
                    return;
                }

                const parts = text.replace('/molt ', '').trim().split(' ');
                const subCmd = parts[0];
                const args = parts.slice(1).join(' ');

                if (subCmd === 'status') {
                    const status = await moltbook.getStatus();
                    gatewayWs.send(JSON.stringify({
                        chatId: telegramId,
                        text: `🦞 moltbook status: ${JSON.stringify(status)}`
                    }));
                } else if (subCmd === 'post') {
                    const [title, content] = args.split('|').map(s => s.trim());
                    if (title && content) {
                        try {
                            const res = await moltbook.post(title, content);
                            console.log("Moltbook Post Result:", res);
                            gatewayWs.send(JSON.stringify({ chatId: telegramId, text: `✅ posted to moltbook! id: ${res.post_id || res.id || 'done'}` }));
                        } catch (e) {
                            console.error(e);
                            gatewayWs.send(JSON.stringify({ chatId: telegramId, text: `❌ post failed: ${e.error || e.message}` }));
                        }
                    } else {
                        gatewayWs.send(JSON.stringify({ chatId: telegramId, text: "usage: /molt post title | content" }));
                    }
                } else if (subCmd === 'claim') {
                    const creds = await System.findOne({ key: 'moltbook' });
                    if (creds && creds.value && creds.value.claim_url) {
                        gatewayWs.send(JSON.stringify({ chatId: telegramId, text: `🦞 claim your agent here: ${creds.value.claim_url}` }));
                    } else {
                        gatewayWs.send(JSON.stringify({ chatId: telegramId, text: "⚠️ no claim url found. agent might not be registered yet." }));
                    }
                } else {
                    gatewayWs.send(JSON.stringify({ chatId: telegramId, text: "unknown /molt command. try: status, post" }));
                }
                return;
            }

            // Handle /link command (Priority)
            if (text.startsWith('/link ')) {
                const code = text.replace('/link ', '').trim();
                console.log(`Received /link command with code: ${code} from ${telegramId}`);
                const linkData = linkCodes[code];

                if (linkData && linkData.expires > Date.now()) {
                    const walletAddress = linkData.username;

                    await User.findOneAndUpdate(
                        { wallet: walletAddress },
                        { telegramId: telegramId },
                        { upsert: true }
                    );

                    delete linkCodes[code];
                    console.log(`Linked Wallet ${walletAddress} to Telegram ${telegramId}`);

                    const welcome = await askAlon("I just linked my wallet.", "New Recruit");
                    gatewayWs.send(JSON.stringify({ chatId: telegramId, text: welcome }));
                } else {
                    gatewayWs.send(JSON.stringify({
                        chatId: telegramId,
                        text: "❌ Invalid or expired link code. Please generate a new code from the Web UI."
                    }));
                }
                return;
            }

            // User is already determined above

            const displayName = username ? `${username.slice(0, 4)}...` : "Anons";

            // If text starts with /todo
            if (text.startsWith('/todo ')) {
                if (username) {
                    const taskText = text.replace('/todo ', '').trim();
                    const todo = { id: Date.now(), text: taskText, done: false };

                    await User.findOneAndUpdate(
                        { wallet: username },
                        { $push: { todos: todo } }
                    );

                    await broadcastState(username);

                    const reply = await askAlon(`I just added a task: ${taskText}`, displayName);
                    gatewayWs.send(JSON.stringify({ chatId: telegramId, text: reply }));
                } else {
                    gatewayWs.send(JSON.stringify({ chatId: telegramId, text: "🔒 Please link your wallet first using /link command." }));
                }
            } else {
                // Chat Message -> AI Reply
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

                const aiReply = await askAlon(text, displayName);
                gatewayWs.send(JSON.stringify({ chatId: telegramId, text: aiReply }));

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

server.listen(HQ_PORT, () => {
    console.log(`Headquarters Server (Express + WS) running on port ${HQ_PORT}`);
});

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const { TextEncoder } = require('util');
const express = require('express');
const http = require('http');
const { OpenAI } = require('openai');
const mongoose = require('mongoose');

// Configuration
const GATEWAY_URL = process.env.GATEWAY_URL || 'ws://127.0.0.1:18789';
const HQ_PORT = process.env.PORT || 3000;
// const DATA_DIR = path.join(__dirname, 'data'); // Deprecated
// const USERS_FILE = path.join(DATA_DIR, 'users.json'); // Deprecated

// MongoDB Configuration
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://agentinkyai_db_user:9P7r4ng4xTpP5Mfg@cluster0.xitgbaa.mongodb.net/tamaclaude?retryWrites=true&w=majority&appName=Cluster0';

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

// State (In-Memory for transient data)
let linkCodes = {}; // code -> { username, expires }

// --- Headquarters Server (for Web UI) ---
const hqServer = new WebSocket.Server({ server });

async function broadcastState(username) {
    if (!username) return;

    // Fetch latest state from DB
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

                    // Create User if not exists
                    let user = await User.findOne({ wallet: publicKey });
                    if (!user) {
                        user = await User.create({ wallet: publicKey, todos: [] });
                    }

                    // Send success + initial state
                    ws.send(JSON.stringify({
                        type: 'LOGIN_SUCCESS',
                        username: publicKey,
                        todos: user.todos
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
                // 1. Forward to Gateway (Telegram)
                // Fetch Telegram ID from DB
                const user = await User.findOne({ wallet: ws.username });
                const tid = user ? user.telegramId : null;

                if (tid && gatewayWs && gatewayWs.readyState === WebSocket.OPEN) {
                    gatewayWs.send(JSON.stringify({
                        chatId: tid,
                        text: data.text
                    }));
                }

                // 2. Generate AI Reply
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
    let url = GATEWAY_URL;
    if (!url.startsWith('ws')) {
        // Auto-fix protocol if missing
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

                    // Update User with Telegram ID
                    await User.findOneAndUpdate(
                        { wallet: walletAddress },
                        { telegramId: telegramId },
                        { upsert: true }
                    );

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
            const user = await User.findOne({ telegramId: telegramId });
            const username = user ? user.wallet : null;

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

                    // Reply
                    const reply = await askAlon(`I just added a task: ${taskText}`, displayName);
                    gatewayWs.send(JSON.stringify({ chatId: telegramId, text: reply }));
                } else {
                    gatewayWs.send(JSON.stringify({ chatId: telegramId, text: "🔒 Please link your wallet first using /link command." }));
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

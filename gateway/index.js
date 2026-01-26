const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// Load Config
const CONFIG_PATH = path.join(__dirname, 'config.json');
let config = {};
try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
    console.error("Failed to load config.json", e);
    process.exit(1);
}

const TOKEN = process.env.TELEGRAM_TOKEN || config.tokens?.telegram;
const PORT = process.env.PORT || config.websocket?.port || 18789;

if (!TOKEN) {
    console.error("No Telegram Token found in config.json or TELEGRAM_TOKEN env");
    process.exit(1);
}

// 1. Setup Telegram Bot
console.log("Starting Telegram Bot...");
const bot = new TelegramBot(TOKEN, { polling: true });

// 2. Setup WebSocket Server
console.log(`Starting WebSocket Server on port ${PORT}...`);
const wss = new WebSocket.Server({ port: PORT });

// Store connected clients (Agent, UI)
let clients = [];

wss.on('connection', (ws) => {
    console.log("New WebSocket Client connected");
    clients.push(ws);

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log("Received WS message:", data);

            // If it's a message TO send to Telegram
            if (data.chatId && data.text) {
                await bot.sendMessage(data.chatId, data.text);
            }
        } catch (e) {
            console.error("Error processing WS message:", e);
        }
    });

    ws.on('close', () => {
        console.log("Client disconnected");
        clients = clients.filter(c => c !== ws);
    });
});

// Broadcast function
function broadcast(payload) {
    const msg = JSON.stringify(payload);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

// 3. Handle Telegram Messages
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const from = msg.from; // Contains username, id, etc.

    console.log(`[Telegram] ${from.username}: ${text}`);

    // Forward to WebSocket Clients (Agent/UI)
    // Structure matches what agent.js expects (loosely)
    // Agent expects: { payload: { message: { text: "..." }, key: { remoteJid: "..." } } }
    // OR simplified structure if we update agent.js.
    // Let's stick to a generic structure and ensure agent.js handles it.

    // Actually, looking at agent.js previously:
    // It checks: msg.payload.message.text OR msg.payload.from

    // Let's send a structure that maps cleanly but is simple.
    // We will construct a 'Clawd-like' payload to minimize agent code changes, 
    // or we assume agent.js has the custom logic I added earlier (Step 272).

    // In Step 272 agent.js:
    // if (msg.payload && msg.payload.message) { ... }

    const payload = {
        payload: {
            message: {
                text: text,
                conversation: text // Fallback
            },
            key: {
                remoteJid: chatId.toString()
            },
            from: chatId.toString(),
            sender: from
        },
        // Also send top-level convenience fields
        text: text,
        chatId: chatId,
        sender: from.username
    };

    broadcast(payload);
});

console.log("Gateway Ready!");

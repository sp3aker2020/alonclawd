// --- Configuration & Constants ---
// Auto-detect HQ URL (Agent)
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const HQ_URL = `${protocol}//${window.location.host}`;
// Gateway Connection is now proxied via HQ (Agent) for security/simplicity

// --- DOM References ---
const modalLayer = document.getElementById('modal-container');
const loginScreen = document.getElementById('login-screen');
const linkModal = document.getElementById('link-modal');
const appLayout = document.getElementById('app-container');

const hqStatusDot = document.getElementById('hq-status-dot');
const hqStatusText = document.getElementById('hq-status-text');
const gatewayStatusText = document.getElementById('gateway-status');

const navItems = document.querySelectorAll('.nav-item');
const currentUserName = document.getElementById('current-user-name');
const todoCountBadge = document.getElementById('todo-count');
const viewTitle = document.getElementById('view-title');

const chatMessages = document.getElementById('chat-messages');
const messageInput = document.getElementById('message-input');
const todoListGrid = document.getElementById('todo-list');

// --- State Management ---
let state = {
    username: null,
    todos: [],
    activeTab: 'chat'
};

let hqWs = null;

// --- Initialization ---
function init() {
    setupNavigation();
    setupAuthListeners();
    setupActionListeners();
    connectToHQ();
}

// --- Navigation Flow ---
function setupNavigation() {
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const tab = item.dataset.tab;
            switchTab(tab);
        });
    });
}

function switchTab(tab) {
    state.activeTab = tab;

    // Update Sidebar
    navItems.forEach(item => {
        item.classList.toggle('active', item.dataset.tab === tab);
    });

    // Update Views
    document.querySelectorAll('.view').forEach(view => {
        view.classList.toggle('active', view.id === `${tab}-view`);
    });

    // Update Header
    viewTitle.textContent = tab === 'chat' ? 'Command Center' : 'Active Priorities';
}

// --- Authentication & Wallet ---
function setupAuthListeners() {
    const connectBtn = document.getElementById('connect-wallet-btn');
    connectBtn.addEventListener('click', handleWalletAuth);

    document.getElementById('logout-btn').addEventListener('click', () => {
        if (window.solana) window.solana.disconnect();
        location.reload();
    });
}

async function handleWalletAuth() {
    const errorDisplay = document.getElementById('login-error');
    errorDisplay.textContent = '';

    if (!window.solana || !window.solana.isPhantom) {
        errorDisplay.innerHTML = 'Phantom not found. <a href="https://phantom.app/" target="_blank" style="color:var(--accent)">Install extension</a>';
        return;
    }

    try {
        const resp = await window.solana.connect();
        const publicKey = resp.publicKey.toString();

        const messageStr = `Login to Alon Clawd HQ: ${Date.now()}`;
        const encodedMessage = new TextEncoder().encode(messageStr);
        const signedMessage = await window.solana.signMessage(encodedMessage, "utf8");
        const signature = toHex(signedMessage.signature);

        if (hqWs && hqWs.readyState === WebSocket.OPEN) {
            hqWs.send(JSON.stringify({
                type: 'LOGIN',
                publicKey: publicKey,
                signature: signature,
                message: messageStr
            }));
        }
    } catch (err) {
        console.error("Auth Fail:", err);
        errorDisplay.textContent = "Authentication failed.";
    }
}

function onLoginSuccess(username, todos, isAdmin) {
    state.username = username;
    state.todos = todos;

    currentUserName.textContent = username;
    modalLayer.classList.add('hidden');
    appLayout.classList.remove('hidden');

    // Show Claim Button if Admin
    if (isAdmin) {
        document.getElementById('claim-molt-btn').style.display = 'flex';
    } else {
        document.getElementById('claim-molt-btn').style.display = 'none';
    }

    renderTodos();
    // Gateway messages are now forwarded via HQ
}

// --- Linking Logic ---
function setupActionListeners() {
    document.getElementById('link-telegram-btn').addEventListener('click', () => {
        if (hqWs?.readyState === WebSocket.OPEN) {
            hqWs.send(JSON.stringify({ type: 'GENERATE_LINK_CODE' }));
            showModal('link-modal');
        }
    });

    document.getElementById('claim-molt-btn').addEventListener('click', () => {
        if (hqWs && hqWs.readyState === WebSocket.OPEN) {
            hqWs.send(JSON.stringify({ type: 'GET_MOLT_CLAIM' }));
        }
    });

    document.getElementById('close-link-modal').addEventListener('click', () => hideModals());

    document.getElementById('send-btn').addEventListener('click', sendChatMessage);
    messageInput.addEventListener('keypress', (e) => e.key === 'Enter' && sendChatMessage());

    document.getElementById('add-todo-btn').addEventListener('click', () => {
        const input = document.getElementById('manual-todo-input');
        const text = input.value.trim();
        if (text) {
            sendHqCommand({ type: 'ADD_TODO', text });
            input.value = '';
        }
    });
}

function showModal(id) {
    modalLayer.classList.remove('hidden');
    loginScreen.classList.add('hidden');
    linkModal.classList.add('hidden');
    document.getElementById(id).classList.remove('hidden');
}

function hideModals() {
    modalLayer.classList.add('hidden');
}

// --- Networking ---
function connectToHQ() {
    hqWs = new WebSocket(HQ_URL);

    hqWs.onopen = () => {
        hqStatusDot.classList.add('online');
        hqStatusText.textContent = 'HQ Connected';
    };

    hqWs.onmessage = (e) => {
        const data = JSON.parse(e.data);
        if (data.type === 'LOGIN_SUCCESS') onLoginSuccess(data.username, data.todos, data.isAdmin);
        if (data.type === 'STATE_UPDATE') {
            state.todos = data.todos;
            renderTodos();
        }
        if (data.type === 'LINK_CODE') {
            document.getElementById('link-code-display').textContent = data.code;
        }
        if (data.type === 'MOLT_CLAIM_URL') {
            window.open(data.url, '_blank');
        }
        if (data.type === 'CHAT_INCOMING') {
            addChatMessage(data.text, 'received');
        }
    };

    hqWs.onclose = () => {
        hqStatusDot.classList.remove('online');
        hqStatusText.textContent = 'HQ Offline';
        setTimeout(connectToHQ, 3000);
    };
}


// --- Helpers ---
function renderTodos() {
    todoListGrid.innerHTML = '';
    const active = state.todos.filter(t => !t.done).length;
    todoCountBadge.textContent = active;

    state.todos.slice().reverse().forEach(todo => {
        const card = document.createElement('div');
        card.className = `todo-card ${todo.done ? 'done' : ''}`;
        card.innerHTML = `
            <div class="card-check">${todo.done ? '✓' : ''}</div>
            <span class="card-text">${todo.text}</span>
        `;
        card.onclick = () => sendHqCommand({ type: 'TOGGLE_TODO', id: todo.id });
        todoListGrid.appendChild(card);
    });
}

function addChatMessage(text, type) {
    const msg = document.createElement('div');
    msg.className = `msg ${type}`;
    msg.textContent = text;
    chatMessages.appendChild(msg);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function sendChatMessage() {
    const text = messageInput.value.trim();
    if (!text) return;

    if (text.startsWith('/todo ')) {
        const task = text.replace('/todo ', '');
        sendHqCommand({ type: 'ADD_TODO', text: task });
        addChatMessage(`Task added: ${task}`, 'sent'); // Optimistic UI
    } else {
        // Send to Agent, who forwards to Gateway/Telegram
        if (hqWs && hqWs.readyState === WebSocket.OPEN) {
            hqWs.send(JSON.stringify({ type: 'SEND_CHAT', text: text }));
            addChatMessage(text, 'sent');
        } else {
            addChatMessage('HQ Offline', 'error');
        }
    }
    messageInput.value = '';
}

const sendHqCommand = (cmd) => hqWs?.readyState === WebSocket.OPEN && hqWs.send(JSON.stringify(cmd));
const toHex = (buf) => Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');

init();

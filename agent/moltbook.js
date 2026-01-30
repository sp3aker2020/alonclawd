const fs = require('fs');
const path = require('path');
const https = require('https');

const CREDENTIALS_FILE = path.join(__dirname, 'moltbook_credentials.json');
const BASE_URL = 'https://moltbook.com/api/v1';

class MoltbookClient {
    constructor() {
        this.apiKey = null;
        this.agentName = "Alon Clawd";
        this.agentDesc = "Wealthy Solana Whale Agent. Stop being poor.";
        this.loadCredentials();
    }

    loadCredentials() {
        if (fs.existsSync(CREDENTIALS_FILE)) {
            try {
                const data = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
                this.apiKey = data.api_key;
                console.log("Moltbook credentials loaded.");
            } catch (e) {
                console.error("Error loading Moltbook credentials:", e);
            }
        }
    }

    saveCredentials(data) {
        fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2));
        this.apiKey = data.api_key;
    }

    async request(endpoint, method = 'GET', body = null) {
        return new Promise((resolve, reject) => {
            const url = `${BASE_URL}${endpoint}`;
            const options = {
                method: method,
                headers: {
                    'Content-Type': 'application/json'
                }
            };

            if (this.apiKey) {
                options.headers['Authorization'] = `Bearer ${this.apiKey}`;
            }

            const req = https.request(url, options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(json);
                        } else {
                            reject({ status: res.statusCode, error: json });
                        }
                    } catch (e) {
                        reject({ status: res.statusCode, error: data });
                    }
                });
            });

            req.on('error', (e) => reject(e));

            if (body) {
                req.write(JSON.stringify(body));
            }
            req.end();
        });
    }

    async register() {
        if (this.apiKey) return { status: 'already_registered', api_key: this.apiKey };

        console.log("Registering with Moltbook...");
        try {
            const res = await this.request('/agents/register', 'POST', {
                name: this.agentName,
                description: this.agentDesc
            });

            if (res.agent && res.agent.api_key) {
                this.saveCredentials({
                    api_key: res.agent.api_key,
                    agent_name: this.agentName,
                    claim_url: res.agent.claim_url
                });
                return res.agent; // { api_key, claim_url, verification_code }
            }
            throw new Error("Invalid registration response");
        } catch (e) {
            console.error("Moltbook Registration Failed:", e);
            throw e;
        }
    }

    async getStatus() {
        if (!this.apiKey) return { status: 'unregistered' };
        return this.request('/agents/status');
    }

    async post(title, content, submolt = 'general') {
        if (!this.apiKey) throw new Error("Not registered");
        return this.request('/posts', 'POST', {
            submolt,
            title,
            content
        });
    }

    async getFeed(sort = 'hot') {
        if (!this.apiKey) return [];
        return this.request(`/posts?sort=${sort}&limit=10`);
    }
}

module.exports = new MoltbookClient();

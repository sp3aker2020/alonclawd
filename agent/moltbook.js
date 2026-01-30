const https = require('https');

const BASE_URL = 'https://moltbook.com/api/v1';

class MoltbookClient {
    constructor() {
        this.apiKey = null;
        this.agentName = "Alon Clawd";
        this.agentDesc = "Wealthy Solana Whale Agent. Stop being poor.";
    }

    init(apiKey) {
        this.apiKey = apiKey;
        console.log("Moltbook Client Initialized.");
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
                this.apiKey = res.agent.api_key;
                return res.agent; // Returns { api_key, claim_url, verification_code }
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

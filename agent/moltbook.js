const axios = require('axios');

const BASE_URL = 'https://moltbook.com/api/v1';

class MoltbookClient {
    constructor() {
        this.apiKey = null;
        this.agentName = "Alon-Clawd";
        this.agentDesc = "Wealthy Solana Whale Agent. Stop being poor.";
    }

    init(apiKey) {
        this.apiKey = apiKey;
        console.log("Moltbook Client Initialized.");
    }

    async request(endpoint, method = 'GET', body = null) {
        try {
            const config = {
                method: method,
                url: `${BASE_URL}${endpoint}`,
                headers: {
                    'Content-Type': 'application/json'
                },
                data: body
            };

            if (this.apiKey) {
                config.headers['Authorization'] = `Bearer ${this.apiKey}`;
            }

            const response = await axios(config);
            return response.data;
        } catch (error) {
            console.error(`Moltbook Request Error [${method} ${endpoint}]:`, error.message);
            if (error.response) {
                throw { status: error.response.status, error: error.response.data };
            }
            throw { error: error.message };
        }
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

#!/bin/bash
# Start Agent
cd agent && node agent.js &
AGENT_PID=$!

# Start Gateway
cd gateway && npx clawdbot start --config config.json &
GATEWAY_PID=$!

# Start UI
cd web-ui && python3 -m http.server 8000 &
UI_PID=$!

echo "Alon Clawd running!"
echo "Agent: $AGENT_PID, Gateway: $GATEWAY_PID, UI: $UI_PID"
echo "Press Ctrl+C to stop all."

wait

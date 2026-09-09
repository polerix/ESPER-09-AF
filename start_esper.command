#!/bin/bash
# ==============================================================================
# ESPER 09-AF – Double-clickable Launcher for macOS
# Blade Runner ESPER Machine & ATARI-SONY-JVC Console
# ==============================================================================

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "=========================================================="
echo " 🎥 ESPER 09-AF // ORBITCAM LDAF – Console Launcher"
echo "=========================================================="

# Build binary if not already compiled
if [ ! -f "bin/orbitcam" ]; then
    echo "⚡ Compiling orbitcam binary..."
    make
    echo ""
fi

# Ensure any previous instance on port 9090 is stopped
PORT=9090
echo "⚡ Stopping any previous server instance..."
lsof -ti:$PORT | xargs kill -9 2>/dev/null || true
pkill -f "bin/orbitcam" 2>/dev/null || true
sleep 0.3

echo "🚀 Starting ESPER 09-AF daemon on http://localhost:$PORT..."
./bin/orbitcam serve $PORT &
SERVER_PID=$!
sleep 0.8

echo "🌐 Opening ESPER console in default browser..."
open "http://localhost:$PORT"

echo ""
echo "Console is live! Keep this window open while operating the camera."
echo "Press Ctrl+C to shut down the console."
echo ""

# Wait for background process if launched
if [ -n "$SERVER_PID" ]; then
    wait $SERVER_PID
fi

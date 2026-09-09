#!/bin/bash
# ==============================================================================
# Orbitcam LDAF – Double-clickable Launcher for macOS
# ==============================================================================

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "=========================================================="
echo " 🎥 Orbitcam LDAF – Logitech QuickCam Orbit AF Launcher"
echo "=========================================================="

# Build binary if not already compiled
if [ ! -f "bin/orbitcam" ]; then
    echo "⚡ Compiling orbitcam binary..."
    make
    echo ""
fi

# Ensure any previous instance on port 9090 is stopped
PORT=9090
echo "⚡ Stopping any previous orbitcam instance..."
lsof -ti:$PORT | xargs kill -9 2>/dev/null || true
pkill -f "bin/orbitcam" 2>/dev/null || true
sleep 0.3

echo "🚀 Starting Orbitcam daemon on http://localhost:$PORT..."
./bin/orbitcam serve $PORT &
SERVER_PID=$!
sleep 0.8

echo "🌐 Opening control console in default browser..."
open "http://localhost:$PORT"

echo ""
echo "Controller is live! Keep this window open while using the camera."
echo "Press Ctrl+C to stop the daemon."
echo ""

# Wait for background process if launched
if [ -n "$SERVER_PID" ]; then
    wait $SERVER_PID
fi

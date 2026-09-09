# 🎥 ESPER 09-AF

**Blade Runner ESPER Machine & ATARI-SONY-JVC Console for Logitech QuickCam Orbit AF on macOS**

> A native, zero-dependency macOS motion controller and retro-industrial photo-analysis terminal that restores motorized Pan/Tilt, home calibration, ring LED control, image processing, analogue VU metering, and real-time **AI Face Auto-Tracking** on modern macOS (macOS 11 through macOS 26 Tahoe / Sequoia / Sonoma).

---

## 🧭 Why This Was Created

The **Logitech QuickCam Orbit AF** (`046d:0994`) features a motorized robotic pan/tilt base and Carl Zeiss autofocus optics. While Apple's native UVC and AVFoundation drivers automatically detect the video feed and microphone on modern macOS, Logitech never released 64-bit drivers for the motorized base.

### Hardware Reverse-Engineering Discoveries

By analyzing the device descriptors via IOKit and reverse-engineering the UVC control pipe:
- **Interface 0 (VideoControl)** contains proprietary Logitech Extension Units over Endpoint 0:
  - **Motor Extension Unit ID**: `0x09`
  - **Pan/Tilt Control Selector**: `0x01` (4-byte packet: `[0x80, pan_step, 0x80, -tilt_step]`)
  - **Motor Reset / Home Calibration**: `0x02` (1-byte packet: `0x03` to calibrate both axes)
  - **Ring LED Control**: Unit `0x0A` / `0x0D`, Selector `0x01` (`0`=off, `1`=on, `2`=blink, `3`=auto)
  - **UVC Processing Unit**: Unit `0x02` (Brightness, Contrast, Saturation, Sharpness, Gain, White Balance)
- **Direct Access Without Root**: USB class-specific control requests (`DeviceRequest`) via Apple's native `IOKit` framework operate directly from user space without requiring kernel extensions or special entitlements.

---

## ✨ Key Features

### 🕹️ Blade Runner ESPER & ATARI-SONY-JVC Console
- **Rackmount Cast Chassis**: Heavy gunmetal & anthracite console housing with authentic corner hex fasteners, serial badges (`ESPER.09-AF // QC-82452`), and amber LED nixie coordinate readouts (`AZM 000° / ELEV 000°`).
- **Tactile Membrane Keypad**: 8-way directional keypad with physical depression feedback, glowing status LED lenses, and an Atari burnt-orange (`#ea580c`) center `HOME` calibration key.
- **Analogue Gimbal Joystick**: Rubber accordion boot gaiter with concentric ribs, machined chrome steel shaft, and cherry-red arcade ball-top with spring-return proportional pan/tilt control.
- **CRT Cathode Ray Tube Display**: Phosphor video tube with optional CRT aperture grille scanline raster.
- **Broadcast 6-Channel Location Registers**: Color-coded tactile preset switches (`L-15`, `HOME`, `R+15`, `UP+8`, `DN-8`, `REG-1` memory register).

### 🎙️ Analogue D'Arsonval Galvanometer VU Meter
- **Vintage Ivory Dial Faceplate**: Authentic ivory / aged-parchment dial plate with radial incandescent bulb glow and classic italic serif *VU* typography.
- **ANSI C16.5 Ballistic Physics Simulation**: 2nd-order damped spring-mass harmonic oscillator ($\ddot{\theta} = \omega_n^2 (\theta_{\text{target}} - \theta) - 2\zeta\omega_n \dot{\theta}$) providing realistic needle inertia, rise time, and 1.5% ballistic overshoot bounce.
- **Ruby Overload PEAK LED**: Flashes on instantaneous audio transients crossing 0 dB.
- **CRT Vector Spectrum Scope**: 14-band green phosphor formant bar display directly integrated into the meter bezel.

### 👁️ High-Speed AI Face Auto-Tracking (Pico.js)
- **100% Offline & Zero Network Dependencies**: Runs an optimized cascade classifier locally inside the browser, evaluating frames in **~17 milliseconds**.
- **Dynamic Contrast Auto-Normalization**: Dynamically stretches grayscale intensity to boost facial contours, eye sockets, and nose bridges across variable room lighting and shadows.
- **Temporal Hysteresis & Memory Window**: 350ms memory buffer prevents tracking loss during quick head turns, blinks, or motor vibration.
- **ESPER Optical Reticle**: Millimeter corner ticks, live telemetry (`▲ LOCK [CONF: 94%]`, `ΔX:+12% ΔY:-08%`, `[Q-1]`), and retro sci-fi audio lock chime.

### ⚡ Native Backend Daemon & CLI
- **Pure Objective-C**: Compiles against Apple's standard SDK (`IOKit`, `CoreFoundation`, `Foundation`) with zero external libraries or package managers.
- **Embedded HTTP REST Server**: Serves the web console and provides a full REST API for third-party integrations (OBS, Stream Deck, scripts).
- **Fast CLI Mode**: Instant standalone commands (`reset`, `pan`, `tilt`, `led`, `status`, `settings`).

---

## 🚀 Quick Start

### Option A: Double-Click Launcher (Easiest)

1. Double-click `start_esper.command` (or `start_orbitcam.command`) in Finder.
2. The controller compiles automatically (if needed), starts the daemon, and opens `http://localhost:9090` in your default browser.

### Option B: Terminal Commands

```bash
# 1. Build the binary
make

# 2. Start the web console server (default port 9090)
./bin/orbitcam serve

# 3. Open in your browser
open http://localhost:9090
```

---

## ⌨️ CLI Reference

The compiled `orbitcam` binary can be run standalone from the command line:

```bash
# Motion Controls
./bin/orbitcam reset               # Center & calibrate pan/tilt motors
./bin/orbitcam pan 3               # Pan right by 3 steps
./bin/orbitcam pan -3              # Pan left by 3 steps
./bin/orbitcam tilt 2              # Tilt up by 2 steps
./bin/orbitcam tilt -2             # Tilt down by 2 steps
./bin/orbitcam pantilt 3 2         # Move pan & tilt simultaneously

# LED Control
./bin/orbitcam led on              # Turn ring light ON
./bin/orbitcam led blink           # Set ring light to BLINK
./bin/orbitcam led auto            # Set ring light to AUTO (active on stream)
./bin/orbitcam led off             # Turn ring light OFF

# Hardware Status & Settings
./bin/orbitcam status              # Verify USB connection & device status
./bin/orbitcam settings            # List current, min, max, and default image settings
./bin/orbitcam get brightness      # Read current brightness value
./bin/orbitcam set brightness 140  # Set brightness to 140
```

---

## 🌐 REST API Reference

When the daemon is active on `http://localhost:9090`:

| Method | Endpoint | Payload | Description |
|---|---|---|---|
| `GET` | `/api/status` | – | Returns camera connection and firmware status |
| `POST` | `/api/ptz` | `{"pan": int, "tilt": int}` | Executes relative pan and tilt motor steps |
| `POST` | `/api/reset` | – | Re-calibrates motors to home position |
| `POST` | `/api/led` | `{"mode": "off"\|"on"\|"blink"\|"auto"}` | Controls camera status LED ring |
| `GET` | `/api/settings` | – | Lists all UVC processing controls with min/max |
| `POST` | `/api/setting` | `{"name": str, "value": int}` | Adjusts a specific image setting |
| `POST` | `/api/settings/reset` | – | Resets all image controls to factory defaults |
| `GET` | `/` | – | Serves the HTML5/CSS/JS control console |

---

## 🎮 Keyboard Shortcuts

| Key | Action |
|---|---|
| <kbd>▲</kbd> / <kbd>W</kbd> | Tilt Up |
| <kbd>▼</kbd> / <kbd>S</kbd> | Tilt Down |
| <kbd>◀</kbd> / <kbd>A</kbd> | Pan Left |
| <kbd>▶</kbd> / <kbd>D</kbd> | Pan Right |
| <kbd>H</kbd> / <kbd>Space</kbd> | Center / Zero Return |
| <kbd>1</kbd> – <kbd>8</kbd> | Motor Speed Fader |
| <kbd>M</kbd> | Toggle Microphone Mute |
| <kbd>F</kbd> | Toggle Fullscreen Mode |

---

## 🛠️ Requirements & Build

- **macOS 11+** (Apple Silicon or Intel)
- **Xcode Command Line Tools** (`xcode-select --install`)
- **Logitech QuickCam Orbit AF** (`046d:0994`) plugged into any USB port or hub

```bash
make
```

To install the `orbitcam` CLI tool system-wide to `/usr/local/bin`:
```bash
sudo make install
```

---

## 📜 License

MIT License. Designed with precision for the open-source community.

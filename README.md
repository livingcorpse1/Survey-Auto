# SurveyPilot 🤖

An automated hybrid agent for Android survey apps. SurveyPilot dynamically switches between **Native UI Automator** mode and **CDP (Chrome DevTools Protocol) DOM Injection** mode to interact with an Android phone or BlueStacks instance.

## Features

- 🔀 **Hybrid Mode** — Automatically detects whether the current screen is a native Android UI or a WebView and switches strategy accordingly.
- 🧠 **AI-Powered** — Uses OpenRouter with NVIDIA Nemotron 3 Ultra (free) to analyze the screen and decide what to do next.
- 🚫 **Auto-Skip** — Detects screen-outs, captchas, complex sliders, and loading-stuck surveys and skips them automatically.
- 📊 **Live Dashboard** — Real-time logs, live DOM/XML context viewer, and session stats.
- 💰 **Cost Control** — Set a maximum API spend limit and a survey completion goal.

## Supported Apps

- **AttaPoll** (`com.requapp.requ`)
- **5Surveys** (`com.fivesurveys.mobile`)

## Requirements

- **Windows** (uses `.exe` paths for ADB and Frida)
- Android Debug Bridge (ADB), either from [scrcpy](https://github.com/Genymobile/scrcpy) or BlueStacks (`HD-Adb.exe`)
- A physical Android device or BlueStacks 5 instance with ADB enabled
- [Frida](https://frida.re/) + `frida-server` in `/data/local/tmp` and root access for WebView injection
- An [OpenRouter API key](https://openrouter.ai/keys)
- Node.js + pnpm

## Setup

1. **Clone the repo**
   ```bash
   git clone https://github.com/YOUR_USERNAME/surveypilot.git
   cd surveypilot
   ```

2. **Install dependencies**
   ```bash
   pnpm install
   ```

3. **Configure ADB and Frida**

   Copy `.env.example` to `.env` and set `OPENROUTER_API_KEY`, `ADB_PATH`, and `FRIDA_PATH`. The default model is `nvidia/nemotron-3-ultra-550b-a55b:free`; `ADB_SERIAL` is optional. Leave it blank to choose a connected device in the dashboard. The `.env` file is ignored by Git.

4. **Connect BlueStacks (or a phone)**

   In BlueStacks 5, enable **Settings → Advanced → Android Debug Bridge** and save. In SurveyPilot, enter the BlueStacks local ADB address (usually `127.0.0.1:5555`, or the port configured for that instance), select **Connect BlueStacks**, then choose the connected device from the device list. A phone connected over USB remains selectable there too.

5. **Run the dev server**
   ```bash
   pnpm dev
   ```

6. **Open the app** at `http://localhost:8080` and fill in:
   - Choose your target survey app
   - Set a cost limit and survey goal

## How It Works

1. The dashboard selects one online ADB target and launches the target app there.
2. It dumps the UI XML to check whether a WebView is present.
3. **NATIVE mode**: Sends ADB tap commands based on UI element bounds.
4. **WEB mode**: Connects via CDP to the WebView and injects JavaScript.
5. The local Vite server sends screen context to OpenRouter; Nemotron returns a structured action (tap, evaluate, wait, or done).
6. The loop continues until the survey goal is reached or the cost limit is hit.

## Security Notes

- The OpenRouter key stays in the local `.env` file and is sent from the Vite server, not stored in browser storage.
- Screen XML, WebView page text/HTML, and the configured goal are sent to OpenRouter for model requests. The free NVIDIA endpoint may log and use request data to improve its products; do not use it with information you do not want sent to that service.
- ADB and Frida paths can be configured in `.env`; do not commit real local paths or keys.
- Frida/root is needed for the current WebView debugging injection path. Native UI automation uses ADB without Frida.
- This tool is intended for personal use on your own device.

## License

MIT

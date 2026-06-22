# SurveyPilot 🤖

An automated hybrid agent for Android survey apps. SurveyPilot dynamically switches between **Native UI Automator** mode and **CDP (Chrome DevTools Protocol) DOM Injection** mode to intelligently complete surveys on your Android device.

## Features

- 🔀 **Hybrid Mode** — Automatically detects whether the current screen is a native Android UI or a WebView and switches strategy accordingly.
- 🧠 **AI-Powered** — Uses Claude (Anthropic) to analyze the screen and decide what to do next.
- 🚫 **Auto-Skip** — Detects screen-outs, captchas, complex sliders, and loading-stuck surveys and skips them automatically.
- 📊 **Live Dashboard** — Real-time logs, live DOM/XML context viewer, and session stats.
- 💰 **Cost Control** — Set a maximum API spend limit and a survey completion goal.

## Supported Apps

- **AttaPoll** (`com.requapp.requ`)
- **5Surveys** (`com.fivesurveys.mobile`)

## Requirements

- **Windows** (uses `.exe` paths for ADB and Frida)
- [scrcpy](https://github.com/Genymobile/scrcpy) (includes `adb.exe`)
- [Frida](https://frida.re/) + `frida-server` pushed to your device
- A rooted Android device (for Frida injection)
- An [Anthropic API key](https://console.anthropic.com/)
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

3. **Configure paths in `vite.config.ts`**

   Open `vite.config.ts` and update these two constants at the top to match your local setup:
   ```ts
   const ADB = 'C:\\path\\to\\scrcpy\\adb.exe';
   const FRIDA = 'C:\\path\\to\\frida.exe';
   ```

4. **Run the dev server**
   ```bash
   pnpm dev
   ```

5. **Open the app** at `http://localhost:8080` and fill in:
   - Your Anthropic API key
   - The path to your scrcpy folder
   - Choose your target survey app
   - Set a cost limit and survey goal

## How It Works

1. The agent launches the target app via ADB.
2. It dumps the UI XML to check whether a WebView is present.
3. **NATIVE mode**: Sends ADB tap commands based on UI element bounds.
4. **WEB mode**: Connects via CDP to the WebView and injects JavaScript.
5. Claude analyzes each screen and returns a structured action (tap, evaluate, wait, or done).
6. The loop continues until the survey goal is reached or the cost limit is hit.

## Security Notes

- Your Anthropic API key is stored in `localStorage` only — it is never committed to the repo.
- ADB and Frida paths are configured in `vite.config.ts` which you should keep out of public forks if your paths reveal sensitive info.
- This tool is intended for personal use on your own device.

## License

MIT